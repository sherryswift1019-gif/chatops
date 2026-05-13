-- v1014: register llm_brainstorm node type for spec_brainstorm node (T19 / spec stage upgrade)
INSERT INTO pipeline_node_types (key, display_name, description, category, param_schema, output_schema)
VALUES (
  'llm_brainstorm',
  'LLM Brainstorm',
  'multi-round LLM clarification with user via IM/web interrupt',
  'llm',
  '{
    "type": "object",
    "properties": {
      "skill":        {"type":"string"},
      "role":         {"type":"string"},
      "maxRounds":    {"type":"integer","default":5},
      "timeoutMs":    {"type":"integer","default":86400000},
      "requirementId":{"type":"string"}
    },
    "required":["skill","role"]
  }'::jsonb,
  '{
    "type":"object",
    "properties":{
      "rounds":{"type":"integer"},
      "readyForSpec":{"type":"boolean"},
      "partial":{"type":"boolean"},
      "earlyDone":{"type":"boolean"},
      "enrichedInputPath":{"type":"string"},
      "brainstormPath":{"type":"string"}
    }
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
  description  = EXCLUDED.description,
  param_schema = EXCLUDED.param_schema,
  output_schema = EXCLUDED.output_schema;
