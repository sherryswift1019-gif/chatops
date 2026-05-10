-- schema-v61: register init_qi_branch and e2e_stub node types for Quick-Impl Phase 1

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'init_qi_branch',
  'Quick-Impl 初始化分支',
  '克隆/复用仓库缓存、创建 worktree、推 feature 分支；输出 worktreePath 和 branch 供下游节点引用',
  'quick_impl',
  '{"type":"object","required":["requirementId","gitlabProject","baseBranch"],"properties":{"requirementId":{"type":"integer"},"gitlabProject":{"type":"string"},"baseBranch":{"type":"string"}}}'::jsonb,
  '{"type":"object","properties":{"branch":{"type":"string"},"worktreePath":{"type":"string"},"cachePath":{"type":"string"}}}'::jsonb,
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

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'e2e_stub',
  'Quick-Impl E2E 测试（Stub）',
  'Phase 1 占位节点，始终返回 pass；Phase 2 替换为真实 E2E runner',
  'quick_impl',
  '{"type":"object","properties":{}}'::jsonb,
  '{"type":"object","properties":{"status":{"type":"string"},"e2eUrl":{"type":["string","null"]},"durationMs":{"type":"integer"}}}'::jsonb,
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
