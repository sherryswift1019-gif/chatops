-- src/db/schema-v1003.sql
-- E2E playbook drafts: 用户在 E2E Runs 新建 Modal 输入场景描述，AI 生成 playbook YAML，人 review 后直接执行 Pipeline B。
CREATE TABLE e2e_playbook_drafts (
  id                BIGSERIAL PRIMARY KEY,
  target_project_id TEXT NOT NULL REFERENCES e2e_target_projects(id),
  scenario_input    TEXT NOT NULL,
  yaml_content      TEXT,
  status            TEXT NOT NULL DEFAULT 'drafting',
  e2e_run_id        BIGINT REFERENCES e2e_runs(id) ON DELETE SET NULL,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('drafting','reviewing','approved','rejected','generation_failed'))
);
CREATE INDEX idx_e2e_playbook_drafts_project ON e2e_playbook_drafts(target_project_id, created_at DESC);
