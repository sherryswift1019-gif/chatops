-- schema-v16.sql: pipeline visual graph (DAG with conditional edges)
-- 原本命名为 schema-v12；upstream main 已占用 v12/v13（bug_fix_events/handover）
-- 和 v14/v15（bug_analysis_reports 字段扩展），合并 main 时挪号到 v16。

ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS graph JSONB;

COMMENT ON COLUMN test_pipelines.graph IS
  'PipelineGraph { nodes, edges }. NULL 时 runtime 把 stages 列当作线性图读取。';
