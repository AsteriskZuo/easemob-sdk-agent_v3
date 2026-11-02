# packages/ —— 库代码目录

不可直接执行的库代码放这里（类型、helper、业务实现模块）。`apps/` 里的程序保持薄壳：
读输入 → 调这里的实现 → 汇报结果。哪一块长大了，实现代码下沉到 `packages/`，程序壳不变。

通用契约校验器由 `@asteriskzuo/agent-sdk` 提供（`loadContract` / `checkFields`），本目录无需自建。
