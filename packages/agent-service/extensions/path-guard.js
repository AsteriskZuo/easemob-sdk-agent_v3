// 平台路径守卫 extension：仅在业务清单声明 pi_tools（--tools read,grep,glob）时由平台装配统一 -e 注入
// （--no-extensions 白名单纪律），业务不可摘除；不设开关、不读 env。
// 背景：pi 的 read/grep/glob 工具没有工作区围栏——绝对路径与 ../ 穿越均可读到工作区外文件（已实证）。
// 本守卫挂在 tool_call 事件上逐调用检查 event.input.path：resolve 后必须位于 pi 子进程 cwd（= run workspace）之内。
// fail-closed：非白名单工具 / 缺 path / path 非字符串 / 判定自身异常 → 一律 block，宁可误拦不放行。
// plain JS、不经构建（pi 经 jiti 直接加载）。
import { resolve, sep } from "node:path";

// 守卫覆盖的 pi 内置工具（与平台白名单枚举一致，v1 仅只读三件套）
const GUARDED_TOOLS = new Set(["read", "grep", "glob"]);

export default function pathGuard(pi) {
  pi.on("tool_call", (event) => {
    try {
      const toolName = event && event.toolName;
      // 白名单外工具：正常不会出现（未开放），出现即视为异常 → block
      if (!GUARDED_TOOLS.has(toolName)) {
        return {
          block: true,
          reason: `path-guard: 非白名单工具: ${String(toolName)}`,
        };
      }
      const input = event && event.input;
      const target =
        input && typeof input === "object" ? input.path : undefined;
      // 缺 path / 非字符串 → block（fail-closed；grep 的 path 本就是可选参数，缺省即搜 cwd，
      // 但守卫口径保守：判定不了就不放行，模型改带工作区内 path 重试即可恢复）
      if (typeof target !== "string") {
        return { block: true, reason: "path-guard: 缺少 path 参数" };
      }
      // 前缀判定：resolve 后必须等于 cwd 或位于 cwd 之下（cwd + sep 防 /ws-evil 前缀撞车）
      const cwd = process.cwd();
      const resolved = resolve(cwd, target);
      if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
        return {
          block: true,
          reason: `path-guard: 路径越出工作区: ${target}`,
        };
      }
      // 工作区内：不返回结果（放行）
    } catch {
      // 判定逻辑自身抛异常 → block（fail-closed，不依赖 pi 对 handler 抛错的语义）
      return { block: true, reason: "path-guard: 判定异常，拒绝放行" };
    }
  });
}
