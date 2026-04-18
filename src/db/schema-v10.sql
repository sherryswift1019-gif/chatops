-- schema-v10.sql: test_runs 增加 summary 摘要字段

ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS summary text DEFAULT '';
