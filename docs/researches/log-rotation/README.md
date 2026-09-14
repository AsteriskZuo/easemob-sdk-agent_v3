# 日志轮转调研

本目录记录日志膨胀治理与轮转方案的调研结论。

文件：

- [`2026-07-22-log-rotation-research.md`](./2026-07-22-log-rotation-research.md)：零代码轮转方案对比（logrotate / newsyslog / Docker 日志驱动）、与 `JsonlLogger` 写入方式的兼容性确认、各部署场景推荐。
