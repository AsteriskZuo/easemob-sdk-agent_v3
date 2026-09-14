# Docker 调研

本目录记录多业务场景 Task Runner 的 Docker 运行环境调研。

文件：

- [`2026-07-11-docker-runtime-image-config-storage-research.md`](./2026-07-11-docker-runtime-image-config-storage-research.md)：镜像选择、配置注入、密钥处理、持久化存储和第一版推荐。
- [`Dockerfile.runtime.example`](./Dockerfile.runtime.example)：第一版运行镜像参考，不是已定稿生产 Dockerfile。
- [`compose.runtime.example.yaml`](./compose.runtime.example.yaml)：配置文件、secrets、volume 挂载参考，不包含真实密钥。
- [`dockerignore.example`](./dockerignore.example)：正式落地 Dockerfile 时建议同步添加到仓库根目录的忽略规则参考。
- [`config.example.json`](./config.example.json)：业务聚合配置文件示例，只用于说明结构。

当前推荐：

```text
node:24-bookworm-slim 或 node:22-bookworm-slim
+ 自定义运行镜像安装少量必需系统工具
+ config.json 只读挂载
+ Docker Compose secrets 注入敏感值
+ 独立挂载 app data / CODEX_HOME / workspaces
```

第一版不要把真实配置、Codex auth、Jira token、企业微信 secret、GitHub token 烘进镜像，也不要提交到 git。
