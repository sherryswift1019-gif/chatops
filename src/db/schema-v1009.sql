-- v1009: register 'llm_author' node type — Pipeline Stage Types Sub-plan A (Task 4)
-- LLM 生成 artifact（不 commit）节点：调一次 runSkill() 跑 author role，
-- 输出 artifactPath + skillOutput + round；commit 责任移交后续 git_commit_push 节点。
-- 代码侧通过 registerNodeType 自注册，DB 必须同步登记，
-- 否则 server.ts:assertRegistryConsistent 启动时会抛
-- "Code only (likely missing migration; run pnpm migrate): llm_author"。

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'llm_author',
  'LLM Author',
  'LLM 生成 artifact（不 commit）；调一次 runSkill() 跑 author role，输出 artifactPath + skillOutput + round；commit 责任移交后续 git_commit_push 节点',
  'llm',
  '{"type":"object","properties":{"requirementId":{"type":"number"},"skill":{"type":"string"},"role":{"type":"string"},"worktreePath":{"type":"string"},"branch":{"type":"string"},"baseBranch":{"type":"string","default":"main"},"artifactPath":{"type":"string"},"inputs":{"type":"object"},"specSources":{"type":"array","items":{"type":"string"}}},"required":["skill","role","worktreePath","branch","artifactPath"]}'::jsonb,
  '{"type":"object","properties":{"artifactPath":{"type":"string"},"skillOutput":{"type":"object"},"round":{"type":"number"}}}'::jsonb,
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
