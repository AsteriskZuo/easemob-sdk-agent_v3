# Cloudflare Tunnel 调研

本目录记录 Cloudflare Tunnel 作为 NAT 穿透工具的调研与实际验证结果。

## 背景

在家办公场景下，本机通过家庭路由器访问外网（NAT 环境），本机运行的服务无法被外部服务直接访问。需要 NAT 穿透工具将本机服务暴露到公网。

## 文件

- [`2026-07-31-cloudflare-tunnel-research.md`](./2026-07-31-cloudflare-tunnel-research.md)：Cloudflare Tunnel 功能概述、两种使用模式、实际验证过程与结果、关键发现和注意事项。

## 结论

Cloudflare Tunnel Quick Tunnel 模式可以解决家庭网络 NAT 穿透问题。本项目网络环境下 QUIC(UDP) 被运营商封锁，必须使用 `--protocol http2` 强制 TCP 连接。

```bash
# Quick Tunnel 一行命令（必须加 --protocol http2）
cloudflared tunnel --protocol http2 --url http://localhost:3000
```

公网地址格式为 `https://<random-words>.trycloudflare.com`，自动 HTTPS，免注册免域名。
