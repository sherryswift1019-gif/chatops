-- v6: Add variables column to test_pipelines
ALTER TABLE test_pipelines ADD COLUMN IF NOT EXISTS variables JSONB NOT NULL DEFAULT '{}';
