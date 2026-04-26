-- v35: phase 3 T9-T14 — 逐步启用 6 个新 simple node type 的 executor。
--
-- v34 起 7 个新节点类型(http/dm/db_update/sql_query/file_read/template_render/fan_out)
-- 默认 enabled=FALSE。每完成一个对应 executor 实现(src/pipeline/node-types/<key>.ts),
-- 在此追加一行 UPDATE 把对应类型 enabled=TRUE,并 bump 末尾 DO $$ 断言期望 count。
--
-- T15 (fan_out) 推迟到 phase 3 后续 batch；本文件最终启用 6 行 (5 phase-0 + 6 simple = 11)。

-- T9: http
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'http';

-- T10: dm
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'dm';

-- T11: db_update
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'db_update';

-- T12: sql_query
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'sql_query';

-- 断言: enabled = 9 (5 phase-0 + T9-T12)
DO $$
DECLARE
  v_enabled INT;
BEGIN
  SELECT COUNT(*) INTO v_enabled FROM pipeline_node_types WHERE enabled = TRUE;
  IF v_enabled <> 9 THEN
    RAISE EXCEPTION 'schema-v35: pipeline_node_types enabled 应有 9 行, 实际 %', v_enabled;
  END IF;
  RAISE NOTICE 'schema-v35: % enabled (T9-T12 + 5 phase-0; T13-T14 后续启用)', v_enabled;
END $$;
