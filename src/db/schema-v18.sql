-- schema-v18.sql: pipeline visual graph (DAG with conditional edges)
-- 原本命名为 schema-v12；upstream main 先占用 v12/v13（bug_fix_events/handover）、
-- v14/v15（bug_analysis_reports 字段扩展），以及 v16/v17（PRD Agent），
-- 合并 main 时第三次挪号到 v18。

ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS graph JSONB;

COMMENT ON COLUMN test_pipelines.graph IS
  'PipelineGraph { nodes, edges }. NULL 时 runtime 把 stages 列当作线性图读取。';
