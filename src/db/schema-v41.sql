-- v41: phase 4 T4 — create_mr handler 迁移为 4 节点 pipeline DAG
-- 见 spec §6.5 / 主 plan §G(T4)
--
-- 本迁移目标:
--   1) CREATE FUNCTION build_mr_description / build_mr_title (PL/pgSQL)
--      —— 把 mr-handler.ts 里 buildMrDescription / buildMrTitle 文案拼接逻辑搬到 SQL 层
--   2) 在 test_pipelines 中种入 'create-mr-internal' pipeline (4 节点 DAG):
--      compute_mr_plan (sql_query) → fan_out_create_mrs (fan_out, parallel=1) →
--      write_success_events (db_update) → write_failed_events (db_update)
--   3) 把 'create_mr' 注册到 internal_capability_pipelines 映射表
--
-- 节点类型 (sql_query / fan_out / http / db_update) 由 phase 3 (schema-v34/v35) 引入并启用。
-- http executor (phase 4 T4): 内部 resolveVariables 解析 fan_out scope 引用 (与 dm 节点同模式)。
--
-- 幂等 (与 handler 行为对齐):
--   compute_mr_plan SQL 用 LEFT JOIN 排除已有 success create_mr 的 project ——
--   plan rows 不含已存在 MR 的项, fan_out 完全不调它的 API。
--   handler 路径在 results 里 push skipped=true 项, pipeline 路径不出现 ——
--   仅影响 output 字符串 (KD-NEW), side effects 严格对等。

-- ============================================================
-- 1. build_mr_description 函数 — 主仓库 vs 从仓库 description 拼接
-- ============================================================
--
-- 与 src/agent/mr/mr-handler.ts:136-156 (buildMrDescription) 严格对齐。
--
-- 参数:
--   p_is_primary             — 是否主仓库 (即 project_path == primary_project_path)
--   p_main_issue_iid         — 主 Issue iid (来自 create_issue 事件 data.issueIid)
--   p_primary_project_path   — 主仓库 path (用于从仓库的 'Related to xxx#yyy')
--   p_multi_project_count    — 当前 MR 计划数 (>1 时加多 project warning)
--
-- 返回: TEXT —— 完整 MR description, 换行用 E'\n', 与 buildMrDescription join('\n') 对齐

CREATE OR REPLACE FUNCTION build_mr_description(
  p_is_primary           BOOLEAN,
  p_main_issue_iid       INTEGER,
  p_primary_project_path TEXT,
  p_multi_project_count  INTEGER
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $func$
DECLARE
  v_out TEXT;
BEGIN
  v_out := '';
  IF p_multi_project_count > 1 THEN
    v_out := v_out ||
             '⚠️ 此修复涉及 ' || p_multi_project_count::TEXT || ' 个服务，请协调各 MR 的合并顺序。' || E'\n' ||
             '主仓库 MR 合并后会关闭 Issue；请优先合并主仓库 MR。' || E'\n' ||
             E'\n';
  END IF;
  IF p_is_primary THEN
    v_out := v_out || 'Closes #' || p_main_issue_iid::TEXT;
  ELSE
    v_out := v_out || 'Related to ' || COALESCE(p_primary_project_path, '') || '#' || p_main_issue_iid::TEXT;
  END IF;
  v_out := v_out || E'\n' || E'\n' || '本 MR 由 ChatOps AI 助手自动创建。';
  RETURN v_out;
END;
$func$;

COMMENT ON FUNCTION build_mr_description IS
  'phase 4 T4 — create_mr MR description 拼接 (与 src/agent/mr/mr-handler.ts:buildMrDescription 严格对齐)。仅文案；业务判定在外层 sql_query CTE 完成。';

-- ============================================================
-- 2. build_mr_title 函数 — `[<LEVEL>] <summary 60 字> (<projectPath>)`
-- ============================================================
--
-- 与 src/agent/mr/mr-handler.ts:158-161 (buildMrTitle) 严格对齐:
--   const summary = (report.rootCauseSummary ?? 'Bug 修复').trim().replace(/\n+/g, ' ').slice(0, 60)
--   `[${report.level.toUpperCase()}] ${summary} (${projectPath})`

CREATE OR REPLACE FUNCTION build_mr_title(
  p_level              TEXT,
  p_root_cause_summary TEXT,
  p_project_path       TEXT
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $func$
DECLARE
  v_summary TEXT;
BEGIN
  -- COALESCE 兜底 'Bug 修复' (与 ?? 'Bug 修复' 等价)
  v_summary := COALESCE(NULLIF(p_root_cause_summary, ''), 'Bug 修复');
  -- trim + 把所有连续的换行换成单个空格 (与 .trim().replace(/\n+/g, ' ') 等价)
  v_summary := regexp_replace(btrim(v_summary), E'\n+', ' ', 'g');
  -- 截 60 字 (与 .slice(0, 60) 等价)
  v_summary := LEFT(v_summary, 60);
  RETURN format('[%s] %s (%s)', upper(p_level), v_summary, p_project_path);
END;
$func$;

COMMENT ON FUNCTION build_mr_title IS
  'phase 4 T4 — create_mr MR title 拼接 (与 src/agent/mr/mr-handler.ts:buildMrTitle 严格对齐)。';

-- ============================================================
-- 3. create-mr-internal pipeline (4 节点 DAG)
-- ============================================================

DO $$
DECLARE
  v_pipeline_id INTEGER;
  v_pl_id       INTEGER;
BEGIN
  -- 跳过如已存在
  IF EXISTS (SELECT 1 FROM test_pipelines WHERE name='create-mr-internal') THEN
    SELECT id INTO v_pipeline_id FROM test_pipelines WHERE name='create-mr-internal';
    RAISE NOTICE 'schema-v41: create-mr-internal pipeline 已存在 id=%', v_pipeline_id;
  ELSE
    -- 选最小 id 的产线作为 internal pipeline 的承载体（与 schema-v37/v40 同模式）
    SELECT id INTO v_pl_id FROM product_lines ORDER BY id LIMIT 1;
    IF v_pl_id IS NULL THEN
      RAISE NOTICE 'schema-v41: no product_lines, skip seeding create-mr-internal pipeline';
      RETURN;
    END IF;

    INSERT INTO test_pipelines (
      product_line_id, name, description, graph, trigger_params, enabled,
      server_roles, schedule, variables, stages
    )
    VALUES (
      v_pl_id,
      'create-mr-internal',
      'phase 4 T4: create_mr handler 迁移 — 4 节点 DAG (sql_query → fan_out → db_update × 2)',
      $graph$
      {
        "nodes": [
          {
            "id": "compute_mr_plan",
            "stageType": "sql_query",
            "position": {"x": 100, "y": 100},
            "params": {
              "sqlTemplate": "WITH report AS (SELECT id, level, root_cause_summary, primary_project_path FROM bug_analysis_reports WHERE id = {{triggerParams.reportId}}), primary_issue AS (SELECT (data->>'issueIid')::int AS issue_iid, COALESCE(project_path, (SELECT primary_project_path FROM report)) AS primary_path FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND code = 'create_issue' AND (data->>'isPrimary')::boolean = true ORDER BY id DESC LIMIT 1), fix_attempts AS (SELECT DISTINCT ON (project_path) project_path, status, data FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND code = 'fix_attempt' ORDER BY project_path, id DESC), success_fixes AS (SELECT fa.project_path, COALESCE(fa.data->>'branch', '') AS source_branch, COALESCE(fa.data->>'targetBranch', 'master') AS target_branch, (fa.project_path = (SELECT primary_path FROM primary_issue)) AS is_primary FROM fix_attempts fa WHERE fa.status = 'success'), existing_mrs AS (SELECT DISTINCT ON (project_path) project_path FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND code = 'create_mr' AND status = 'success' ORDER BY project_path, id DESC), planned AS (SELECT sf.project_path, sf.source_branch, sf.target_branch, sf.is_primary FROM success_fixes sf LEFT JOIN existing_mrs em ON em.project_path = sf.project_path WHERE em.project_path IS NULL AND EXISTS (SELECT 1 FROM primary_issue)), plan_count AS (SELECT count(*)::int AS n FROM planned) SELECT p.project_path, p.source_branch, p.target_branch, p.is_primary, build_mr_title((SELECT level FROM report), (SELECT root_cause_summary FROM report), p.project_path) AS mr_title, build_mr_description(p.is_primary, (SELECT issue_iid FROM primary_issue), (SELECT primary_path FROM primary_issue), (SELECT n FROM plan_count)) AS mr_description FROM planned p ORDER BY p.is_primary DESC, p.project_path"
            }
          },
          {
            "id": "fan_out_create_mrs",
            "stageType": "fan_out",
            "position": {"x": 100, "y": 220},
            "params": {
              "source": "{{steps.compute_mr_plan.output.rows}}",
              "as": "proj",
              "parallel": 1,
              "onItemFailure": "continue",
              "body": [
                {
                  "id": "create_mr_call",
                  "nodeTypeKey": "http",
                  "params": {
                    "method": "POST",
                    "url": "{{vars.gitlabUrl}}/api/v4/projects/{{proj.project_path | urlEncode}}/merge_requests",
                    "headers": {"PRIVATE-TOKEN": "{{vars.gitlabToken}}", "Content-Type": "application/json"},
                    "body": {
                      "source_branch": "{{proj.source_branch}}",
                      "target_branch": "{{proj.target_branch}}",
                      "title": "{{proj.mr_title}}",
                      "description": "{{proj.mr_description}}",
                      "labels": "ai-generated",
                      "remove_source_branch": false
                    },
                    "extraMeta": {
                      "projectPath": "{{proj.project_path}}",
                      "branch": "{{proj.source_branch}}",
                      "isPrimary": "{{proj.is_primary}}"
                    }
                  }
                }
              ]
            }
          },
          {
            "id": "write_success_events",
            "stageType": "db_update",
            "position": {"x": 100, "y": 340},
            "params": {
              "sqlTemplate": "INSERT INTO bug_fix_events (report_id, project_path, code, status, data) SELECT {{triggerParams.reportId}}, item->'extraMeta'->>'projectPath', 'create_mr', 'success', jsonb_build_object('mrIid', (item->'body'->>'iid')::int, 'mrUrl', item->'body'->>'web_url', 'branch', item->'extraMeta'->>'branch', 'isPrimary', (item->'extraMeta'->>'isPrimary')::boolean) FROM jsonb_array_elements('{{steps.fan_out_create_mrs.output.items | jsonStringify}}'::jsonb) item"
            }
          },
          {
            "id": "write_failed_events",
            "stageType": "db_update",
            "position": {"x": 100, "y": 460},
            "params": {
              "sqlTemplate": "INSERT INTO bug_fix_events (report_id, project_path, code, status, data) SELECT {{triggerParams.reportId}}, f->'item'->>'project_path', 'create_mr', 'failed', jsonb_build_object('error', f->>'error', 'branch', f->'item'->>'source_branch', 'isPrimary', (f->'item'->>'is_primary')::boolean) FROM jsonb_array_elements('{{steps.fan_out_create_mrs.output.failed | jsonStringify}}'::jsonb) f"
            }
          }
        ],
        "edges": [
          {"id": "e1", "source": "compute_mr_plan",      "target": "fan_out_create_mrs"},
          {"id": "e2", "source": "fan_out_create_mrs",   "target": "write_success_events"},
          {"id": "e3", "source": "write_success_events", "target": "write_failed_events"}
        ]
      }
      $graph$::jsonb,
      '{"reportId":{"type":"integer","required":true}}'::jsonb,
      TRUE,
      '{}'::jsonb,
      '',
      '{}'::jsonb,
      '[]'::jsonb
    )
    RETURNING id INTO v_pipeline_id;
    RAISE NOTICE 'schema-v41: create-mr-internal pipeline 创建 id=%', v_pipeline_id;
  END IF;

  -- 注册到 internal_capability_pipelines
  INSERT INTO internal_capability_pipelines (capability_key, pipeline_id)
  VALUES ('create_mr', v_pipeline_id)
  ON CONFLICT (capability_key) DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id;
END $$;

-- 断言: create_mr 必须存在于 internal_capability_pipelines（仅当 product_lines 非空时）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM product_lines) AND NOT EXISTS (
    SELECT 1 FROM internal_capability_pipelines WHERE capability_key='create_mr'
  ) THEN
    RAISE EXCEPTION 'schema-v41: create_mr 未注册到 internal_capability_pipelines';
  END IF;
END $$;
