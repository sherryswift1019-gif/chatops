-- v1010: register 'llm_review' node type — Pipeline Stage Types Sub-plan A (Task 5)
-- LLM 审 artifact 节点：调一次 runSkill() 跑 reviewer role，
-- 输出 decision (pass/fail) + notes (string) + specCoverage + round。
-- 代码侧通过 registerNodeType 自注册，DB 必须同步登记，
-- 否则 server.ts:assertRegistryConsistent 启动时会抛
-- "Code only (likely missing migration; run pnpm migrate): llm_review"。

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'llm_review',
  'LLM Review',
  'LLM 审 artifact；调一次 runSkill() 跑 reviewer role，输出 decision (pass/fail) + notes (string) + specCoverage + round；decision=fail 时通过 graph 边路由表达，节点本身 status 永远 success',
  'llm',
  '{"type":"object","properties":{"requirementId":{"type":"number"},"skill":{"type":"string"},"role":{"type":"string"},"worktreePath":{"type":"string"},"branch":{"type":"string"},"baseBranch":{"type":"string","default":"main"},"artifactPath":{"type":"string"},"inputs":{"type":"object"},"specSources":{"type":"array","items":{"type":"string"}}},"required":["skill","role","worktreePath","branch","artifactPath"]}'::jsonb,
  '{"type":"object","properties":{"decision":{"type":"string","enum":["pass","fail"]},"notes":{"type":"string"},"specCoverage":{"type":"array"},"round":{"type":"number"}}}'::jsonb,
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
