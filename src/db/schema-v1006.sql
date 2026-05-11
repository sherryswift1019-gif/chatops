-- v1006: register 'end' node type — Pipeline Stage Types Sub-plan A (Task 1)
-- 显式 END sink 节点：代码侧通过 registerNodeType 自注册，DB 必须同步登记，
-- 否则 server.ts:assertRegistryConsistent 启动时会抛
-- "Code only (likely missing migration; run pnpm migrate): end"。

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'end',
  '结束节点',
  '显式终止 pipeline 执行，无副作用；下游接 LangGraph END',
  'flow',
  '{"type":"object","properties":{}}'::jsonb,
  '{"type":"object","properties":{"terminated":{"type":"boolean"}}}'::jsonb,
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
