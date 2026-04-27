-- v36: capability node type → llm_agent rename
-- spec §3.5 / phase 3 plan T17
--
-- 把 pipeline_node_types.key='capability' 重命名为 'llm_agent';
-- 同时把 test_pipelines.graph (JSONB) 和 test_pipelines.stages (JSONB)
-- 里所有 stageType='capability' 的节点改名 llm_agent。
--
-- 本迁移幂等：用 WHERE EXISTS 守门,已经迁过则不动。
-- DDL 完成后断言 pipeline_node_types 不再有 'capability' key。

-- (a) Rename pipeline_node_types row
UPDATE pipeline_node_types
   SET key='llm_agent',
       display_name='LLM Agent',
       description='调用某 capability 的 LLM agent 节点'
 WHERE key='capability';

-- (b) Rename test_pipelines.graph nodes referencing 'capability'
UPDATE test_pipelines tp
   SET graph = (
     SELECT jsonb_set(tp.graph, '{nodes}', new_nodes)
     FROM (
       SELECT jsonb_agg(
         CASE WHEN n->>'stageType' = 'capability'
              THEN jsonb_set(n, '{stageType}', '"llm_agent"'::jsonb)
              ELSE n
         END
       ) AS new_nodes
       FROM jsonb_array_elements(tp.graph->'nodes') n
     ) sub
   )
 WHERE tp.graph IS NOT NULL
   AND jsonb_typeof(tp.graph->'nodes') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(tp.graph->'nodes') n
     WHERE n->>'stageType' = 'capability'
   );

-- (c) Rename test_pipelines.stages (legacy linear stages array)
UPDATE test_pipelines tp
   SET stages = (
     SELECT jsonb_agg(
       CASE WHEN s->>'stageType' = 'capability'
            THEN jsonb_set(s, '{stageType}', '"llm_agent"'::jsonb)
            ELSE s
       END
     )
     FROM jsonb_array_elements(tp.stages) s
   )
 WHERE tp.stages IS NOT NULL
   AND jsonb_typeof(tp.stages) = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(tp.stages) s
     WHERE s->>'stageType' = 'capability'
   );

-- 断言: pipeline_node_types 不再有 'capability' key
DO $$
DECLARE v_old INT;
BEGIN
  SELECT COUNT(*) INTO v_old FROM pipeline_node_types WHERE key='capability';
  IF v_old > 0 THEN
    RAISE EXCEPTION 'schema-v36: capability key 应被重命名,实际仍有 % 行', v_old;
  END IF;
  RAISE NOTICE 'schema-v36: capability → llm_agent 重命名完成';
END $$;
