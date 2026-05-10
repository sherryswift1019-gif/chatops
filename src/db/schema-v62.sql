-- schema-v62: register qi_e2e_runner / im_input node types and extend approval waiter decision set
-- 关联 PRD: docs/prds/prd-quick-impl-e2e-phase2.md
-- 注意：e2e_stub 节点保留（v8 in-flight QI run 仍需要），仅在 display_name 标 deprecated

-- ============================================================================
-- 1. 注册新节点类型：qi_e2e_runner（QI 自有 E2E 跑）
-- ============================================================================

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'qi_e2e_runner',
  'Quick-Impl 自有 E2E 测试',
  '从 worktree docs/test-playbooks/qi-{requirementId}.yaml 解析 scenario，push 到本地 bare 仓，provision sandbox，串行跑每个 scenario，回写 failureReport。Phase 2 替换 e2e_stub。',
  'quick_impl',
  '{
    "type": "object",
    "required": ["requirementId", "worktreePath", "branch", "bareRepoPath"],
    "properties": {
      "requirementId": { "type": "integer" },
      "worktreePath":  { "type": "string" },
      "branch":        { "type": "string" },
      "bareRepoPath":  { "type": "string" },
      "targetProjectId": { "type": "string" },
      "maxAttempts":   { "type": "integer", "default": 2 }
    }
  }'::jsonb,
  '{
    "type": "object",
    "properties": {
      "result":         { "type": "string", "enum": ["pass", "fail", "sandbox_failed"] },
      "attempt":        { "type": "integer" },
      "scenariosRun":   { "type": "integer" },
      "passed":         { "type": "integer" },
      "failed":         { "type": "integer" },
      "durationMs":     { "type": "integer" },
      "failureReport":  { "type": ["object", "null"] },
      "sandboxError":   { "type": ["string", "null"] }
    }
  }'::jsonb,
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

-- ============================================================================
-- 2. 注册新节点类型：im_input（IM 卡片人工介入 interrupt-bound 节点）
-- ============================================================================

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'im_input',
  'IM 卡片人工介入',
  '通过钉钉/飞书互动卡片让人工做决策（fix/force_passed/aborted 三值，或 retry/aborted 二值）。interrupt-bound 节点：抛 interrupt 注册 waiter，IM 卡片回调时 resume graph。',
  'quick_impl',
  '{
    "type": "object",
    "required": ["requirementId", "kind"],
    "properties": {
      "requirementId":   { "type": "integer" },
      "kind":            { "type": "string", "enum": ["qi_e2e_intervention", "qi_sandbox_failed"] },
      "approverIds":     { "type": "array", "items": { "type": "string" } },
      "contextPayload":  { "type": "object" },
      "timeoutSeconds":  { "type": "integer", "default": 86400 }
    }
  }'::jsonb,
  '{
    "type": "object",
    "properties": {
      "decision":  { "type": "string", "enum": ["fix", "force_passed", "aborted", "retry"] },
      "humanNote": { "type": ["string", "null"] },
      "decidedBy": { "type": "string" },
      "decidedAt": { "type": "string", "format": "date-time" }
    }
  }'::jsonb,
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

-- ============================================================================
-- 3. 标记 e2e_stub 为 deprecated（保留供 v8 in-flight run 使用，不删除）
-- ============================================================================

UPDATE pipeline_node_types
SET display_name = 'Quick-Impl E2E 测试（Stub，已废弃）',
    description = 'Phase 1 占位节点，始终返回 pass。已被 qi_e2e_runner 替代；仅保留供 v8 in-flight QI run 使用，新建 QI run 不再使用。',
    updated_at = NOW()
WHERE key = 'e2e_stub';

-- ============================================================================
-- 4. requirement_approval_waiters 表无 CHECK 约束（decision/decision_set 都是 TEXT 列）
--    新增 decision 值 'fix' 由代码层 ApprovalDecision 类型加 'fix' 兼容
--    新增 decision_set 值 'qi_e2e_intervention' / 'qi_sandbox_failed' 同理
--    无需 ALTER TABLE
-- ============================================================================

-- ============================================================================
-- 5. v9: init_qi_branch 节点 output_schema 加 bareRepoPath（v9 graph qi_e2e_runner 引用）
-- ============================================================================

UPDATE pipeline_node_types
SET output_schema = '{
  "type": "object",
  "properties": {
    "branch": { "type": "string" },
    "worktreePath": { "type": "string" },
    "cachePath": { "type": "string" },
    "bareRepoPath": { "type": ["string", "null"] }
  }
}'::jsonb,
    updated_at = NOW()
WHERE key = 'init_qi_branch';
