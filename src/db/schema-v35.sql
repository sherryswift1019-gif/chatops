-- v35: phase 3 T9-T15 — 逐步启用 7 个新 node type 的 executor。
--
-- v34 起 7 个新节点类型(http/dm/db_update/sql_query/file_read/template_render/fan_out)
-- 默认 enabled=FALSE。每完成一个对应 executor 实现(src/pipeline/node-types/<key>.ts),
-- 在此追加一行 UPDATE 把对应类型 enabled=TRUE,并 bump 末尾 DO $$ 断言期望 count。
--
-- T15 (fan_out) 在本文件追加 UPDATE 后启用,最终 7 + 5 phase-0 = 12 行 enabled。

-- T9: http
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'http';

-- T10: dm
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'dm';

-- T11: db_update
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'db_update';

-- T12: sql_query
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'sql_query';

-- T13: file_read
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'file_read';

-- T14: template_render
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'template_render';

-- T15: fan_out (NodeExecutor + Promise.all 子运行; v1 body 限非 interrupt 节点)
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'fan_out';

-- 断言: 12 行 enabled=TRUE (5 phase-0 + 7 phase-3 = http/dm/db_update/sql_query/file_read/template_render/fan_out)
DO $$
DECLARE
  v_enabled INT;
BEGIN
  SELECT COUNT(*) INTO v_enabled FROM pipeline_node_types WHERE enabled = TRUE;
  IF v_enabled <> 12 THEN
    RAISE EXCEPTION 'schema-v35: pipeline_node_types enabled 应有 12 行, 实际 %', v_enabled;
  END IF;
  RAISE NOTICE 'schema-v35: % enabled (T9-T15 7 个 executor + 5 phase-0)', v_enabled;
END $$;
