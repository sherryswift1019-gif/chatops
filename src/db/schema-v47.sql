-- v47: pipeline_webhooks 表
--
-- 为每条 pipeline 提供若干条独立 token，外部系统 POST /webhook/pipeline/:token
-- 即可异步触发 pipeline。token 仅在 create/rotate 时完整返回，后续查询只回前 8 字符。

CREATE TABLE IF NOT EXISTS pipeline_webhooks (
  id              SERIAL PRIMARY KEY,
  pipeline_id     INT NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  token           TEXT NOT NULL UNIQUE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  default_servers JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT NOT NULL DEFAULT '',
  last_used_at    TIMESTAMPTZ,
  last_run_id     INT,
  trigger_count   INT NOT NULL DEFAULT 0,
  UNIQUE (pipeline_id, name)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_webhooks_pipeline
  ON pipeline_webhooks(pipeline_id);
