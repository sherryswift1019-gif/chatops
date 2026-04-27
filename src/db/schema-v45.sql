-- v45: pipeline_dryrun_snapshots 表 + test_runs.trigger_params 列

CREATE TABLE IF NOT EXISTS pipeline_dryrun_snapshots (
  pipeline_id           INT NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  node_id               TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('success','failed','skipped')),
  output                JSONB NOT NULL DEFAULT '{}',
  source                TEXT NOT NULL CHECK (source IN ('real','stub','manual')),
  upstream_params_hash  TEXT NOT NULL,
  last_decision         TEXT,
  last_manual_input     JSONB,
  duration_ms           INT,
  error                 TEXT,
  ran_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pipeline_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_dryrun_snapshots_pipeline
  ON pipeline_dryrun_snapshots(pipeline_id);

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS trigger_params JSONB NOT NULL DEFAULT '{}';
