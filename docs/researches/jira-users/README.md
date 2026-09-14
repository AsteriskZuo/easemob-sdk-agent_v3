# Jira 用户信息抓取调研

## 调研目的

`matchesAssignee` 中需要比较 Jira 用户的 `name`、`key`、`emailAddress`、`displayName` 等多个字段来确定 assignee 身份。但运行时只知道其中一个字段值（如邮箱），需要一个**完整的用户映射表**来做匹配。

## 调研发现

**Jira 版本**: 6.3.6（2014年版本）

`/rest/api/2/user/search?username=.` 的 `.` 通配符在此版本**不生效**（返回空数组），需要通过**前缀遍历**获取全部用户：

```bash
# 遍历 a-z 每个单字符作为前缀
GET /rest/api/2/user/search?username=a&includeActive=true&includeInactive=true&maxResults=1000
GET /rest/api/2/user/search?username=b&...
...
GET /rest/api/2/user/search?username=z&...
```

按 `name` 去重后即为全量用户列表。

### 用户对象字段

```json
{
  "name": "asteriskzuo",
  "key": "asteriskzuo",
  "displayName": "佐玉",
  "emailAddress": "zuoyu@easemob.com",
  "active": true
}
```

## 脚本

`fetch-jira-users.mjs` — 可复用的抓取脚本。

### 用法

```bash
# 抓取全部用户，输出到 jira-users.json
node docs/researches/jira-users/fetch-jira-users.mjs

# 自定义输出路径
node docs/researches/jira-users/fetch-jira-users.mjs --output=./my-users.json

# 干跑（打印方法说明，不发请求）
node docs/researches/jira-users/fetch-jira-users.mjs --dry-run

# 指定配置文件
node docs/researches/jira-users/fetch-jira-users.mjs --config=/path/to/config.json
```

### 输出格式 (`jira-users.json`)

```json
{
  "fetchedAt": "2026-07-16T...",
  "jiraUrl": "https://j1.private.easemob.com",
  "total": 647,
  "active": 106,
  "inactive": 541,
  "name→email": { "asteriskzuo": "zuoyu@easemob.com", ... },
  "email→name": { "zuoyu@easemob.com": "asteriskzuo", ... },
  "name→displayName": { "asteriskzuo": "佐玉", ... },
  "users": [
    {
      "name": "asteriskzuo",
      "key": "asteriskzuo",
      "displayName": "佐玉",
      "emailAddress": "zuoyu@easemob.com",
      "active": true
    },
    ...
  ]
}
```

提供了三个快捷映射表：
- `name→email` — 通过用户名查邮箱
- `email→name` — 通过邮箱查用户名（matchesAssignee 常用）
- `name→displayName` — 通过用户名查显示名

### 复用性

脚本完全独立，不依赖项目源码：
- 认证逻辑内联，只使用 Node.js 标准库 `fetch`
- 通过 `--config` 指定配置文件，适配不同 Jira 实例
- 自动适配 Jira 6.x 前缀遍历方式
