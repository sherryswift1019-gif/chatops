-- v50: pipeline container image support
ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS container_image TEXT DEFAULT NULL;
