-- schema-v12.sql: pipeline visual graph (DAG with conditional edges)

ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS graph JSONB;

COMMENT ON COLUMN test_pipelines.graph IS
  'PipelineGraph { nodes, edges }. NULL 时 runtime 把 stages 列当作线性图读取。';
