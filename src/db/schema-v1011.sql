-- v1011: register 'human_gate' node type — Pipeline Stage Types Sub-plan A (Task 6)
-- 人工 binary 批准节点（interrupt-bound）：push IM/Web 卡片，调 LangGraph interrupt()
-- 等审，source ∈ {ai_pass, ai_escalation, final} 决定渲染细节；
-- 代码侧通过 registerNodeType 自注册，DB 必须同步登记，
-- 否则 server.ts:assertRegistryConsistent 启动时会抛
-- "Code only (likely missing migration; run pnpm migrate): human_gate"。

INSERT INTO pipeline_node_types
  (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
VALUES (
  'human_gate',
  'Human Gate',
  '人工 binary 批准节点（interrupt-bound）；push IM/Web 卡片等审；source=ai_pass 时直接放行，source=ai_escalation/final 时等人工决策；输出 decision (approved/rejected) + humanNotes + source',
  'flow',
  '{"type":"object","properties":{"requirementId":{"type":"number"},"approverIds":{"type":"string","description":"逗号分隔的审批人 ID 列表"},"mode":{"type":"string","enum":["required","on_fail"],"default":"required","description":"required=无条件等人审；on_fail=仅 ai_review fail 时等"},"source":{"type":"string","enum":["ai_pass","ai_escalation","final"],"default":"final","description":"来源上下文，决定 IM 卡片渲染细节"},"timeoutSeconds":{"type":"number","default":86400},"onTimeout":{"type":"string","enum":["reject","approve"],"default":"reject"},"artifactPath":{"type":"string"},"aiReviewNotes":{"type":"string"},"contextSummary":{"type":"string"},"inputs":{"type":"object"}},"required":["requirementId","approverIds"]}'::jsonb,
  '{"type":"object","properties":{"decision":{"type":"string","enum":["approved","rejected"]},"humanNotes":{"type":"string"},"source":{"type":"string","enum":["ai_pass","ai_escalation","final"]},"decidedBy":{"type":"string"},"decidedAt":{"type":"string"}}}'::jsonb,
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
