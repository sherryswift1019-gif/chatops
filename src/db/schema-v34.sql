-- v34: phase 3 — 7 个新节点类型 INSERT 到 pipeline_node_types
-- 现有 5 种(script/approval/capability/wait_webhook/im_input)从 v30 起就在;
-- 新增 7 种,共 12 种。spec §4.1 节点类型清单。
--
-- enabled = FALSE: phase 3 各 task (T9-T15) 实现对应 executor 后,
-- 通过 UPDATE pipeline_node_types SET enabled=TRUE WHERE key='...'
-- 启用各类型。完成 phase 3 后,所有 12 行 enabled=TRUE。

INSERT INTO pipeline_node_types (key, display_name, description, category, param_schema, output_schema, enabled)
VALUES
  ('http', 'HTTP 调用', '发起 HTTP 请求', 'general',
    '{"type":"object","required":["method","url"],"properties":{"method":{"type":"string","enum":["GET","POST","PUT","DELETE","PATCH"]},"url":{"type":"string"},"headers":{"type":"object"},"body":{"type":"object"},"timeoutMs":{"type":"number","default":30000}}}'::jsonb,
    '{"type":"object","properties":{"statusCode":{"type":"number"},"headers":{"type":"object"},"body":{"type":"object"}}}'::jsonb,
    FALSE),

  ('dm', 'IM 私聊', '通过 IM adapter 发私聊消息', 'general',
    '{"type":"object","required":["platform","userId"],"properties":{"platform":{"type":"string","enum":["dingtalk","feishu"]},"userId":{"type":"string"},"text":{"type":"string"},"card":{"type":"object"}}}'::jsonb,
    '{"type":"object","properties":{"messageId":{"type":"string"},"deliveredAt":{"type":"string"}}}'::jsonb,
    FALSE),

  ('db_update', 'DB 写入', '内部 DB 写入(支持变量插值)', 'general',
    '{"type":"object","required":["sqlTemplate"],"properties":{"sqlTemplate":{"type":"string","format":"textarea"},"params":{"type":"array"}}}'::jsonb,
    '{"type":"object","properties":{"rowsAffected":{"type":"number"}}}'::jsonb,
    FALSE),

  ('sql_query', 'DB 查询', '内部 DB 查询(返回 rows 数组)', 'general',
    '{"type":"object","required":["sqlTemplate"],"properties":{"sqlTemplate":{"type":"string","format":"textarea"},"params":{"type":"array"}}}'::jsonb,
    '{"type":"object","properties":{"rows":{"type":"array"}}}'::jsonb,
    FALSE),

  ('file_read', '文件读取', '读取远程或本地文件内容', 'general',
    '{"type":"object","required":["path"],"properties":{"target":{"type":"string","description":"local 或 ssh server name"},"path":{"type":"string"},"maxBytes":{"type":"number","default":1048576}}}'::jsonb,
    '{"type":"object","properties":{"content":{"type":"string"},"size":{"type":"number"}}}'::jsonb,
    FALSE),

  ('template_render', '模板渲染', '字符串模板渲染(为下游 description / sqlTemplate 用)', 'general',
    '{"type":"object","required":["template"],"properties":{"template":{"type":"string","format":"textarea"},"vars":{"type":"object"}}}'::jsonb,
    '{"type":"object","properties":{"text":{"type":"string"}}}'::jsonb,
    FALSE),

  ('fan_out', '数组扇出', '把上游数组扇成多个并行子运行', 'flow',
    '{"type":"object","required":["source","as","body"],"properties":{"source":{"type":"string","description":"如 {{steps.x.output.items}}"},"as":{"type":"string"},"parallel":{"type":"number","default":3},"onItemFailure":{"type":"string","enum":["continue","stop","aggregate"],"default":"continue"},"body":{"type":"array","items":{"type":"string"}}}}'::jsonb,
    '{"type":"object","properties":{"items":{"type":"array"},"failed":{"type":"array"}}}'::jsonb,
    FALSE)
ON CONFLICT (key) DO NOTHING;

-- 断言: pipeline_node_types 总行数 = 12 (5 phase 0 + 7 phase 3)
DO $$
DECLARE
  v_count INT;
  v_enabled INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pipeline_node_types;
  SELECT COUNT(*) INTO v_enabled FROM pipeline_node_types WHERE enabled = TRUE;
  IF v_count <> 12 THEN
    RAISE EXCEPTION 'schema-v34: pipeline_node_types 应有 12 行,实际 %', v_count;
  END IF;
  RAISE NOTICE 'schema-v34: 12 节点类型注册完成 (% 已启用; T9-T15 将逐个启用其余 %)', v_enabled, 12 - v_enabled;
END $$;
