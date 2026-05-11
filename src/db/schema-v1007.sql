-- v1007: register 'cleanup' node type — Pipeline Stage Types Sub-plan A (Task 2)
-- 资源清理节点：worktree / sandbox / bare_repo / remote_branch / draft_mr；
-- warn-but-continue 语义（局部失败不阻断流水线）。
-- 代码侧通过 registerNodeType 自注册，DB 必须同步登记，
-- 否则 server.ts:assertRegistryConsistent 启动时会抛
-- "Code only (likely missing migration; run pnpm migrate): cleanup"。

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'cleanup',
  '清理节点',
  '按 targets[] 列表清理资源（worktree/sandbox/bare_repo/remote_branch/draft_mr）；单个 target 失败不阻断其余',
  'flow',
  '{"type":"object","properties":{"targets":{"type":"array","items":{"type":"object"}}},"required":["targets"]}'::jsonb,
  '{"type":"object","properties":{"report":{"type":"object","properties":{"cleaned":{"type":"array"},"failed":{"type":"array"}}}}}'::jsonb,
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
