-- v1015: retry_counters JSONB schema documentation (ai_review_rounds + last_ai_review_notes).
-- 不改 column type（jsonb 本身 schemaless）；本 migration 仅加 COMMENT 说明结构约定，
-- 供 repository 层 incrementAiReviewRound() 写入参考。
-- _migrations 表注册由 migrate.ts bootstrap 负责，不在 schema 文件内自行 INSERT。

COMMENT ON COLUMN requirements.retry_counters IS
  'JSONB schema (v1015): {
     reject_counts: {<node_id>: <count>},
     last_reject_reasons: {<author_node>: <string>},
     ai_review_rounds: {<review_node>: <count>},
     last_ai_review_notes: {<author_node>: Array<{severity, msg, file?}>}
   }';
