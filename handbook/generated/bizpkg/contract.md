<!-- 本文件由 handbook/tools/codegen.mjs 生成，禁止手改；请编辑 content/ 下的 YAML 源 -->


# 业务包契约


## 契约的作用

> `bizpkg.contract.overview`

业务包通过 `contract.json` 向平台声明自己的输入输出契约。
平台在入口（check-input）与出口（check-output）各设一道机械校验闸门：
入口拦截缺少必填字段的非法事件，出口拦截不合约的处理结果，
使主程序 main 可以信任经闸门过滤后的数据形状。


_参见：`bizpkg.contract.input.issue-key`_


## 工单号

> `bizpkg.contract.input.issue-key`

**字段** `issue_key` · 类型 `string` · 必填


Jira 工单唯一标识，例如 `HIM-24058`。
check-input 会机械校验其存在性与类型，缺失或类型不符的事件在入口即被拒绝。
