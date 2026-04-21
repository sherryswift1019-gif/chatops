-- schema-v14.sql: pipeline visual graph (DAG with conditional edges)
-- 原本命名为 schema-v12；因 upstream 在 main 上已占用 v12/v13
-- （bug_fix_events / handover），合并 main 时挪号到 v14。

ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS graph JSONB;

COMMENT ON COLUMN test_pipelines.graph IS
  'PipelineGraph { nodes, edges }. NULL 时 runtime 把 stages 列当作线性图读取。';
