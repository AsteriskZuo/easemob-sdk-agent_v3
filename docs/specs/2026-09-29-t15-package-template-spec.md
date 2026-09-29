# T15 程序包模板 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；设计依据（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/package-model.md`（§6 清单契约、§8 包结构与工程模板）。
> 交付物：平台仓内 `templates/agent-package/`（**非 workspace**，拷贝即用）+ 验收脚本 `scripts/verify-template.sh`。

## 1. 目标

给程序包作者一个**拷贝即合格**的模板：内置与平台同构同版本的完整工具链（build/typecheck/lint/format/circular/test），作者只写 `src/` 业务代码与 `skills/` 能力单元，本地即可跑全检查，提交前即合格。

## 2. 背景知识（执行所需的最小上下文）

- **程序包是什么**：平台管理的**唯一资产单元**——一个 git 仓库或上传包，内含多个子程序（可执行入口）、多个 skill（给大模型的能力单元）、及包自己需要的其他资源。平台不认识包内容，只做三件事：登记（引用/上传母本 + 元数据）、清单机械校验（`agent-package.json`）、物化后吊起执行。
- **为什么是程序包而不是 skill**：完整业务链路（取数/脱敏/门禁/分支循环）不是一个 skill 能承载的——skill 只是"给大模型用的能力"；链路里只有推理一环需要大模型，其余都是机械环节，由"代码即流程"的流程程序承载。skill 没有消失，是归位为包内的一种内容。
- **一入一出契约四条**（模板骨架注释必须与之一致）：① stdin 一段 JSON 进（信封 + 平台注入上下文）；② stdout 一段 JSON 出（`sdk.return` / `sdk.fail`，只认第一次）；③ 失败语义机械（任何一步失败 = 整体失败，不重跑）；④ 日志走 `sdk.log`（stderr，平台采集、secrets 源头脱敏）。
- **平台注入什么**：运行时平台把 `@easemob/agent-sdk`（esbuild bundle）注入解析路径——业务零安装；入口信封/config/secrets/endpoint 经 stdin 注入。包内 node_modules 的 sdk 只服务开发期类型与测试。
- **模板的定位**：`design/package-model.md` §8 的物化——把作者指南落成文件。工具链与平台**同构同版本**：作者在本地跑绿的检查，就是平台要求的全套检查。
- **skill 注入**（作者需要理解的边界）：`sdk.agent({skills:[...]})` 按名引用（可多个、可跨绑定包），平台白名单校验后逐个 `--skill` 注入 pi；没有运行时注册接口。

### 2.1 消费的上游包（真实签名，以此为准）

`@easemob/agent-sdk`（导出单例对象 `sdk`；契约唯一定义处在 T10 spec §5.3）：

```ts
export const sdk: {
  input(): { event: unknown; workspace: string };                    // 读入口：信封 + 工作区
  runInput(): { input: unknown; config: Record<string, string> };    // 子程序侧读口
  config(): Record<string, string>;                                  // 控制台登记配置（非机密）
  secret(name: string): string;                                      // 安全变量；未注入 → 抛错
  agent(call: { skills: string[]; input: unknown; mode?: 'channel' | 'fresh' }): Promise<unknown>;
  session: { compact(): Promise<void>; clear(): Promise<void> };     // 通道会话操作
  run(program: string, args: { input: unknown; config?: Record<string, string>; timeout_ms?: number }): Promise<unknown>;
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, fields?: Record<string, unknown>): void;
  return(result: unknown): never;  // 唯一出口：成功（exit 0，只生效一次）
  fail(reason: string): never;     // 唯一出口：失败（exit 1）
};
```

## 3. 范围与不做清单

**本任务做**：模板全部文件（§4 清单）、验收脚本 `scripts/verify-template.sh`（§5）。

**本任务不做**：

- 不做模板版本化/升级机制（作者拷贝后自立门户）；
- 不把模板纳入根六连的 lint/circular（保持非 workspace 的拷贝即用纯粹性；prettier 覆盖足矣）；
- 不做多程序示例（一个 main 足矣，更多程序 = 作者自行在 programs 加条目）；
- 不动根 `package.json` 的 workspaces（维持 `packages/*` + `app/*`）。

## 4. 详细规格（模板文件清单与全文）

```
templates/agent-package/
├── README.md
├── agent-package.json
├── package.json
├── tsconfig.json
├── jest.config.mjs
├── eslint.config.js
├── .prettierignore
├── .gitignore
├── src/programs/main.ts
├── skills/example/SKILL.md
└── tests/main.test.ts
```

### 4.1 agent-package.json

```json
{
  "name": "my-package",
  "version": "0.1.0",
  "programs": {
    "main": "dist/programs/main.js"
  },
  "skills": ["skills/example"]
}
```

注释规则（写进 README）：programs 值 = 转译后的 JS 相对包根路径；skills 每条 = 包内 skill 目录；平台登记时机械校验每条路径真实存在。

### 4.2 package.json

```json
{
  "name": "my-package",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@easemob/agent-sdk": "^0.1.0"
  },
  "devDependencies": {
    "@jest/globals": "^29.7.0",
    "@types/jest": "^29.5.14",
    "@types/node": "^24.0.0",
    "dpdm": "^4.2.0",
    "esbuild": "^0.28.1",
    "eslint": "^10.7.0",
    "jest": "^29.7.0",
    "prettier": "^3.9.4",
    "typescript": "^5.9.0",
    "typescript-eslint": "^8.63.0"
  },
  "engines": { "node": ">= 24" },
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.json",
    "test": "npm run build && rm -rf dist-test && esbuild $(find src -name '*.ts') --outdir=dist-test/src --outbase=src --format=esm --platform=node --target=node24 --sourcemap --log-level=error && esbuild $(find tests -name '*.ts') --outdir=dist-test/tests --outbase=tests --format=esm --platform=node --target=node24 --sourcemap --log-level=error && NODE_OPTIONS='--experimental-vm-modules' jest --config jest.config.mjs --rootDir .",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "circular": "dpdm --circular --transform \"src/**/*.ts\""
  }
}
```

### 4.3 tsconfig.json（独立版，内容 = 平台 tsconfig.base.json 内联 + 本包设置）

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node", "jest"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "dist-test", "tests"]
}
```

### 4.4 jest.config.mjs

```js
export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/dist-test/tests/**/*.test.js"],
  clearMocks: true,
  watchman: false,
};
```

### 4.5 eslint.config.js（独立版：平台规则同构，files 指向本包）

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/dist-test/**", "**/coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
```

### 4.6 .prettierignore 与 .gitignore

`.prettierignore`：`node_modules`、`dist`、`dist-test`、`coverage`（每行一个）。
`.gitignore`：同上四行。

### 4.7 src/programs/main.ts（流程程序骨架，注释承载规则）

```ts
import { sdk } from "@easemob/agent-sdk";

// 流程程序骨架（单轮审查工单形态）：检查 → 取数/脱敏 → 大模型 → 还原/门禁 → 唯一出口。
// 约束四条：stdin 一段 JSON 进、stdout 一段 JSON 出（sdk.return/sdk.fail）、
// 失败语义机械（任何一步失败 = 整体失败）、日志走 sdk.log（stderr，平台采集）。
const { event } = sdk.input();
sdk.log("info", "run started");

// 1. 检查：输入不合规 = 直接失败（不扇出、下游不触发）
const payload = (event as { payload?: { text?: string } }).payload;
if (!payload?.text) {
  sdk.fail("检查未通过：缺少 payload.text");
}

// 2. 取数/脱敏：sdk.run('your-fetch', { input: ... }) —— 调本包或绑定包的其他子程序，按需启用
// 3. 大模型：skills 须在包清单 skills 内（可多个、可跨绑定包）；模型凭据平台持有
const answer = await sdk.agent({ skills: ["example"], input: payload.text });

// 4. 门禁：机械校验结果，不合格 = 失败（不重做）
if (typeof answer !== "string" || answer.length === 0) {
  sdk.fail("门禁未通过：结果为空");
}

// 5. 唯一出口：结果由平台扇出（下游关注 + 出口绑定投递），业务不做投递
sdk.return({ answer });
```

### 4.8 skills/example/SKILL.md

```md
---
name: example
description: 示例 skill——演示 frontmatter 与正文的最低形态；替换为你自己的能力单元
---

# Example Skill

这里写给大模型的规则与边界：要做什么、不做什么、输出格式要求。
skill 是程序包内"给大模型用的能力"，遵循公开 SKILL.md 规范，不为平台做适配。
```

### 4.9 tests/main.test.ts（e2e 失败路径两则，验证一入一出契约）

```ts
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["dist/programs/main.js"], {
      input: stdin,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout };
  }
}

describe("main 程序契约", () => {
  it("检查未通过 → stdout ok:false + exit 1（reason 含原因）", () => {
    const r = run(JSON.stringify({ contract_version: "v1", input: { payload: {} }, workspace: "." }));
    expect(r.code).toBe(1);
    const result = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("检查未通过");
  });

  it("无注入输入（空 stdin）→ 非零退出", () => {
    const r = run("");
    expect(r.code).not.toBe(0);
  });
});
```

### 4.10 README.md（章节提纲，执行者成文）

1. 这是什么：程序包模板——平台管理的资产单元（子程序 + skill 的载体），拷贝即用；
2. 快速开始：拷贝目录 → 改 `agent-package.json` 与 `package.json` 的 name → 安装依赖（平台未发布 npm 前，把 `@easemob/agent-sdk` 改为 `file:<平台仓>/packages/sdk`）→ 写 `src/` 与 `skills/` → `npm run build/test/typecheck/lint/format:check/circular` 全绿 → 推送 git → 控制台登记绑定；
3. 运行时说明：平台注入 sdk（开发期依赖只为类型与测试）、stdin/stdout 契约四条、skills 白名单与 `--skill` 注入、业务日志走 `sdk.log`；
4. 目录说明：每个文件一句话。

## 5. 验收脚本 `scripts/verify-template.sh`

平台仓根目录新增，可重复执行：

```bash
#!/usr/bin/env bash
# 模板验收：拷贝到临时目录 → sdk 依赖改 file: → 安装 → 六条检查
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$ROOT/templates/agent-package/." "$TMP/"
cd "$TMP"
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  p.dependencies["@easemob/agent-sdk"] = "file:" + process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
' "$ROOT/packages/sdk"
npm install --no-audit --no-fund
npm run build && npm run typecheck && npm run lint && npm run format:check && npm run circular && npm test
echo "模板验收通过"
```

## 6. 测试清单

模板自身的测试即 §4.9（随模板交付，在模板工程内运行）。平台侧的验收测试 = §5 脚本（非 jest 用例，不进根 `yarn test`）：

1. `bash scripts/verify-template.sh` 全绿（模板六条命令全过）；
2. 模板内无指向平台仓的相对路径：`grep -r '\.\./\.\.' templates/` 为空；
3. workspaces 不含模板：`yarn workspaces list` 无 my-package。

## 7. 验收标准

1. §6 三条全过；根级六连全绿（模板被 prettier 覆盖，`yarn format:check` 含模板文件）；
2. 文件清单与 §4 全文逐字一致；
3. `templates/agent-package/README.md` 四章齐全。

## 8. 本规格的决策点（已定）

1. **非 workspace**：模板不是平台 monorepo 的包；根六连中只有 prettier 覆盖模板（eslint/dpdm 的 files 限定 packages/app）——模板文件必须 prettier 合格。
2. **独立可运行**：拷贝出平台仓后自成工程——自带 tsconfig（不 extends 平台 base）、jest.config.mjs、eslint.config.js，不引用平台仓相对路径。
3. **sdk 依赖**：`dependencies: { "@easemob/agent-sdk": "^0.1.0" }`；平台发布 npm 前，本地开发/验收改为 `file:` 指向平台仓 `packages/sdk`（README 写明，验收脚本自动做）。运行时平台注入同名模块（esbuild bundle），包内 node_modules 的 sdk 只服务开发期类型与测试。
4. **脚本与平台同构**：devDeps 版本对齐根 package.json。唯一有意的偏差：test 脚本内用 `npm run build`（不用 `yarn run build`）——包管理器中立，作者用 npm/yarn/pnpm 均可。
5. **不写 packageManager 字段、不带 lock 文件**：作者环境自择包管理器。
6. **内容即文档**：骨架代码用注释承载规则（约束四条、skills 白名单、唯一出口），注释措辞必须与 package-model.md 一致。
