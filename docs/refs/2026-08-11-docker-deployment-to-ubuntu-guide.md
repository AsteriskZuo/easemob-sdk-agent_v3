# Docker 镜像部署到远端 Ubuntu 服务器指南

本文整理自 2026-08-11 的部署实践与教学，覆盖从 SSH 连接到容器运维的完整流程。以本项目（easemob-sdk-agent）部署到内网 Ubuntu 24.04 服务器（x86_64）为例，所有命令可直接复用；换项目、换服务器时流程不变，只需替换具体值。

涉及的三台"角色"：

- **本地 Mac**（Apple Silicon，arm64）：开发机 + 镜像构建机
- **远端服务器**：Ubuntu 24.04，amd64，内网 IP `10.202.3.56`，用户 `ubuntun`
- **Docker Hub**：镜像中转站（registry），账号 `asteriskzuo`

整体链路：

```
Mac 构建(amd64) --push--> Docker Hub --pull--> Ubuntu 服务器 docker run
```

---

## 1. SSH 建立连接

SSH 是本地与服务器之间的加密通道：本地跑客户端（macOS 自带），服务器跑服务端 `sshd`（Ubuntu 默认装好，监听 22 端口）。

```bash
ssh ubuntun@10.202.3.56
```

- 首次连接会提示确认服务器 host key 指纹，输入 `yes`。指纹记入本地 `~/.ssh/known_hosts`，之后不再询问；若某天突然再次询问，警惕服务器重装或中间人攻击。
- 输入密码时终端无任何回显，属正常。
- `exit` 退出登录。
- 连不上时加 `-v` 看详细过程：`ssh -v ubuntun@10.202.3.56`。

常见报错：

| 报错 | 含义 |
|---|---|
| `Connection timed out` | 网络不通，多为安全组未放行 22 端口或 IP 错误 |
| `Connection refused` | 网络通但 22 端口无服务监听 |
| `Permission denied` | 用户名或密码错误 |

**判断自己"站在哪边"**：看提示符。`asterisk@AsteriskMacBookPro` 是本地；`ubuntun@ubuntu-2404` 是服务器内。凡是 `ssh`、`scp` 这类"主动连别人"的命令，都在发起方（本地）执行。

## 2. 免密登录（SSH 密钥对）

原理：非对称加密。**私钥留在本地（`~/.ssh/id_ed25519`），公钥放上服务器（`~/.ssh/authorized_keys`）**。登录时服务器用公钥出题、客户端用私钥解题，密码不参与、不在网络传输。

```bash
# ① 查看现有密钥（有 id_ed25519/id_ed25519.pub 一对则跳过生成）
ls -l ~/.ssh/

# ② 生成密钥对（ed25519 为现代算法；passphrase 可留空）
ssh-keygen -t ed25519 -C "asterisk@macbook"

# ③ 把公钥安装到服务器（macOS 无 ssh-copy-id，用等价命令；最后一次输密码）
cat ~/.ssh/id_ed25519.pub | ssh ubuntun@10.202.3.56 \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# ④ 验证：不再询问密码
ssh ubuntun@10.202.3.56
```

要点：

- `authorized_keys` 是服务器的"信任名单"，每行一把公钥。必须用 `>>` 追加而非 `>` 覆盖，否则会清掉已有的其他公钥（重复执行会产生重复行，无害但可用 `nano` 删除）。
- 权限不对 sshd 会拒绝使用密钥：`.ssh` 目录 `700`，`authorized_keys` `600`。
- 排查钥匙被拒：`ssh -v` 日志中每把钥匙出现 `Offering public key` 后紧跟 `Authentications that can continue` 即"服务器不认"。常见原因：用户名错、公钥未装入该用户的 `authorized_keys`。对比服务器 `cat ~/.ssh/authorized_keys` 与本地 `cat ~/.ssh/id_ed25519.pub`。
- 可选别名：编辑本地 `~/.ssh/config`，写入 `Host myserver` / `HostName` / `User` / `IdentityFile`，之后 `ssh myserver` 即可。

## 3. 服务器安装 Docker

Docker 架构：`docker` 命令是客户端，真正干活的是 root 身份运行的守护进程 `dockerd`，两者经 `/var/run/docker.sock` 通信。普通用户需加入 `docker` 用户组才能免 sudo 访问该 sock。

第三方软件源的通用四步：导入 GPG 公钥 → 写软件源地址 → `apt update` → `apt install`。

```bash
# ① 前置工具
sudo apt-get update && sudo apt-get install -y ca-certificates curl

# ② 导入 Docker 官方 GPG 公钥
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# ③ 添加软件源（单行，避免 \ 续行粘贴截断导致 Malformed entry）
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list

# ④ 安装（含 buildx、compose 插件）
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# ⑤ 免 sudo（用户组变更需重新登录生效）
sudo usermod -aG docker $USER
exit
ssh ubuntun@10.202.3.56

# ⑥ 验证：Client/Server 两段都在；hello-world 走通 拉取→创建→运行→退出 全流程
docker version
docker run hello-world
```

踩过的坑：多行命令用 `\` 续行粘贴进终端易被截断，写出的 `docker.list` 断行导致 `Malformed entry ... (Suite)`。教训：粘贴多行命令出问题时先 `cat` 检查实际写入的内容。

## 4. 构建与传输镜像

### 4.1 架构匹配（关键前提）

容器镜像都是 Linux 镜像，真正要匹配的是 **CPU 架构**。Dockerfile 未指定 `--platform` 时，产物架构 = 构建机架构。本项目：Mac 是 arm64，服务器是 amd64（`uname -m` / 登录横幅 / `docker version` 的 `OS/Arch` 均可确认），直接 `docker build` 出的 arm64 镜像在服务器上会报 `exec format error`。解决：构建时用 `--platform linux/amd64`（QEMU 模拟构建，较慢，10~30 分钟）。

### 4.2 镜像命名与标签

- 镜像身份 = `名字:标签`。标签默认 `latest`，但 `latest` 无"自动最新"语义，重复构建会抢占标签、旧镜像变 `<none>` 孤儿。
- 部署用显式版本号（与 `package.json` 同步），服务器上多版本共存，出问题换回旧标签即秒级回滚。
- 平台信息放标签而非名字（如 `:0.0.1-amd64`）；名字里写 `-linux` 名不副实（arm64 镜像也是 Linux）。

### 4.3 多架构与 buildx 出口

- `buildx build` 必须有输出出口：`--load`（进本地镜像库，限单架构）、`--push`（推 registry，支持多架构）、都不加（只进构建缓存，无法使用）。
- 多架构镜像（manifest list：一个标签下按架构分发的目录表）只能存于 registry，必须 `--push`；仓库体积约翻倍，但各机器只拉自己架构的那份。
- `docker` driver（默认）不支持多架构构建；需要 `docker buildx create --driver docker-container` 创建的构建器。
- `--push` 的标签必须带账号前缀（`asteriskzuo/...`），否则会推向无权限的官方 `library/` 命名空间。

### 4.4 本项目实际流程（registry 方案）

```bash
# Mac 本地：构建 amd64 并推送（先在 hub.docker.com 网页手动建 Private 仓库，避免默认公开）
docker login
docker buildx build --platform linux/amd64 -t asteriskzuo/easemob-sdk-agent:0.0.1 --push .

# 服务器：拉取并把关架构
docker login   # 私有仓库需要；建议用网页生成的 Access Token 代替密码
docker pull asteriskzuo/easemob-sdk-agent:0.0.1
docker image inspect asteriskzuo/easemob-sdk-agent:0.0.1 --format '{{.Os}}/{{.Architecture}}'
```

无 registry 的替代方案（内网直传）：`docker save <镜像> | ssh ubuntun@10.202.3.56 "docker load"`。

## 5. 准备配置与数据

核心分工：**镜像装代码和依赖，挂载装配置和数据**。API Key 等敏感信息打进镜像会永久留在镜像层里且换配置要重建，故运行时 `-v` 挂载。

```bash
# Mac 本地：远程建目录（ssh 后直接跟命令可非交互执行）；scp 传配置文件
ssh ubuntun@10.202.3.56 "mkdir -p ~/easemob-agent/data"
scp .easemob-agent/config.docker.json ubuntun@10.202.3.56:~/easemob-agent/config.json

# Mac 本地：迁移历史状态（先停本地容器，避免拷到写了一半的文件）
docker stop easemob-sdk-agent
scp /Users/asterisk/tmp/easemob-sdk-agent/data/*.json ubuntun@10.202.3.56:~/easemob-agent/data/

# 服务器：配置含密钥，收紧权限
chmod 600 ~/easemob-agent/config.json
```

本项目容器内固定读 `/etc/easemob-sdk-agent/config.json`（镜像 `ENV APP_CONFIG_FILE` 指定），必备 key：模型三要素（`MODEL__API_KEY` / `MODEL__BASE_URL` / `MODEL__DEFAULT_MODEL`）、`APP__DATA_DIR`（容器内路径 `/app/.easemob-agent/data`）、Jira 访问配置，详见 `docs/configuration.md`。

权限知识点：bind mount 看 **uid 数字**不看用户名。容器内 `node` 用户 uid 1000，宿主机 `ubuntun` 也是 uid 1000，故互相可读写。

## 6. 启动容器

```bash
docker run -d \
  --name easemob-sdk-agent \
  --restart unless-stopped \
  --security-opt seccomp=unconfined \
  -p 3000:3000 \
  -v /home/ubuntun/easemob-agent/config.json:/etc/easemob-sdk-agent/config.json:ro \
  -v /home/ubuntun/easemob-agent/data:/app/.easemob-agent/data \
  asteriskzuo/easemob-sdk-agent:0.0.1
```

参数说明：

- `-d` 后台运行；`--name` 容器名（容器名须唯一，冲突时先 `docker rm` 旧的）。
- `--restart unless-stopped`：崩溃/服务器重启自动拉起，手动 stop 除外——生产标配。
- `--security-opt seccomp=unconfined`：codex CLI 所需系统调用权限。
- `-p 宿主机端口:容器端口`：本项目 `forwarded` 触发模式需接收 HTTP 推送，映射 3000；`polling` 模式无需映射。
- `-v 宿主机路径:容器路径:ro`：配置文件只读挂载；数据目录可读写，状态持久化在宿主机。

验证三连：

```bash
docker ps                          # STATUS 列 Up X minutes
docker logs easemob-sdk-agent      # 启动日志
curl -i http://127.0.0.1:3000/     # 404 也是成功：说明端口有人听（/ 未注册路由）
```

健康启动日志的标志：`codeproxy ready after Xs`（之前有一行上游 200 响应，说明模型三要素全对）→ `Starting main application...` → 企微 `Authentication successful`。

失败速查：

- `docker ps` 无容器 → `docker ps -a` 找退出容器，`docker logs` 看死因（多为配置缺 key，entrypoint 会报 `ERROR: xxx is missing`）。
- `ERROR: codeproxy failed to start within 30s` → 模型 API 配置错误或不通。
- 日志正常但 `curl` 不通（`Connection refused`）→ 端口映射/防火墙问题。

## 7. 日常运维与排查

```bash
# 状态
docker ps / docker ps -a
docker stats easemob-sdk-agent          # 实时资源占用

# 日志（排查第一入口；应用级日志文件的查看方法见第 8 章）
docker logs -f --tail 100 easemob-sdk-agent
docker logs --since 10m easemob-sdk-agent

# 生命周期（改配置后 restart 生效）
docker restart / stop / start easemob-sdk-agent

# 进容器排查（exit 退出不影响运行）
docker exec -it easemob-sdk-agent bash
```

发新版流程（0.0.1 → 0.0.2）：

```bash
# Mac：构建推送新标签
docker buildx build --platform linux/amd64 -t asteriskzuo/easemob-sdk-agent:0.0.2 --push .

# 服务器：拉新版 → 停删旧容器 → 同参数 run 新标签（数据在挂载目录，删容器不丢数据）
docker pull asteriskzuo/easemob-sdk-agent:0.0.2
docker stop easemob-sdk-agent && docker rm easemob-sdk-agent
docker run -d --name easemob-sdk-agent ... asteriskzuo/easemob-sdk-agent:0.0.2
# 回滚：run 命令换回 0.0.1 即可
```

## 8. 查看应用日志文件

应用日志写在宿主机 `~/easemob-agent/data/logs/`，与 `docker logs`（进程 stdout：启动信息、崩溃栈）互补——业务运行明细都在这里。目录结构：一个全局日志 `_global.log`（所有事件汇总）+ 每个工单的独立会话日志 `jira_forwarded__issue__HIM-xxxxx.log`。

四件武器：

```bash
# ① ls -lt：看有哪些文件、谁最新（最新的在最上面）
ls -lt ~/easemob-agent/data/logs/ | head -20

# ② tail：看末尾 + 实时跟踪（排查头号动作：一个窗口跟日志，另一个窗口触发操作）
tail -n 50 ~/easemob-agent/data/logs/_global.log
tail -f ~/easemob-agent/data/logs/_global.log          # Ctrl+C 退出

# ③ less：翻页细看大文件（别用 cat，一刷屏全滚过去）
less ~/easemob-agent/data/logs/jira_forwarded__issue__HIM-23157.log
#    操作：空格 下一页 / b 上一页 / /关键词 搜索 / n 下一个匹配 / G 到末尾 / q 退出

# ④ grep：捞关键信息
grep -E 'ERROR|WARN' ~/easemob-agent/data/logs/_global.log     # 错误和警告
grep -r "HIM-23157" ~/easemob-agent/data/logs/                  # 某工单在所有日志里的痕迹
grep -C 3 'ERROR' ~/easemob-agent/data/logs/_global.log         # 错误连同前后 3 行上下文
```

组合拳示例——"某工单审查为什么失败了"的排查路径：

```bash
# ① 全局日志里找这个工单的错误
grep "HIM-23157" ~/easemob-agent/data/logs/_global.log | grep ERROR
# ② 打开该工单的专属日志细查
less ~/easemob-agent/data/logs/jira_forwarded__issue__HIM-23157.log
# ③ 想盯着它重审一次：实时跟踪
tail -f ~/easemob-agent/data/logs/jira_forwarded__issue__HIM-23157.log
```

## 9. 服务器用户密码管理

```bash
passwd                  # 改当前用户密码：先验证旧密码，再输入两遍新密码（无回显）
sudo passwd ubuntun     # 忘记旧密码时用 sudo 直接重置
```

改密码不影响密钥免密登录（两套独立机制），影响的是 `sudo` 和密码登录这条后路。注意区分三个"密码"：服务器用户密码、SSH 私钥 passphrase、Docker Hub 密码/Token。
