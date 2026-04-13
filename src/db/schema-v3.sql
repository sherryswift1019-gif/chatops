-- test_servers (test server pool)
CREATE TABLE IF NOT EXISTS test_servers (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  host             TEXT NOT NULL,
  port             INT NOT NULL DEFAULT 22,
  username         TEXT NOT NULL,
  auth_type        TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password','key')),
  credential       TEXT NOT NULL DEFAULT '',
  role             TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','in_use','offline')),
  tags             JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- test_pipelines (pipeline template definitions)
CREATE TABLE IF NOT EXISTS test_pipelines (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT DEFAULT '',
  stages           JSONB NOT NULL DEFAULT '[]',
  server_roles     JSONB NOT NULL DEFAULT '{}',
  schedule         TEXT DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- test_runs (pipeline execution records)
CREATE TABLE IF NOT EXISTS test_runs (
  id               SERIAL PRIMARY KEY,
  pipeline_id      INT NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  trigger_type     TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual','api','scheduled')),
  triggered_by     TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','success','failed','cancelled')),
  servers          JSONB NOT NULL DEFAULT '{}',
  current_stage    INT NOT NULL DEFAULT 0,
  stage_results    JSONB NOT NULL DEFAULT '[]',
  report_path      TEXT DEFAULT '',
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  error_message    TEXT DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_test_runs_pipeline ON test_runs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status);
