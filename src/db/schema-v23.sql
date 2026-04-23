-- schema-v23.sql: PRD Agent V2.0 baseline metrics 埋点字段
-- 对应迭代文档 docs/prds/prd-agent-v2-iteration.md §9.2。
-- 原本命名为 schema-v18；upstream main 合并时 v18 已被 pipeline visual graph 占用，
-- v19 被 capability.default_pipeline_id 占用，v20/v21/v22 亦已分配，第二次挪号到 v23。
-- 最小改动：仅新增一个可选 JSONB 字段用于 per-PRD 统计；不改任何现有字段。

ALTER TABLE prd_documents
  ADD COLUMN IF NOT EXISTS metrics JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN prd_documents.metrics IS
  'V2.0 baseline 埋点。形态约定：{ llmCalls?: {create,review,repair}, reviewDurationMs?, rulesVersion?, ... }';
