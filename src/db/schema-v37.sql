-- v37: phase 4 — internal_capability_pipelines 过渡表 + L1 (request_handover) pipeline 种子
-- 见 spec §6.5 / 主 plan §E
--
-- 本迁移目标:
--   1) 建 internal_capability_pipelines 表 (capability_key → pipeline_id 的过渡映射)
--   2) 在 test_pipelines 中种入 L1 'handover-internal' pipeline (5 节点 DAG)
--   3) 把 'request_handover' 注册到映射表
--
-- 节点类型 (sql_query / http / db_update) + 模板语法 ({{steps.x.output.rows[0]...}} +
-- urlEncode 过滤器 + shortCircuitWhen) 均由 phase 3 (schema-v34/v35) 引入并启用。
--
-- 幂等保护: pipeline 用名字守门, 映射表用 ON CONFLICT。

CREATE TABLE IF NOT EXISTS internal_capability_pipelines (
  capability_key  TEXT PRIMARY KEY,
  pipeline_id     INTEGER NOT NULL REFERENCES test_pipelines(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- L1: request_handover pipeline (5 节点 DAG: idempotency_check → load_report → gitlab_label → write_event → update_status)
DO $$
DECLARE
  v_pipeline_id INTEGER;
  v_pl_id       INTEGER;
BEGIN
  -- 跳过如已存在
  IF EXISTS (SELECT 1 FROM test_pipelines WHERE name='handover-internal') THEN
    SELECT id INTO v_pipeline_id FROM test_pipelines WHERE name='handover-internal';
    RAISE NOTICE 'schema-v37: handover-internal pipeline 已存在 id=%', v_pipeline_id;
  ELSE
    -- 选最小 id 的产线作为 internal pipeline 的承载体 (与 schema-v19 的 deploy-im-demo 同模式)
    -- internal pipeline 不依赖产线业务逻辑, 仅满足 test_pipelines.product_line_id NOT NULL 约束。
    SELECT id INTO v_pl_id FROM product_lines ORDER BY id LIMIT 1;
    IF v_pl_id IS NULL THEN
      RAISE NOTICE 'schema-v37: no product_lines, skip seeding handover-internal pipeline';
      RETURN;
    END IF;

    INSERT INTO test_pipelines (
      product_line_id, name, description, graph, trigger_params, enabled,
      server_roles, variables, stages
    )
    VALUES (
      v_pl_id,
      'handover-internal',
      'phase 4: request_handover handler 迁移 — 5 节点 DAG',
      $graph$
      {
        "nodes": [
          {
            "id": "idempotency_check",
            "stageType": "sql_query",
            "position": {"x": 100, "y": 100},
            "params": {
              "sqlTemplate": "SELECT 1 FROM bug_fix_events WHERE report_id={{triggerParams.reportId}} AND code='handover' AND status='success' LIMIT 1",
              "shortCircuitWhen": "steps.idempotency_check.output.rows.length > 0"
            }
          },
          {
            "id": "load_report",
            "stageType": "sql_query",
            "position": {"x": 100, "y": 220},
            "params": {
              "sqlTemplate": "SELECT issue_id, primary_project_path FROM bug_analysis_reports WHERE id={{triggerParams.reportId}}"
            }
          },
          {
            "id": "gitlab_label",
            "stageType": "http",
            "position": {"x": 100, "y": 340},
            "onFailure": "continue",
            "params": {
              "method": "POST",
              "url": "{{vars.gitlabUrl}}/api/v4/projects/{{steps.load_report.output.rows[0].primary_project_path | urlEncode}}/issues/{{steps.load_report.output.rows[0].issue_id}}/labels",
              "headers": {"PRIVATE-TOKEN": "{{vars.gitlabToken}}"},
              "body": {"labels": "needs-manual"}
            }
          },
          {
            "id": "write_event",
            "stageType": "db_update",
            "position": {"x": 100, "y": 460},
            "params": {
              "sqlTemplate": "INSERT INTO bug_fix_events (report_id, code, status, project_path, data) VALUES ({{triggerParams.reportId}}, 'handover', 'success', '{{steps.load_report.output.rows[0].primary_project_path}}', '{\"reason\":\"{{triggerParams.reason}}\"}'::jsonb)"
            }
          },
          {
            "id": "update_status",
            "stageType": "db_update",
            "position": {"x": 100, "y": 580},
            "params": {
              "sqlTemplate": "UPDATE bug_analysis_reports SET status='pending_manual', updated_at=NOW() WHERE id={{triggerParams.reportId}}"
            }
          }
        ],
        "edges": [
          {"id": "e1", "source": "idempotency_check", "target": "load_report"},
          {"id": "e2", "source": "load_report",       "target": "gitlab_label"},
          {"id": "e3", "source": "gitlab_label",      "target": "write_event"},
          {"id": "e4", "source": "write_event",       "target": "update_status"}
        ]
      }
      $graph$::jsonb,
      '{"reportId":{"type":"integer","required":true},"reason":{"type":"string","required":true}}'::jsonb,
      TRUE,
      '{}'::jsonb,
      '{}'::jsonb,
      '[]'::jsonb
    )
    RETURNING id INTO v_pipeline_id;
    RAISE NOTICE 'schema-v37: handover-internal pipeline 创建 id=%', v_pipeline_id;
  END IF;

  -- 注册到 internal_capability_pipelines
  INSERT INTO internal_capability_pipelines (capability_key, pipeline_id)
  VALUES ('request_handover', v_pipeline_id)
  ON CONFLICT (capability_key) DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id;
END $$;

-- 断言: request_handover 必须存在于 internal_capability_pipelines
-- (跳过 product_lines 为空导致未种 pipeline 的场景 —— 此场景不会注册 mapping)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM product_lines) AND NOT EXISTS (
    SELECT 1 FROM internal_capability_pipelines WHERE capability_key='request_handover'
  ) THEN
    RAISE EXCEPTION 'schema-v37: request_handover 未注册到 internal_capability_pipelines';
  END IF;
END $$;
