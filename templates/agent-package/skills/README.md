# skills/ —— 可选：skill 集合（占位说明）

**本目录是可选的。** skill 是独立资产（纯文档：每个含 `SKILL.md` 的直接子目录 = 一个 skill），
不随包物化、不被 apps/ 代码 import——运行时由平台按 `sdk.agent({ skills: [...] })` 的名字注入系统提示词。

## 什么时候需要它

单仓多资产开发时：本仓库根登记为**包资产**（subpath 缺省），本目录登记为 **skill 集合资产**
（登记时 subpath = `skills`），控制台创建业务时把两者绑定到同一业务——`requires.skills`
声明的名字必须能在绑定的 skill 集合里找到。不需要 skill 的业务直接删掉本目录。

## 规则

- 每个 skill 一个直接子目录，内含 `SKILL.md`（带 frontmatter：`name` / `description`）；
- skill 内不写密钥、不做网络调用——它只是提示词文档；
- 模板自带示例 `your-skill/`，与 `agent-package.json` 的 `requires.skills`、`apps/main`
  的 `sdk.agent({ skills: ["your-skill"] })` 示例自洽；上手后替换成自己的。
