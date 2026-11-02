import net from "node:net";

/** agent 服务端点（平台经 stdin 注入；token 为 per-run 一次性令牌，run 结束失效） */
export interface ServiceEndpoint {
  socket_path: string; // per-run unix socket 路径
  token: string; // per-run 一次性 token
}

/**
 * socket 契约 v2 升级内容（2026-11-01，spec：docs/specs/2026-11-01-business-multi-model-spec.md §5）：
 *  1. agent 请求新增可选字段 model（provider/id）：指定本次调用使用的模型，缺省 = 业务默认模型；
 *     不在本业务生效配置枚举内 → 服务端回 model_not_allowed；
 *  2. 新增 op "models"：查询本 run 生效配置的 provider/模型枚举（只含名字与 id，绝不含敏感字段）；
 *  3. 新增错误码：model_not_allowed、model_not_configured（业务未配置大模型）。
 *  协商规则：SDK 所有请求恒定发 "v2"；服务端同时接受 "v1"/"v2"；v1 请求携带 model → invalid_request。
 *  响应 envelope 形状不变，contract_version 恒为 "v1"（仅作 envelope 版本标识）。
 */

/** socket 请求（spec §5 唯一定义处）：一行一条 JSON（\n 结尾） */
export interface ServiceRequest {
  contract_version: "v2"; // 恒定 v2（见文件头升级说明）
  token: string; // per-run 一次性 token，run 结束失效
  op: "agent" | "compact" | "clear" | "models";
  skills?: string[]; // op='agent' 必填（可多个、可跨程序包；均须在本业务 skill 组内，服务端白名单校验，SKILL.md 经 --append-system-prompt 内联注入）
  input?: unknown; // op='agent' 必填
  mode?: "channel" | "fresh"; // op='agent' 可选，缺省 'channel'
  model?: string; // op='agent' 可选（provider/id；缺省 = 业务默认模型；白名单外 → model_not_allowed）
}

/** socket 响应（spec §5.4）：服务端回完即关连接 */
export type ServiceResponse =
  | { contract_version: "v1"; ok: true; output: unknown } // compact/clear 的 output 为 null
  | { contract_version: "v1"; ok: false; error: string }; // 配额超限、白名单拒绝、agent 异常等

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOkResponse(
  value: unknown,
): value is Extract<ServiceResponse, { ok: true }> {
  return (
    isPlainObject(value) &&
    value.contract_version === "v1" &&
    value.ok === true &&
    "output" in value
  );
}

function isErrResponse(
  value: unknown,
): value is Extract<ServiceResponse, { ok: false }> {
  return (
    isPlainObject(value) &&
    value.contract_version === "v1" &&
    value.ok === false &&
    typeof value.error === "string"
  );
}

/** unix socket 客户端：一次调用一条连接，发送一行 JSON 请求，读一行 JSON 响应（服务端回完即关）。
 *  连接失败 / 响应非法 / 响应 ok=false → reject（带 error） */
export function callService(
  endpoint: ServiceEndpoint,
  request: ServiceRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const conn = net.createConnection(endpoint.socket_path);

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(err);
    };

    conn.on("error", (err) => {
      fail(new Error(`agent 服务连接失败: ${err.message}`));
    });
    conn.on("connect", () => {
      conn.write(JSON.stringify(request) + "\n");
    });
    conn.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      settled = true;
      conn.end();
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, idx));
      } catch {
        reject(new Error("agent 服务响应非法：不是合法 JSON"));
        return;
      }
      if (isOkResponse(parsed)) {
        resolve(parsed.output);
      } else if (isErrResponse(parsed)) {
        reject(new Error(parsed.error));
      } else {
        reject(new Error("agent 服务响应非法：不符合 ServiceResponse 契约"));
      }
    });
    conn.on("close", () => {
      fail(new Error("agent 服务未返回响应即断开连接"));
    });
  });
}
