# Portainer 使用说明（Docker 容器管理面板）

部署服务器上运行了 Portainer CE，用于通过浏览器查看和管理 Docker 容器。本文记录访问方式和常用操作，供日常运维查阅。

- **服务器**：`jira-audit.local`（内网 IP `10.202.3.38`，hostname 见 `2026-09-09-server-hostname-mdns.md`）
- **容器**：`portainer`（镜像 `portainer/portainer-ce:lts`）

## 1. 访问地址

**https://jira-audit.local:9443**（等价于 `https://10.202.3.38:9443`）

注意事项：

- **必须用 `https://`**。9443 是 Portainer 的 HTTPS 端口，使用自签名证书，浏览器会提示"不安全/证书不受信任"，选择继续访问即可。
- 容器的 9000 端口（HTTP 入口）**没有映射到宿主机**，外部无法通过 `http://...:9000` 访问，统一走 9443。

## 2. 登录

- 首次使用：打开页面后按提示设置管理员账号密码。
- 已设置过：直接用管理员账号登录。密码由设置人保管；如果忘记，需在服务器上重置（见第 4 节）。

## 3. 常用操作

| 需求 | 入口 |
|---|---|
| 查看容器运行状态 | Containers 列表（Status 列） |
| 查看容器日志 | 容器详情页 → Logs |
| 重启/停止/启动容器 | Containers 列表 → 勾选容器 → 顶部操作按钮 |
| 查看镜像 | Images 列表 |
| 进入容器终端 | 容器详情页 → Console |

## 4. 服务器侧排查

面板打不开时，先确认容器还活着：

```bash
ssh ubuntun@jira-audit.local 'docker ps --filter name=portainer'
# 没起来就启动
ssh ubuntun@jira-audit.local 'docker start portainer'
```

忘记管理员密码时，按 Portainer 官方方式重置（需要重启容器并挂载 helper 镜像），参考官方文档的 reset-admin-password 流程，此处不展开。

## 5. 变更方法

```bash
# 升级镜像
ssh ubuntun@jira-audit.local 'docker pull portainer/portainer-ce:lts && \
  docker stop portainer && docker rm portainer && \
  docker run -d -p 9443:9443 --name portainer --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v portainer_data:/data \
    portainer/portainer-ce:lts'
```

注意：升级时必须挂载原 `portainer_data` 数据卷，否则管理员账号和配置会丢失。
