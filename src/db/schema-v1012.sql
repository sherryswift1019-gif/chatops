-- v1012: retry_counters JSONB extension for AI review counter + last notes.
-- 不改 column type（jsonb 本身 schemaless）；本 migration 仅登记 _migrations 表 +
-- 加 COMMENT 说明结构约定，供 repository 层 incrementAiReviewRound() 写入参考。

CREATE TABLE IF NOT EXISTS _migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _migrations WHERE version='v1012') THEN
    INSERT INTO _migrations(version, applied_at) VALUES ('v1012', NOW());
  END IF;
END $$;

COMMENT ON COLUMN requirements.retry_counters IS
  'JSONB schema (v1012): {
     reject_counts: {<node_id>: <count>},
     last_reject_reasons: {<author_node>: <string>},
     ai_review_rounds: {<review_node>: <count>},
     last_ai_review_notes: {<author_node>: Array<{severity, msg, file?}>}
   }';
