-- v53: pipeline 触发参数 schema 提升 + pipeline_schedules 定时规则表

ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS param_schema JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS im_prompt    TEXT  DEFAULT NULL;

CREATE TABLE IF NOT EXISTS pipeline_schedules (
  id            SERIAL PRIMARY KEY,
  pipeline_id   INT  NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  cron_expr     TEXT NOT NULL,
  preset_params JSONB NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_schedules_pipeline_id
  ON pipeline_schedules(pipeline_id);
