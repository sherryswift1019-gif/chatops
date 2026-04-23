# 冒烟测试：画布节点配置面板

场景覆盖 2026-04-22 设计（下拉化 + 数据流打通）的关键路径。

## 前置

- 后端：`pnpm dev`
- 前端：`cd web && pnpm dev`
- 访问 `/pipelines`，进入任一流水线的画布编辑页

## 场景 1：capability Select 基本流

1. 添加 `Agent Capability` 节点
2. 在 Inspector 点 "Capability" 下拉，应看到全量 capability 列表，每项显示 displayName + key + category tag
3. 在搜索框输入 capability 的 displayName 片段，可过滤
4. 选中一个有 paramSchema 的 capability，下方应自动出现"Capability 参数"字段组
5. 保存 → 重进画布 → 选中同一节点 → 依然能看到刚才的 capabilityKey 和参数

## 场景 2：capability 必填保存拦截

1. 添加 `Agent Capability` 节点（不选 capabilityKey）
2. 点击"保存" → 应弹 message.error 指向该节点名，节点 Inspector 自动打开
3. 网络面板应确认没有发出 PUT /test-pipelines/:id/graph 请求

## 场景 3：im_input → capability 数据流打通（E2E）

1. 添加 `IM 参数采集` 节点：
   - 引导语：`请提供 branch`
   - paramSchema：`{"type":"object","required":["branch"],"properties":{"branch":{"type":"string"}}}`
2. 添加 `Agent Capability` 节点（选一个需要 `ref` 参数的 capability），`capabilityParams.ref` 填 `{{vars.branch}}`
3. 连边 im_input → capability
4. 保存成功后，从 IM 触发该流水线 → 机器人发引导语 → 回复 `branch=main`
5. capability 节点应收到 `ref="main"`（可在日志或 capability 的 output 里确认）

## 场景 4：stageType 切换弹框

1. 添加脚本节点，填脚本内容 `echo hi`
2. 在 Inspector 把"类型"改成"Agent Capability"
3. 应弹确认框 `将清空：script`
4. 确认 → script 字段清空；取消 → 类型回退

## 场景 5：切换 capabilityKey 保留重叠字段

1. 选一个 capabilityA（schema 有 `foo`、`bar`），`foo=x`，`bar=y`
2. 切到 capabilityB（schema 只有 `foo`、`baz`）
3. 表单里 `foo=x` 保留，`bar` 被丢弃，`baz` 空

## 场景 6：stale capabilityKey 兼容

1. 手动在 DB 把 capability `deploy` 改 key 为 `deploy_renamed`
2. 重进画布 → capability 节点的 Select 显示 `deploy（不在能力列表中）`，带黄色 warning
3. 不触动即可保存；重选一个新 key 也可以

## 场景 7：im_input.capabilityKey 留空

1. 添加 im_input 节点，不选"关联 Capability"
2. 保存成功、触发执行无报错
