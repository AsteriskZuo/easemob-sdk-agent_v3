import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RunContext } from "@asteriskzuo/agent-run-core";

/**
 * 单字段差异。
 * 调用前提：`diffContexts` 会真实读取文件系统计算内容 digest，
 * 两侧上下文里的路径（program/programs/skills/pi_agent_dir）必须指向真实存在的资产；
 * 路径不存在不抛错，记为 different 且展示值注明 "missing"。
 */
export interface FieldDiff {
  /** 字段名，如 "program" / "programs.main" / "skills.review-guide" / "secrets.JIRA_PASSWORD" */
  field: string;
  /** 比较结论：相等 / 不等 / 仅平台有 / 仅本地有 */
  kind: "equal" | "different" | "platform_only" | "local_only";
  /** 平台侧展示值；secrets 一律 "***"；digest 类字段展示短哈希（前 12 位）；仅本地有时缺省 */
  platform?: string;
  /** 本地侧展示值；规则同 platform；仅平台有时缺省 */
  local?: string;
}

/** diff 结构化报告；退出码语义（全等 0 / 有差异 1 / 输入非法 2）由 cli 层实现。 */
export interface DiffReport {
  /** 全部字段相等 */
  equal: boolean;
  /** 逐字段报告，含相等的字段（调用方自行过滤展示） */
  fields: FieldDiff[];
}

/** digest 计算结果：ok = 内容 sha256；missing = 文件/目录不存在；no_models_json = 目录存在但缺 models.json。 */
type DigestResult =
  | { kind: "ok"; digest: string }
  | { kind: "missing" }
  | { kind: "no_models_json" };

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 单文件内容 sha256；文件不存在或非普通文件记 missing。 */
function fileDigest(filePath: string): DigestResult {
  try {
    if (!statSync(filePath).isFile()) return { kind: "missing" };
    return { kind: "ok", digest: sha256Hex(readFileSync(filePath)) };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * 目录内容 digest：递归收集全部文件的 (相对路径, 文件 sha256)，
 * 按相对路径排序后再取整体 sha256；目录不存在记 missing。
 */
function dirDigest(dirPath: string): DigestResult {
  try {
    if (!statSync(dirPath).isDirectory()) return { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push(full);
    }
  };
  walk(dirPath);
  const lines = files
    .map((f) => {
      const rel = path.relative(dirPath, f).split(path.sep).join("/");
      return `${rel}:${sha256Hex(readFileSync(f))}`;
    })
    .sort();
  return { kind: "ok", digest: sha256Hex(lines.join("\n")) };
}

/** pi_agent_dir 的 digest 取其内 models.json 的内容 sha256；目录存在但缺 models.json 记 no_models_json。 */
function modelsJsonDigest(piAgentDir: string): DigestResult {
  try {
    if (!statSync(piAgentDir).isDirectory()) return { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
  const modelsPath = path.join(piAgentDir, "models.json");
  try {
    if (!statSync(modelsPath).isFile()) return { kind: "no_models_json" };
    return { kind: "ok", digest: sha256Hex(readFileSync(modelsPath)) };
  } catch {
    return { kind: "no_models_json" };
  }
}

/** digest 展示值：短哈希（前 12 位）；missing / no_models_json 用文字注明。 */
function digestDisplay(result: DigestResult): string {
  switch (result.kind) {
    case "ok":
      return result.digest.slice(0, 12);
    case "missing":
      return "missing";
    case "no_models_json":
      return "missing models.json";
  }
}

/** digest 类字段比较：仅两侧都成功算出且 digest 相同才算相等。 */
function digestField(
  field: string,
  platform: DigestResult,
  local: DigestResult,
): FieldDiff {
  const equal =
    platform.kind === "ok" &&
    local.kind === "ok" &&
    platform.digest === local.digest;
  return {
    field,
    kind: equal ? "equal" : "different",
    platform: digestDisplay(platform),
    local: digestDisplay(local),
  };
}

/** 直比字符串字段。 */
function stringField(field: string, platform: string, local: string): FieldDiff {
  return {
    field,
    kind: platform === local ? "equal" : "different",
    platform,
    local,
  };
}

/** 直比数值字段。 */
function numberField(field: string, platform: number, local: number): FieldDiff {
  return {
    field,
    kind: platform === local ? "equal" : "different",
    platform: String(platform),
    local: String(local),
  };
}

/**
 * 上下文等值 diff（spec §7.2 内容 digest 方案，不做路径字符串比较）。
 *
 * 规范化规则：
 * - program / programs.*（文件）→ 文件内容 sha256；skills.*.path（目录）→ 目录递归 digest；
 *   pi_agent_dir → 其内 models.json 的 sha256（目录存在但缺 models.json 记 different 并注明）。
 * - skills 数组比较前按 name 排序；programs/skills/vars/secrets 的比较键 = 名，
 *   键集合不同或同值不同都算差异。
 * - secrets 只比较相等性，展示值恒 "***"。
 * - business_id / channel_id / prompt / model / vars / quota 直接比较值。
 * - 文件/目录不存在（如本地未构建）不抛错，记 different，展示值注明 "missing"。
 *
 * 调用前提：两侧上下文里的路径必须指向真实存在的资产才能算出 digest（本函数真实读文件系统）。
 */
export function diffContexts(platform: RunContext, local: RunContext): DiffReport {
  const fields: FieldDiff[] = [];

  fields.push(stringField("business_id", platform.business_id, local.business_id));
  fields.push(stringField("channel_id", platform.channel_id, local.channel_id));
  fields.push(stringField("prompt", platform.prompt, local.prompt));
  fields.push(stringField("model", platform.model, local.model));

  // program：主程序文件内容 digest
  fields.push(digestField("program", fileDigest(platform.program), fileDigest(local.program)));

  // programs.*：按程序名逐键比较，键集合取两侧并集
  const programNames = [
    ...new Set([...Object.keys(platform.programs), ...Object.keys(local.programs)]),
  ].sort();
  for (const name of programNames) {
    const field = `programs.${name}`;
    const pPath = platform.programs[name];
    const lPath = local.programs[name];
    if (pPath === undefined) {
      fields.push({ field, kind: "local_only", local: digestDisplay(fileDigest(lPath)) });
    } else if (lPath === undefined) {
      fields.push({ field, kind: "platform_only", platform: digestDisplay(fileDigest(pPath)) });
    } else {
      fields.push(digestField(field, fileDigest(pPath), fileDigest(lPath)));
    }
  }

  // skills.*：按技能名逐键比较（数组序无关），值为目录递归 digest
  const platformSkills = new Map(platform.skills.map((s) => [s.name, s.path]));
  const localSkills = new Map(local.skills.map((s) => [s.name, s.path]));
  const skillNames = [...new Set([...platformSkills.keys(), ...localSkills.keys()])].sort();
  for (const name of skillNames) {
    const field = `skills.${name}`;
    const pPath = platformSkills.get(name);
    const lPath = localSkills.get(name);
    if (pPath === undefined) {
      fields.push({ field, kind: "local_only", local: digestDisplay(dirDigest(lPath!)) });
    } else if (lPath === undefined) {
      fields.push({ field, kind: "platform_only", platform: digestDisplay(dirDigest(pPath)) });
    } else {
      fields.push(digestField(field, dirDigest(pPath), dirDigest(lPath)));
    }
  }

  // pi_agent_dir：可选字段；比较其内 models.json 的 digest
  if (platform.pi_agent_dir === undefined && local.pi_agent_dir === undefined) {
    fields.push({ field: "pi_agent_dir", kind: "equal" });
  } else if (platform.pi_agent_dir === undefined) {
    fields.push({
      field: "pi_agent_dir",
      kind: "local_only",
      local: digestDisplay(modelsJsonDigest(local.pi_agent_dir!)),
    });
  } else if (local.pi_agent_dir === undefined) {
    fields.push({
      field: "pi_agent_dir",
      kind: "platform_only",
      platform: digestDisplay(modelsJsonDigest(platform.pi_agent_dir)),
    });
  } else {
    fields.push(
      digestField(
        "pi_agent_dir",
        modelsJsonDigest(platform.pi_agent_dir),
        modelsJsonDigest(local.pi_agent_dir),
      ),
    );
  }

  // vars：逐键直比
  const varNames = [
    ...new Set([...Object.keys(platform.vars), ...Object.keys(local.vars)]),
  ].sort();
  for (const name of varNames) {
    const field = `vars.${name}`;
    const pValue = platform.vars[name];
    const lValue = local.vars[name];
    if (pValue === undefined) {
      fields.push({ field, kind: "local_only", local: lValue });
    } else if (lValue === undefined) {
      fields.push({ field, kind: "platform_only", platform: pValue });
    } else {
      fields.push(stringField(field, pValue, lValue));
    }
  }

  // secrets：只比较相等性，展示值恒 "***"
  const secretNames = [
    ...new Set([...Object.keys(platform.secrets), ...Object.keys(local.secrets)]),
  ].sort();
  for (const name of secretNames) {
    const field = `secrets.${name}`;
    const pValue = platform.secrets[name];
    const lValue = local.secrets[name];
    if (pValue === undefined) {
      fields.push({ field, kind: "local_only", local: "***" });
    } else if (lValue === undefined) {
      fields.push({ field, kind: "platform_only", platform: "***" });
    } else {
      fields.push({
        field,
        kind: pValue === lValue ? "equal" : "different",
        platform: "***",
        local: "***",
      });
    }
  }

  // quota：逐数值字段直比
  fields.push(
    numberField("quota.timeout_minutes", platform.quota.timeout_minutes, local.quota.timeout_minutes),
  );
  fields.push(
    numberField("quota.max_agent_calls", platform.quota.max_agent_calls, local.quota.max_agent_calls),
  );

  return { equal: fields.every((f) => f.kind === "equal"), fields };
}
