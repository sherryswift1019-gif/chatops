-- v44: switch node type + llm_agent outputFormat backfill + edge expression syntax normalization

-- 7.1 注册 switch 节点类型
INSERT INTO pipeline_node_types (key, display_name, description, category)
VALUES ('switch', 'Switch 分支', '按 cases 表达式路由到不同下游节点', 'flow')
ON CONFLICT (key) DO NOTHING;

-- 7.2 给现存 llm_agent 节点显式补 outputFormat='string'（graph.nodes[]）
UPDATE test_pipelines tp
   SET graph = (
     SELECT jsonb_set(tp.graph, '{nodes}', new_nodes)
     FROM (
       SELECT jsonb_agg(
         CASE WHEN n->>'stageType' = 'llm_agent' AND NOT (n ? 'outputFormat')
              THEN jsonb_set(n, '{outputFormat}', '"string"'::jsonb)
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
     WHERE n->>'stageType' = 'llm_agent' AND NOT (n ? 'outputFormat')
   );

-- 7.2 (cont) 同样扫旧 linear stages 字段
UPDATE test_pipelines tp
   SET stages = (
     SELECT jsonb_agg(
       CASE WHEN s->>'stageType' = 'llm_agent' AND NOT (s ? 'outputFormat')
            THEN jsonb_set(s, '{outputFormat}', '"string"'::jsonb)
            ELSE s
       END
     )
     FROM jsonb_array_elements(tp.stages) s
   )
 WHERE tp.stages IS NOT NULL
   AND jsonb_typeof(tp.stages) = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(tp.stages) s
     WHERE s->>'stageType' = 'llm_agent' AND NOT (s ? 'outputFormat')
   );

-- 7.3 edge.condition.expression 语法归一化（=== → ==、.includes(X) → contains X）
UPDATE test_pipelines tp
   SET graph = (
     SELECT jsonb_set(tp.graph, '{edges}', new_edges)
     FROM (
       SELECT jsonb_agg(
         CASE WHEN e->'condition'->>'kind' = 'expression'
              THEN jsonb_set(
                     e,
                     '{condition,expression}',
                     to_jsonb(
                       regexp_replace(
                         regexp_replace(
                           e->'condition'->>'expression',
                           '\.includes\(([^)]+)\)', ' contains \1', 'g'
                         ),
                         '===', '==', 'g'
                       )
                     )
                   )
              ELSE e
         END
       ) AS new_edges
       FROM jsonb_array_elements(tp.graph->'edges') e
     ) sub
   )
 WHERE tp.graph IS NOT NULL
   AND jsonb_typeof(tp.graph->'edges') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(tp.graph->'edges') e
     WHERE e->'condition'->>'kind' = 'expression'
       AND (e->'condition'->>'expression' LIKE '%===%'
            OR e->'condition'->>'expression' LIKE '%.includes(%')
   );
