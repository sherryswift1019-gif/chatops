-- v60: quick-impl pipeline 数据模型
-- · requirements 表（需求索引，git 分支为主存）
-- · requirement_approval_waiters 表（双端审批 race-claim）
-- · pipeline_node_types CHECK 约束扩展 'quick_impl' 分类
-- · test_pipelines.is_system 列（标记系统管理 pipeline，不可在画布编辑）
-- · 4 个新 quick-impl node types 注册（skill_node / skill_with_approval /
--   skill_with_review / mr_create）

-- ============================================================================
-- 1. requirements 表（git 分支的索引）
-- ============================================================================

CREATE TABLE IF NOT EXISTS requirements (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  raw_input       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',
  branch          TEXT,
  base_branch     TEXT NOT NULL DEFAULT 'main',
  gitlab_project  TEXT NOT NULL,
  worktree_path   TEXT,
  pipeline_run_id INT REFERENCES test_runs(id) ON DELETE SET NULL,
  current_stage   TEXT,
  spec_path       TEXT,
  plan_path       TEXT,
  spec_content    TEXT,
  plan_content    TEXT,
  mr_url          TEXT,
  abort_reason    TEXT,
  retry_counters  JSONB NOT NULL DEFAULT '{}'::jsonb,
  source          TEXT NOT NULL DEFAULT 'web',
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_requirements_status
  ON requirements(status);

CREATE INDEX IF NOT EXISTS idx_requirements_pipeline_run
  ON requirements(pipeline_run_id);

CREATE INDEX IF NOT EXISTS idx_requirements_created_by
  ON requirements(created_by);

-- ============================================================================
-- 2. requirement_approval_waiters 表（双端审批 race-claim）
-- ============================================================================

CREATE TABLE IF NOT EXISTS requirement_approval_waiters (
  id              SERIAL PRIMARY KEY,
  requirement_id  INT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  pipeline_run_id INT NOT NULL,
  node_id         TEXT NOT NULL,
  approval_kind   TEXT NOT NULL,
  round           INT NOT NULL DEFAULT 1,
  decision_set    TEXT NOT NULL DEFAULT 'binary',
  im_platform     TEXT,
  im_group_id     TEXT,
  context_summary TEXT,
  claimed_by      TEXT,
  claimed_at      TIMESTAMPTZ,
  decision        TEXT,
  reject_reason   TEXT,
  budget_delta    INT,
  decided_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 同一 (requirement_id, node_id) 同时只能有一个未 claim 的 waiter
CREATE UNIQUE INDEX IF NOT EXISTS idx_req_waiter_active
  ON requirement_approval_waiters(requirement_id, node_id)
  WHERE claimed_by IS NULL;

-- 详情页历史时间线
CREATE INDEX IF NOT EXISTS idx_req_waiter_history
  ON requirement_approval_waiters(requirement_id, created_at);

-- 跨 pipeline_run 反查（清理孤儿 waiter）
CREATE INDEX IF NOT EXISTS idx_req_waiter_run
  ON requirement_approval_waiters(pipeline_run_id);

-- ============================================================================
-- 3. test_pipelines 加 is_system 列（沿用 v4 capabilities.is_system 命名）
-- ============================================================================

ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN test_pipelines.is_system IS
  '系统管理的 pipeline（如 quick-impl），管理后台不允许用户编辑';

-- ============================================================================
-- 4. pipeline_node_types CHECK 约束扩展 'quick_impl' 分类
-- ============================================================================

ALTER TABLE pipeline_node_types
  DROP CONSTRAINT IF EXISTS pipeline_node_types_category_check;

ALTER TABLE pipeline_node_types
  ADD CONSTRAINT pipeline_node_types_category_check
  CHECK (category IN ('general','flow','llm','specialized','quick_impl'));

-- ============================================================================
-- 5. 注册 4 个新 quick-impl node types
--    画布过滤规则：category='quick_impl' 节点 Phase 1 不出现在 NodeInspector
--    类型下拉里（通过前端 web/src/pipeline-canvas/panels/NodeInspector.tsx 过滤）
-- ============================================================================

-- 5.1 skill_node：一次性产出，无循环
INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'skill_node',
  'Quick-Impl Skill 调用',
  '加载 .claude/skills/<skill>/ 起子 agent 跑指定 role，产物 commit 到 worktree',
  'quick_impl',
  '{"type":"object","required":["skill","role"],"properties":{"skill":{"type":"string","title":"Skill ID"},"role":{"type":"string","title":"Role"},"inputs":{"type":"object","title":"输入变量映射"},"maxTurns":{"type":"integer","default":40},"timeoutMs":{"type":"integer","default":1800000},"commitMessage":{"type":"string","title":"Commit 消息模板"}}}'::jsonb,
  '{"type":"object","properties":{"commitSha":{"type":"string"},"artifactPath":{"type":"string"},"summary":{"type":"string"}}}'::jsonb,
  TRUE,
  TRUE
)
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  param_schema = EXCLUDED.param_schema,
  output_schema = EXCLUDED.output_schema,
  is_system = EXCLUDED.is_system,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();

-- 5.2 skill_with_approval：生成 + 双端审批 + reject 回生（spec_review_loop / final_approval 用）
INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'skill_with_approval',
  'Quick-Impl 生成+审批',
  '内部循环：生成产物 → IM/Web 双端审批 → reject 回生 → approve 退出 / budget 用尽 escalation',
  'quick_impl',
  '{"type":"object","required":["approvalKind","budgetMax"],"properties":{"skill":{"type":"string","description":"可空，generator 关闭（final_approval 用）"},"role":{"type":"string"},"approvalKind":{"type":"string","enum":["spec","final","escalation"]},"budgetMax":{"type":"integer","default":5},"decisionSet":{"type":"string","enum":["binary","escalation"],"default":"binary"},"imGroupId":{"type":"string"},"imPlatform":{"type":"string","enum":["dingtalk","feishu"]},"contextSummary":{"type":"string","description":"generator=null 时必填，给审批卡片的上下文"},"inputs":{"type":"object"},"maxTurns":{"type":"integer","default":60},"timeoutMs":{"type":"integer","default":1800000}}}'::jsonb,
  '{"type":"object","properties":{"decision":{"type":"string"},"rounds":{"type":"integer"},"finalArtifactPath":{"type":"string"},"finalCommit":{"type":"string"},"rejectHistory":{"type":"array"}}}'::jsonb,
  TRUE,
  TRUE
)
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  param_schema = EXCLUDED.param_schema,
  output_schema = EXCLUDED.output_schema,
  is_system = EXCLUDED.is_system,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();

-- 5.3 skill_with_review：生成 + AI Reviewer + fail 修复（dev_with_review_loop 用）
INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'skill_with_review',
  'Quick-Impl 生成+评审',
  '内部循环：dev-loop 生成 → 全新 ClaudeRunner 评审 → pass 退出 / fail 反馈 notes 重生 / fixBudget 用尽 escalation',
  'quick_impl',
  '{"type":"object","required":["skill","role","reviewerSkill","reviewerRole"],"properties":{"skill":{"type":"string"},"role":{"type":"string"},"reviewerSkill":{"type":"string"},"reviewerRole":{"type":"string"},"fixBudget":{"type":"integer","default":2},"inputs":{"type":"object"},"maxTurns":{"type":"integer","default":200},"reviewerMaxTurns":{"type":"integer","default":30},"timeoutMs":{"type":"integer","default":3600000},"reviewerTimeoutMs":{"type":"integer","default":600000}}}'::jsonb,
  '{"type":"object","properties":{"lastCommitSha":{"type":"string"},"fixRounds":{"type":"integer"},"reviewLog":{"type":"array","items":{"type":"object","properties":{"round":{"type":"integer"},"decision":{"type":"string"},"notes":{"type":"array"},"at":{"type":"string"}}}},"tasksDone":{"type":"array","items":{"type":"integer"}}}}'::jsonb,
  TRUE,
  TRUE
)
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  param_schema = EXCLUDED.param_schema,
  output_schema = EXCLUDED.output_schema,
  is_system = EXCLUDED.is_system,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();

-- 5.4 mr_create：调 GitLab REST API 创建 MR（不用 script 拼 shell）
INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'mr_create',
  'Quick-Impl 创建 MR',
  '通过 GitLab REST API 创建 Merge Request；自动检测 base 分支冲突生成 rebase hint',
  'quick_impl',
  '{"type":"object","required":["gitlabProject","branch","baseBranch"],"properties":{"gitlabProject":{"type":"string"},"branch":{"type":"string"},"baseBranch":{"type":"string"},"titleTemplate":{"type":"string","default":"[quick-impl] {{requirement.title}}"},"descriptionTemplate":{"type":"string","description":"支持 {{...}} 派生字段渲染，见 PRD §6.5.1.1"},"labels":{"type":"array","items":{"type":"string"},"default":["quick-impl","auto-generated"]},"removeSourceBranchAfterMerge":{"type":"boolean","default":true},"squashCommits":{"type":"boolean","default":false}}}'::jsonb,
  '{"type":"object","properties":{"mrUrl":{"type":"string"},"mrIid":{"type":"integer"},"rebaseHint":{"type":["string","null"]}}}'::jsonb,
  TRUE,
  TRUE
)
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  param_schema = EXCLUDED.param_schema,
  output_schema = EXCLUDED.output_schema,
  is_system = EXCLUDED.is_system,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();
