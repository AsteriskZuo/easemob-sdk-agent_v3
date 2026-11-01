# 本地验证：用未发版的 SDK 调试业务包

## 1. 背景与结论

业务包把 `@asteriskzuo/agent-sdk` 当普通 npm 依赖（npm registry 正式版）。当平台仓里的 SDK 有**未发版**改动、想先用业务包验证时，有三种方式，按推荐顺序：

1. **node_modules 软链**（日常调试首选）——零 tracked 文件改动，随时还原；
2. **npm pack 打 tgz 安装**（发版前终审）——产物与真实发布完全一致；
3. **file: 协议**（模板验收脚本同款）——改动最直观，但会改写 tracked 文件。

先说清楚一个事实：**npm 没有 Flutter `pubspec_overrides.yaml` 那样的「本地覆盖文件」机制**。npm 的 `overrides` 字段不支持 `file:` 协议、且必须写在 package.json 里提交；社区工具 yalc 也会改写 package.json。所以"不提交、纯本地"的诉求，最接近的实现就是方式一的软链（`npm link` 的原理，手动做以避开其全局写入副作用）。

> 注意：SDK 的依赖 `@asteriskzuo/agent-process-runner`（与 SDK 同版本）可能尚未发版。无论哪种方式，都要保证它和 SDK **一起**就位，否则安装或运行时会 404 / 解析失败。

## 2. 方式一：node_modules 软链（推荐）

设业务包项目根为 `$BIZ`（含 package.json 的那层），平台仓根为 `$PLATFORM`。

1. **先在平台仓构建**（SDK 入口指向 `dist/`，必须有产物）：
   ```bash
   cd "$PLATFORM" && yarn build
   ```
2. **备份 registry 版并建立软链**：
   ```bash
   cd "$BIZ/node_modules/@asteriskzuo"
   mv agent-sdk agent-sdk.registry-bak
   ln -s "$PLATFORM/packages/sdk" agent-sdk
   ln -s "$PLATFORM/packages/process-runner" agent-process-runner
   ```
   若业务包还依赖其他平台包（如 `@asteriskzuo/agent-jira-client`），同样逐个链接。
3. **金丝雀确认生效的是本地版**：
   ```bash
   readlink node_modules/@asteriskzuo/agent-sdk   # 应输出平台仓路径
   ```
4. 正常跑业务包的六条检查（`npm run build` / `npm test` / `npm run typecheck` / `npm run lint` / `npm run format:check` / `npm run circular`）。

**原理**：Node 默认按 realpath 解析模块，SDK 对 `agent-process-runner` 的引用会沿平台仓的 node_modules（monorepo 依赖已装齐）解析成功；`$BIZ` 里那条 process-runner 软链是显式双保险。SDK 源码改完后，在平台仓重新 build 即生效，业务包侧零操作。

**还原**：

```bash
cd "$BIZ/node_modules/@asteriskzuo"
rm agent-sdk agent-process-runner
mv agent-sdk.registry-bak agent-sdk
```

或者直接 `npm install` 按 lockfile 重装。

**坑**：任何 `npm install` / `npm ci` 都会冲掉软链，装完需要重做。node_modules 已被 `.gitignore` 忽略，整个过程中业务仓 `git status` 始终干净。

## 3. 方式二：npm pack 打 tgz（发版前终审）

```bash
cd "$PLATFORM/packages/process-runner" && npm pack     # 生成 asteriskzuo-agent-process-runner-x.y.z.tgz
cd "$PLATFORM/packages/sdk" && npm pack                # 生成 asteriskzuo-agent-sdk-x.y.z.tgz
cd "$BIZ" && npm install <两个 tgz 的绝对路径>
```

- **同一条命令安装两个 tgz**，npm 会用本地 tgz 满足 SDK 对 process-runner 的依赖（与顺序无关）；只装 SDK 一个会去 registry 找 process-runner，未发版时 404。
- 这条路验证的就是真实发布产物（`files` 白名单、exports、依赖声明），发版前建议走一遍。
- **会改写 package.json 和 package-lock.json**（tracked 文件）——验证完 `git checkout -- package.json package-lock.json` 还原，别提交。

## 4. 方式三：file: 协议（模板验收脚本同款）

把 package.json 里的依赖改为本地路径再安装，npm 会建立软链：

```json
"dependencies": {
  "@asteriskzuo/agent-sdk": "file:<平台仓绝对路径>/packages/sdk"
}
```

平台仓 `scripts/verify-template.sh` 的模板验收就是这样改写的。解析沿软链真实路径向上查找 node_modules——指向平台仓内部时，SDK 对 process-runner 的依赖由平台仓已装齐的依赖满足；若你的场景遇到 registry 404，把 process-runner 也加一条 `file:` 即可。

同样**会改写 package.json / lockfile**（tracked），验证完记得还原。

## 5. 什么时候必须发版

本地验证怎么绕都可以，但**平台物化（materialize）在业务工作区执行 `npm ci`，只认 registry**。要走平台端到端跑业务包，必须发版，顺序：**process-runner → SDK**（SDK 依赖它）。

发版时注意：npm 不允许同版本覆盖发布。若 SDK 的版本号已存在于 registry（如 `0.1.0`），再发必须升版本号；且业务包的 `"^0.1.0"` 匹配不到 `0.2.0`——发 minor 版本要同步改业务包的依赖范围，发 patch（`0.1.1`）则不用动。

## 6. 验证清单

- [ ] `readlink node_modules/@asteriskzuo/agent-sdk` 指向平台仓（方式一），或 tgz 安装成功（方式二）
- [ ] 金丝雀：确认生效版本带新特征（如 `grep -r "agent-process-runner" node_modules/@asteriskzuo/agent-sdk/dist/` 有输出）
- [ ] 业务包六条检查全绿
- [ ] 方式一：业务仓 `git status` 零改动；方式二/三：验证完已还原 tracked 文件
- [ ] 业务仓库若有多个工程（如独立工具子目录），每个工程的 node_modules 需分别处理
