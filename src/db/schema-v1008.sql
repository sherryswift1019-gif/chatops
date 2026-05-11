-- v1008: register 'git_commit_push' node type — Pipeline Stage Types Sub-plan A (Task 3)
-- 幂等 git commit + push 节点：无改动跳过 commit；HEAD 已同步 origin 跳过 push；支持 pushOnly 模式。
-- 代码侧通过 registerNodeType 自注册，DB 必须同步登记，
-- 否则 server.ts:assertRegistryConsistent 启动时会抛
-- "Code only (likely missing migration; run pnpm migrate): git_commit_push"。

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'git_commit_push',
  'Git Commit + Push',
  '幂等 git add → commit → push origin；无改动跳过 commit；HEAD 已同步 origin 跳过 push；支持 pushOnly 模式（dev_push 用）',
  'flow',
  '{"type":"object","properties":{"worktreePath":{"type":"string"},"branch":{"type":"string"},"artifactPaths":{"type":"array","items":{"type":"string"}},"commitMessage":{"type":"string","description":"Required unless pushOnly is true"},"pushOnly":{"type":"boolean"}},"required":["worktreePath","branch"]}'::jsonb,
  '{"type":"object","properties":{"commitSha":{"type":"string"},"pushedAt":{"type":"string"},"skipped":{"type":"boolean"}}}'::jsonb,
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
