# SMTP 邮件发送技术可行性调研

调研日期：2026-07-30（2026-07-30 完成端到端真实验证）
调研目的：为 `docs/specs/2026-07-30-health-check.md`（定时健康自检，邮件报告）确认邮件发送的技术可行性，并确认 spec 中邮件配置项是否必要、如何取值。

## 结论（先说结果）

**可行，已完成真实端到端验证。** 2026-07-30 使用 `.easemob-agent/config.json` 中的实际配置（`smtp.easemob.com:465` / SSL / `zuoyu@easemob.com` 登录密码认证），通过 nodemailer 成功完成 `verify()` 认证并真实发送一封测试邮件，服务器返回 `250 Data Ok: queued`。链路全通，spec 可直接执行。

## 事实确认

### 1. SMTP 服务器地址与端口

- 阿里云企业邮箱官方 SMTP 地址为 `smtp.qiye.aliyun.com` **或** `smtp.[$Domain]`（即本项目的 `smtp.easemob.com`，两者等价）。
  来源：[阿里邮箱如何通过SMTP程序发信](https://help.aliyun.com/zh/document_detail/36687.html)、[IMAP/POP/SMTP服务器地址及端口配置](https://help.aliyun.com/zh/document_detail/438661.html)
- 端口：`25`、`80`、`465`（SSL 加密）。**587 端口未开通**；阿里云 ECS 默认封禁 25 端口，生产推荐 465/SSL。
- 本机实测（2026-07-30）：
  - `smtp.easemob.com` 是 `smtp.qiye.aliyun.com` 的 CNAME，465 和 25 端口 TCP 均连通。
  - 465 端口 SSL 握手成功，服务端 banner 为 `220 smtp.aliyun-inc.com MX AliMail Server`，确认为阿里云企业邮箱服务。

### 2. 认证方式（已确认）

- 阿里云企业邮箱**默认不需要独立授权码**：用户名 = 完整邮箱地址（`zuoyu@easemob.com`），密码 = 邮箱登录密码。
  来源：[阿里邮箱smtp授权码怎么获取](https://www.mail-aliyun.cn/index.php?m=home&c=View&a=index&aid=234)
- 例外情况：如果域管理员在后台开启了「三方客户端安全密码」，则必须用单独生成的客户端安全密码，不能用登录密码。
  来源：[域管如何开启三方客户端安全密码](https://help.aliyun.com/zh/document_detail/444380.html)
- **已与用户确认（2026-07-30）：域级和账号级均未启用三方客户端安全密码，`SMTP_PASS` 直接填邮箱登录密码。**

### 3. 发送实现

- `nodemailer`（spec 已定为新依赖），465 端口对应配置 `secure: true`（隐含 TLS，非 STARTTLS）：

```js
nodemailer.createTransport({
  host: 'smtp.easemob.com',
  port: 465,
  secure: true, // 465 = SSL；非 465 端口才用 secure:false + STARTTLS
  auth: { user: 'zuoyu@easemob.com', pass: '...' },
});
```

- `transporter.sendMail()` 失败会 reject，与 spec「邮件发送失败记 error 日志、不重试、不影响进程」的失败处理天然吻合。

## 配置项必要性评估

spec 中 6 个邮件配置项**全部必要**，结论如下：

| 配置项 | 必要性 | 本项目取值 | 说明 |
| --- | --- | --- | --- |
| `APP__MAIL__SMTP_HOST` | 必需 | `smtp.easemob.com` | 即用户已知的 `smtp.easemob.com:465` 前半部分；与 `smtp.qiye.aliyun.com` 等价 |
| `APP__MAIL__SMTP_PORT` | 必需 | `465` | 即 `:465` 那部分；465 对应 SSL，实现里 `secure: true` |
| `APP__MAIL__SMTP_USER` | 必需 | `zuoyu@easemob.com` | SMTP 认证用户名，必须是完整邮箱地址 |
| `APP__MAIL__SMTP_PASS` | 必需 | 邮箱登录密码（或三方客户端安全密码，见上文例外） | 当前 config.json 为空，需填入 |
| `APP__MAIL__FROM` | 必需 | `zuoyu@easemob.com` | 阿里云要求 From 与认证用户一致，否则会拒信（535/553 类错误） |
| `APP__MAIL__TO` | 必需 | `zuoyu@easemob.com`（可逗号分隔多人） | 没有收件人谈不上发报告 |

两点补充判断：

- `FROM` 与 `SMTP_USER` 在阿里云场景下必然相同，理论上可以合并省一个配置项；但保留两者是 SMTP 工具的通用约定（nodemailer 也分开），且不改 spec 已定的结构，**建议保留**。
- 用户提供的 `imap.easemob.com:993` 与本任务无关 —— IMAP 是收信协议，发报告只走 SMTP。

## 最终配置（填入 `.easemob-agent/config.json`）

```json
"APP__MAIL__SMTP_HOST": "smtp.easemob.com",
"APP__MAIL__SMTP_PORT": "465",
"APP__MAIL__SMTP_USER": "zuoyu@easemob.com",
"APP__MAIL__SMTP_PASS": "<邮箱登录密码或三方客户端安全密码>",
"APP__MAIL__FROM": "zuoyu@easemob.com",
"APP__MAIL__TO": "zuoyu@easemob.com"
```

## 遗留风险

1. ~~SMTP_PASS 未填~~ 已解决：2026-07-30 用户已填入登录密码，端到端验证通过。
2. **发送频率**：每天 1 封，远低于阿里云企业邮箱的发信频率/数量限制，无风险。
