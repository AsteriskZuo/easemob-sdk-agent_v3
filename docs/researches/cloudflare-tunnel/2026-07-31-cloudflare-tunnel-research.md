# Cloudflare Tunnel 调研与验证

> 调研日期：2026-07-31
> 场景：家庭网络 NAT 穿透，将本机服务暴露到公网供外部访问

## 1. 问题

在家办公场景下，本机通过家庭路由器访问外网（NAT 环境），路由器分配的内网 IP 无法被外部服务直接访问。本机 Docker 中运行的服务（端口 3000）需要被外部服务访问，因此需要 NAT 穿透工具。

## 2. Cloudflare Tunnel 是什么

Cloudflare Tunnel（原 Argo Tunnel）是 Cloudflare 提供的反向隧道服务。本机运行 `cloudflared` 客户端，主动建立到 Cloudflare 边缘节点的出站连接，外部请求通过 Cloudflare 网络转发到本机。

核心特点：

- **出站连接**：不需要在路由器上做端口转发或 DDNS，只需本机能访问外网即可
- **自动 HTTPS**：Cloudflare 自动处理 TLS 证书，本机服务跑 HTTP 即可
- **免费**：Quick Tunnel 模式完全免费，Full Tunnel 模式也只需免费 Cloudflare 账号

## 3. 两种使用模式

### 3.1 Quick Tunnel（快速隧道）

- 免注册、免域名、一行命令
- 生成随机 `trycloudflare.com` 子域名
- 适合临时演示、调试 webhook、给同事看 demo
- 关闭终端即断开，每次重启域名变化

### 3.2 Full Tunnel（完整隧道）

- 需注册 Cloudflare 账号 + 绑定自有域名
- 固定公网域名（如 `app.yourdomain.com`）
- 支持多服务映射、访问认证（Zero Trust Access）
- 适合长期稳定使用和生产环境

## 4. 实际验证

### 4.1 环境信息

| 项目 | 信息 |
|------|------|
| 操作系统 | macOS (Apple Silicon arm64) |
| 本机内网 IP | 192.168.3.102 |
| 本机服务 | Docker 容器 `easemob-sdk-agent`，端口 3000 |
| cloudflared 版本 | 2026.7.2 (Homebrew 安装) |
| 接入节点 | Cloudflare LAX (洛杉矶) |

### 4.2 安装

```bash
HOMEBREW_NO_AUTO_UPDATE=1 brew install cloudflared
```

### 4.3 启动 Quick Tunnel

```bash
cloudflared tunnel --protocol http2 --url http://localhost:3000
```

> **必须加 `--protocol http2`**，原因见下节。

### 4.4 网络环境关键发现

cloudflared 启动后自动执行连通性检测，结果如下：

| 检测项 | region1.v2.argotunnel.com | region2.v2.argotunnel.com |
|--------|---------------------------|---------------------------|
| DNS 解析 | PASS | PASS |
| UDP (QUIC) 连接 | **FAIL** | **FAIL** |
| TCP (HTTP/2) 连接 | PASS | **FAIL** |
| Cloudflare API | PASS | — |

**QUIC (UDP) 被运营商封锁**，cloudflared 默认使用 QUIC 协议，不加 `--protocol http2` 时无法建立隧道连接。

`--protocol http2` 强制使用 HTTP/2 over TCP，通过 region1 节点成功建立连接。

### 4.5 验证结果

隧道启动后，通过公网 URL 访问本地服务的对比：

| 对比项 | 本地 localhost:3000 | 公网 Tunnel URL |
|--------|---------------------|-----------------|
| HTTP 状态码 | 404 Not Found | 404 (HTTP/2) |
| 响应来源 | 本地服务直接返回 | `cf-ray` + `server: cloudflare` |
| 响应时间 | ~0.02s | ~1.5-2s |

两者返回一致的 404（服务根路径无路由），证明公网请求已成功穿透到本机服务。

Tunnel metrics 确认：2 个请求成功代理，0 错误。

**验证结论：Cloudflare Tunnel Quick Tunnel 模式在本网络环境下可正常工作，NAT 穿透成功。**

## 5. 使用方式

### 5.1 Quick Tunnel（当前采用）

```bash
# 启动隧道（必须加 --protocol http2）
cloudflared tunnel --protocol http2 --url http://localhost:3000
```

启动后终端会输出公网地址：

```
Your quick Tunnel has been created! Visit it at:
https://<random-words>.trycloudflare.com
```

### 5.2 Full Tunnel（如需固定域名）

前提条件：Cloudflare 账号 + 域名 DNS 托管在 Cloudflare。

```bash
# 1. 登录认证（会打开浏览器）
cloudflared tunnel login

# 2. 创建隧道
cloudflared tunnel create my-tunnel

# 3. 创建配置文件 ~/.cloudflared/config.yml
# tunnel: <tunnel-id>
# credentials-file: ~/.cloudflared/<tunnel-id>.json
# protocol: http2
# ingress:
#   - hostname: app.example.com
#     service: http://localhost:3000
#   - service: http_status:404

# 4. 配置 DNS 路由
cloudflared tunnel route dns my-tunnel app.example.com

# 5. 启动隧道
cloudflared tunnel run my-tunnel
```

### 5.3 Docker 部署（Full Tunnel）

```bash
docker run -d \
  --name cf-tunnel \
  --restart unless-stopped \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate --protocol http2 run --token <YOUR_TOKEN>
```

## 6. 注意事项

1. **必须使用 `--protocol http2`**：本网络环境 QUIC(UDP) 被封锁，不加此参数隧道无法建立
2. **Quick Tunnel 域名随机**：每次重启 cloudflared 都会生成新的 `trycloudflare.com` 子域名
3. **终端不能关**：关闭终端 = 隧道断开，外部无法访问
4. **接入点在海外**：连接到 LAX (洛杉矶) 节点，国内访问可能有延迟（1-2s）
5. **并发限制**：Quick Tunnel 约有 200 个在途请求限制，超出返回 429
6. **不适合生产环境**：Quick Tunnel 无 uptime 保证，生产环境应使用 Full Tunnel
7. **config.yml 必须有 catch-all 规则**：Full Tunnel 的配置文件最后一条必须是 `service: http_status:404`

## 7. 参考链接

- 官方文档：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Quick Tunnel 文档：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- cloudflared GitHub：https://github.com/cloudflare/cloudflared
