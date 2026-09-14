# 服务器 hostname 配置（mDNS 局域网解析）

本文记录 2026-09-09 为本项目部署服务器配置 hostname 的实践。目标是让局域网内用名字代替 IP 访问服务器，且 **访问方（Mac）零配置**。

- **服务器**：Ubuntu 24.04，内网 IP `10.202.3.38`，用户 `ubuntun`
- **hostname**：`jira-audit`（Jira 审查服务器；2026-09-10 由 `jira-ticket-review` 改名而来，服务器重装/重启后随之变更）
- **局域网访问名**：`jira-audit.local`（mDNS 固定带 `.local` 后缀）

## 1. 背景知识

"配置 hostname"本质是建立 **名字 → IP 的映射**。映射可以落在三处，效果范围不同：

| 方案 | 配置位置 | 生效范围 |
|---|---|---|
| `/etc/hosts` | 每台访问方机器 | 仅该机器 |
| 内部 DNS 服务器 | 运维管理的 DNS | 整个局域网（最正规） |
| **mDNS（本方案）** | 服务器自身广播 | 局域网内支持 mDNS 的设备 |

关键点：hostname 解析是在**访问方**侧完成的。只在服务器上 `hostnamectl set-hostname` 只是改了服务器的"自称"，其他机器并不知道。配合 mDNS（`avahi-daemon`）后，服务器主动向局域网广播自己的名字，Mac 原生支持（Bonjour），因此 Mac 上不需要改任何配置。

命名规则（RFC 1123）：仅小写字母、数字、连字符 `-`；连字符不开头结尾；**下划线不合法**（`ping`/`ssh` 或许能容忍，但 TLS 证书、部分语言的标准库会拒绝），故项目名 `easemob-sdk-agent_v2` 这类带 `_` 的名字需改写。连字符在 URL 和 HTTP `Host` 头中完全合法。

## 2. 服务器配置步骤（已执行，可复现）

以下命令在服务器上执行（或从 Mac 经 `ssh ubuntun@10.202.3.38 '<命令>'` 远程执行）：

```bash
# ① 设置 hostname（重启后保持）
sudo hostnamectl set-hostname jira-audit

# ② 更新服务器自身的 /etc/hosts，避免 sudo 报 "unable to resolve host"
#    已有 127.0.1.1 行则替换，没有则追加：
#    127.0.1.1	jira-audit

# ③ 安装并启动 mDNS 服务（设为开机自启）
sudo apt-get update -qq
sudo apt-get install -y avahi-daemon avahi-utils
sudo systemctl enable --now avahi-daemon
```

本机情况补充：防火墙 `ufw` 处于 inactive，无需放行规则；若开启 ufw，需放行 UDP 5353（`sudo ufw allow mdns`）。

## 3. 使用与验证

Mac（及局域网内 iPhone/Mac）上直接使用，**必须带 `.local` 后缀**：

```bash
ssh ubuntun@jira-audit.local
ping jira-audit.local                    # 应解析到 10.202.3.38
curl http://jira-audit.local:3000/       # HTTP 请求同理
```

服务器侧排查：

```bash
hostname                                         # 确认 hostname
systemctl is-active avahi-daemon                 # 应为 active
avahi-resolve -n jira-audit.local        # 服务器自测 mDNS 解析
```

Mac 侧排查：

```bash
dns-sd -B _services._dns-sd._udp local.          # 浏览局域网 mDNS 服务（Ctrl+C 退出）
ping jira-audit.local
```

## 4. 局限与备选

- **`.local` 后缀不可省略**。裸名 `jira-audit` 不走 mDNS，需访问方各自配 `/etc/hosts`（`10.202.3.38 jira-audit`）或由运维加内部 DNS 记录。
- **依赖局域网组播**：网络设备禁组播、跨网段访问时 `.local` 解析失败，只能用 IP 或 DNS 方案。
- **Windows/Linux 同事**：Windows 10 1803+ 和装了 avahi 的 Linux 一般支持 `.local`；老旧系统不支持。
- 服务器若改用 systemd-resolved 的 mDNS 或其他网络管理工具，注意与 avahi 的冲突（当前服务器无此问题）。

## 5. 变更方法

```bash
# 改名字（改完 avahi 广播的名字随之变化，无需重启 avahi）
sudo hostnamectl set-hostname <新名字>
sudo sed -i "s/^127.0.1.1.*/127.0.1.1\t<新名字>/" /etc/hosts

# IP 变了：无需任何操作，mDNS 广播的是当前地址；这正是名字方案相对写死 IP 的价值
```
