-- schema-v10.sql: artifact inputs for pipelines + runtime vars record
ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS artifact_inputs JSONB NOT NULL DEFAULT '[]';

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS runtime_vars JSONB NOT NULL DEFAULT '{}';
