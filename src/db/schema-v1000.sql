-- src/db/schema-v1000.sql
-- E2E 自动化测试模块 — 独立段位，永不与主干 v1..v999 撞号

CREATE TABLE e2e_target_projects (
  id                   TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  gitlab_repo          TEXT NOT NULL,
  default_branch       TEXT NOT NULL DEFAULT 'main',
  working_dir          TEXT NOT NULL DEFAULT '.',
  scripts              JSONB NOT NULL,
  capabilities         JSONB NOT NULL DEFAULT '{}',
  default_sandbox_kind TEXT NOT NULL DEFAULT 'docker-compose-local',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE e2e_specs (
  id                      BIGSERIAL PRIMARY KEY,
  target_project_id       TEXT NOT NULL REFERENCES e2e_target_projects(id),
  spec_path               TEXT NOT NULL,
  title                   TEXT NOT NULL,
  content_hash            TEXT NOT NULL,
  generated_artifact_path TEXT,
  generated_pr_url        TEXT,
  generation_status       TEXT NOT NULL DEFAULT 'pending',
  last_generated_at       TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_project_id, spec_path),
  CHECK (generation_status IN ('pending','generating','pr_open','committed','baseline_failed','blocked_on_baseline_bug','skipped'))
);

CREATE TABLE e2e_runs (
  id                BIGSERIAL PRIMARY KEY,
  target_project_id TEXT NOT NULL REFERENCES e2e_target_projects(id),
  trigger_type      TEXT NOT NULL,
  trigger_actor     TEXT,
  source_branch     TEXT NOT NULL,
  iteration_branch  TEXT NOT NULL,
  scenario_filter   JSONB,
  status            TEXT NOT NULL DEFAULT 'pending',
  governor_state    JSONB NOT NULL DEFAULT '{}',
  summary_mr_url    TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  abort_reason      TEXT,
  CHECK (status IN ('pending','running','awaiting_fix','passed','failed','aborted'))
);

CREATE INDEX idx_e2e_runs_status ON e2e_runs(status)
  WHERE status IN ('pending','running','awaiting_fix');
CREATE INDEX idx_e2e_runs_project ON e2e_runs(target_project_id, started_at DESC);

CREATE TABLE e2e_scenario_runs (
  id                   BIGSERIAL PRIMARY KEY,
  e2e_run_id           BIGINT NOT NULL REFERENCES e2e_runs(id) ON DELETE CASCADE,
  scenario_id          TEXT NOT NULL,
  scenario_name        TEXT,
  attempt_number       INT NOT NULL,
  result               TEXT NOT NULL,
  duration_ms          INT,
  evidence_manifest    JSONB,
  evidence_dir_uri     TEXT,
  linked_bug_report_id BIGINT REFERENCES bug_analysis_reports(id) ON DELETE SET NULL,
  started_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ,
  UNIQUE (e2e_run_id, scenario_id, attempt_number),
  CHECK (result IN ('pass','fail','error','timeout','skipped','unfixable')),
  CHECK (evidence_manifest IS NULL OR length(evidence_manifest::text) < 32768)
);

CREATE INDEX idx_e2e_scenario_runs_run ON e2e_scenario_runs(e2e_run_id, scenario_id);
CREATE INDEX idx_e2e_scenario_runs_failed ON e2e_scenario_runs(e2e_run_id)
  WHERE result IN ('fail','error');

CREATE TABLE e2e_sandboxes (
  id           BIGSERIAL PRIMARY KEY,
  e2e_run_id   BIGINT REFERENCES e2e_runs(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,
  handle       JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'provisioning',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at     TIMESTAMPTZ,
  destroyed_at TIMESTAMPTZ,
  CHECK (status IN ('provisioning','ready','redeploying','torn_down','failed'))
);

CREATE INDEX idx_e2e_sandboxes_run ON e2e_sandboxes(e2e_run_id)
  WHERE status NOT IN ('torn_down','failed');

-- chatops dogfood 项目硬编码登记
INSERT INTO e2e_target_projects (id, display_name, gitlab_repo, default_branch, working_dir, scripts, capabilities) VALUES (
  'chatops',
  'ChatOps',
  'devops/chatops',
  'main',
  '.',
  '{"build":"build.sh","deploy":"deploy.sh","test":"test.sh"}',
  '{"testFramework":"playwright","sandboxKind":"docker-compose-local"}'
);

-- invoke_target_script 节点注册
INSERT INTO pipeline_node_types (key, display_name, description, param_schema, enabled)
VALUES (
  'invoke_target_script',
  '调用项目脚本',
  '调用被测项目的约定脚本（build/deploy/test/fix），按 stdout JSON + exit code 协议解析结果',
  '{"type":"object","properties":{"scriptPath":{"type":"string"},"args":{"type":"array","items":{"type":"string"}},"env":{"type":"object"},"timeoutSeconds":{"type":"number"},"workingDir":{"type":"string"}},"required":["scriptPath","args"]}',
  true
)
ON CONFLICT (key) DO UPDATE SET enabled = true;

-- 注意: internal_capability_pipelines 的 e2e_generate_script 映射不在本 schema 中插入。
-- Pipeline A 是 hardcoded LangGraph graph，不存储在 pipelines 表，没有 pipeline_id 可引用。
-- IM 触发路径（@bot 生成测试 ...）需要在 coordinator.ts 里单独加 dispatch，Phase 1 不实现。
-- UI 触发路径（POST /admin/e2e-specs/:id/generate）在 Plan 2 Task 9 中直接调用 runPipelineA()。

-- 断言：enabled node types ≥ 13
DO $$
DECLARE cnt INT;
BEGIN
  SELECT count(*) INTO cnt FROM pipeline_node_types WHERE enabled = true;
  IF cnt < 13 THEN
    RAISE EXCEPTION 'pipeline_node_types enabled count is %, expected >= 13', cnt;
  END IF;
END $$;
