-- v42: pipeline 解绑产线，新建 pipeline_bindings 关联表
-- 见 docs/superpowers/specs/2026-04-27-pipeline-product-line-decoupling-design.md §3.3

-- 1. pipeline_bindings 关联表
CREATE TABLE IF NOT EXISTS pipeline_bindings (
  product_line_id          INT      NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  ref_key                  TEXT     NOT NULL,
  pipeline_id              INT      NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  server_role_assignments  JSONB    NOT NULL DEFAULT '{}'::jsonb,
  description              TEXT     NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_line_id, ref_key)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_bindings_pipeline ON pipeline_bindings(pipeline_id);

-- 2. test_pipelines.product_line_id 改 NULLable + ON DELETE SET NULL
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'test_pipelines' AND constraint_name = 'test_pipelines_product_line_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE test_pipelines DROP CONSTRAINT test_pipelines_product_line_id_fkey';
  END IF;
END $$;

ALTER TABLE test_pipelines ALTER COLUMN product_line_id DROP NOT NULL;
ALTER TABLE test_pipelines ADD CONSTRAINT test_pipelines_product_line_id_fkey
  FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE SET NULL;

-- 3. 老 pipeline 自动建 binding（每条非 internal pipeline 一条）
--    server_roles count → server id 列表，按 server.id ASC 取前 N 台
DO $$
DECLARE
  rec RECORD;
  v_role TEXT;
  v_count INT;
  v_server_ids JSONB;
  v_assignments JSONB;
BEGIN
  FOR rec IN
    SELECT p.id, p.product_line_id, p.name, p.server_roles
    FROM test_pipelines p
    WHERE p.product_line_id IS NOT NULL
      AND p.id NOT IN (SELECT pipeline_id FROM internal_capability_pipelines)
  LOOP
    v_assignments := '{}'::jsonb;
    IF rec.server_roles IS NOT NULL AND rec.server_roles != '{}'::jsonb THEN
      FOR v_role, v_count IN SELECT * FROM jsonb_each_text(rec.server_roles) LOOP
        SELECT COALESCE(jsonb_agg(s.id::text ORDER BY s.id), '[]'::jsonb)
          INTO v_server_ids
        FROM (
          SELECT id FROM test_servers
          WHERE product_line_id = rec.product_line_id AND role = v_role
          ORDER BY id ASC LIMIT v_count::int
        ) s;
        v_assignments := v_assignments || jsonb_build_object(v_role, v_server_ids);
        RAISE NOTICE 'v42 migrate: pipeline=% role=% count=% picked=%',
                     rec.id, v_role, v_count, v_server_ids;
      END LOOP;
    END IF;

    INSERT INTO pipeline_bindings (
      product_line_id, ref_key, pipeline_id, server_role_assignments, description
    )
    VALUES (
      rec.product_line_id,
      CASE rec.name
        WHEN 'L1-配置类'   THEN 'fix_bug_l1'
        WHEN 'L2-代码缺陷' THEN 'fix_bug_l2'
        WHEN 'L3-业务逻辑' THEN 'fix_bug_l3'
        WHEN 'L4-复杂问题' THEN 'fix_bug_l4'
        ELSE rec.name
      END,
      rec.id,
      v_assignments,
      '从 schema-v3 ~ v41 自动迁移'
    )
    ON CONFLICT (product_line_id, ref_key) DO NOTHING;
  END LOOP;
END $$;

-- 4. internal pipeline 解绑产线（保持「全局共享」语义，不建 binding）
UPDATE test_pipelines
SET product_line_id = NULL
WHERE id IN (SELECT pipeline_id FROM internal_capability_pipelines);

-- 5. test_pipelines.schedule DROP（scheduler 模块删除）
ALTER TABLE test_pipelines DROP COLUMN IF EXISTS schedule;

-- 6. test_pipelines.server_roles 标 deprecated（不删，阶段 4 才 DROP）
COMMENT ON COLUMN test_pipelines.server_roles IS
  'DEPRECATED v42: server 分配迁到 pipeline_bindings.server_role_assignments。本字段保留兼容老 pipeline，新 pipeline 应填空对象。阶段 4 删除。';

-- 7. 断言：每条非 internal 的产线绑定 pipeline 都有 binding
DO $$
DECLARE
  v_pipeline_count INT;
  v_binding_count INT;
BEGIN
  SELECT COUNT(*) INTO v_pipeline_count
  FROM test_pipelines
  WHERE product_line_id IS NOT NULL
    AND id NOT IN (SELECT pipeline_id FROM internal_capability_pipelines);
  SELECT COUNT(*) INTO v_binding_count FROM pipeline_bindings;
  IF v_pipeline_count != v_binding_count THEN
    RAISE EXCEPTION 'v42 migrate: pipeline count mismatch (% pipelines vs % bindings)',
                    v_pipeline_count, v_binding_count;
  END IF;
END $$;
