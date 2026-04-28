-- v48: capabilities 新增业务分类字段
ALTER TABLE capabilities
  ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IN ('feature_dev', 'bug_fix', 'ops', 'info_query'));
