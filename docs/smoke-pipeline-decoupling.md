# 冒烟：pipeline 跟产线解绑

把 test_pipelines 退化为全局池，多产线通过 pipeline_bindings 引用同条 pipeline。

## 前置
- 数据库已 migrate 到 v42 (`pnpm migrate`)
- pipeline_bindings 表存在且每条 (product_line_id 非空) 老 pipeline 都有自动迁移的 binding 记录

## 场景 1：bugfix L1/L2/L3 走 binding 路径
[实施完阶段 2 后填]

## 场景 2：跨产线复用同条 pipeline
[实施完阶段 2 后填]

## 场景 3：老 pipeline 兼容
[实施完阶段 2 后填]

## 场景 4：前端 binding CRUD
[实施完阶段 3 后填]

## 已知差异
- KD-1: server_roles count → server id 自动转换在迁移时刻锚定，扩缩容后需手动 update
- KD-2: scheduler 删除后老 pipeline 的 schedule 字段失效（已 DROP）

## 回滚
- 阶段 1 回滚：`DROP TABLE pipeline_bindings; ALTER TABLE test_pipelines ADD COLUMN schedule TEXT...`
- 阶段 2 回滚：revert coordinator/executor 代码
- 阶段 3 回滚：revert 前端代码
