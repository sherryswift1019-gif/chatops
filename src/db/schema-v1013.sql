-- v1013: pipeline_run_state — 按 pipeline run 累计 token 用量
-- 每个 LLM 节点跑完写一行 data.token_total；getCumulativeTokenUsage SUM 求累计值。
-- data JSONB schema 约定：{ token_total: int }
CREATE TABLE IF NOT EXISTS pipeline_run_state (
  id                SERIAL PRIMARY KEY,
  pipeline_run_id   INT NOT NULL,
  data              JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pipeline_run_state_run_id_idx
  ON pipeline_run_state(pipeline_run_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _migrations WHERE version='v1013') THEN
    INSERT INTO _migrations(version, applied_at) VALUES ('v1013', NOW());
  END IF;
END $$;
