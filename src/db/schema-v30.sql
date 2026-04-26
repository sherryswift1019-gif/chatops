-- v30: pipeline_node_types 节点类型注册表
-- 节点类型元信息在 DB（display_name / param_schema / output_schema），
-- 执行器在代码（src/pipeline/node-types/<key>.ts 通过 registerNodeType() 注册）。
-- 启动时一致性检查：DB enabled 行 ↔ 代码 register 调用必须一致。

CREATE TABLE IF NOT EXISTS pipeline_node_types (
  key             TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL CHECK (category IN ('general','flow','llm','specialized')),
  param_schema    JSONB NOT NULL DEFAULT '{}',
  output_schema   JSONB NOT NULL DEFAULT '{}',
  is_system       BOOLEAN NOT NULL DEFAULT TRUE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 种子数据：现有 5 种 stage type 迁入注册表
-- v1 仅做"注册"，不改变 pipeline 引擎行为；阶段 3 才会扩展节点类型
INSERT INTO pipeline_node_types (key, display_name, description, category, param_schema, output_schema)
VALUES
  ('script', 'SSH 脚本', 'SSH 远程脚本执行', 'general',
    '{"type":"object","properties":{"commands":{"type":"string","format":"textarea"},"script":{"type":"string"},"targetServers":{"type":"array","items":{"type":"string"}}}}'::jsonb,
    '{"type":"object","properties":{"exitCode":{"type":"number"},"stdout":{"type":"string"},"stderr":{"type":"string"}}}'::jsonb),
  ('approval', '人工审批', '人工审批节点（IM 卡片或 Web 按钮）', 'flow',
    '{"type":"object","properties":{"approverIds":{"type":"array","items":{"type":"string"}},"approverIdsResolver":{"type":"string"},"approvalDescription":{"type":"string","format":"textarea"}}}'::jsonb,
    '{"type":"object","properties":{"decision":{"type":"string","enum":["approved","rejected","timeout"]},"approver":{"type":"string"},"comment":{"type":"string"}}}'::jsonb),
  ('capability', 'LLM Agent (capability)', '触发某 capability 的 LLM agent 节点', 'llm',
    '{"type":"object","properties":{"capabilityKey":{"type":"string","x-source":"capabilities"},"capabilityParams":{"type":"object"}}}'::jsonb,
    '{"type":"object","properties":{"text":{"type":"string"}}}'::jsonb),
  ('wait_webhook', '等待 webhook', '等外部 webhook 回调', 'flow',
    '{"type":"object","properties":{"webhookTag":{"type":"string"},"timeoutSeconds":{"type":"number"}}}'::jsonb,
    '{"type":"object","properties":{"payload":{"type":"object"}}}'::jsonb),
  ('im_input', 'IM 参数采集', '通过 IM 多轮对话采集参数', 'flow',
    '{"type":"object","properties":{"prompt":{"type":"string"},"paramSchema":{"type":"object"},"capabilityKey":{"type":"string","x-source":"capabilities"}}}'::jsonb,
    '{"type":"object","properties":{"runtimeVars":{"type":"object"}}}'::jsonb)
ON CONFLICT (key) DO NOTHING;
