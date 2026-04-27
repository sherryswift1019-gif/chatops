-- v40: phase 4 T3 — notify_bug handler 迁移为 5 节点 pipeline DAG
-- 见 spec §6.5 / 主 plan §G / design 笔记 docs/superpowers/specs/2026-04-27-phase4-t3-notify-design.md
--
-- 本迁移目标:
--   1) CREATE FUNCTION build_notify_message —— 把 4 种 scenario 文案拼接逻辑封装到 PL/pgSQL
--   2) 在 test_pipelines 中种入 'notify-internal' pipeline (5 节点 DAG)
--   3) 把 'notify_bug' 注册到 internal_capability_pipelines 映射表
--
-- 节点类型 (sql_query / fan_out / dm / db_update) 由 phase 3 (schema-v34/v35) 引入并启用。
-- dm 节点新增 extraMeta 透传字段 (phase 4 T3 在 src/pipeline/node-types/dm.ts 实现)。
--
-- 幂等保护: pipeline 用名字守门, function CREATE OR REPLACE, 映射表用 ON CONFLICT。

-- ============================================================
-- 1. build_notify_message 函数 — 4 种 scenario 文案拼接
-- ============================================================
--
-- 与 src/agent/notify/notify-handler.ts:377-460 的 buildMessage 严格对齐。
-- 仅文案；不做业务判定。Scenario 判定在外层 sql_query CTE 完成。
--
-- 参数:
--   p_kind                — 'fix_success' | 'fix_success_review_concerns' | 'l4_created' | 'handover'
--   p_project_paths       — JSONB 数组, 排序后的 project_path 列表（owner 维度聚合）
--   p_mr_urls             — JSONB 数组, MR url（与 project_paths 同序，部分项可能为 null）
--   p_mr_iids             — JSONB 数组, MR iid（同上）
--   p_review_labels       — JSONB 数组, 每个 project 的 ai_review label（同上）
--   p_root_cause_summary  — 报告 root_cause_summary（≤200 字截断在函数内做）
--   p_issue_url           — 报告 issue_url
--   p_issue_id            — 报告 issue_id (用于 fallback fix_branch)
--   p_handover_data       — handover 事件 data jsonb（仅 handover scenario 用，其他传 NULL/{}）
--
-- 返回: TEXT —— 完整 DM 文案，emoji / 换行 / 字段顺序与 buildMessage 输出严格对齐。

CREATE OR REPLACE FUNCTION build_notify_message(
  p_kind               TEXT,
  p_project_paths      JSONB,
  p_mr_urls            JSONB,
  p_mr_iids            JSONB,
  p_review_labels      JSONB,
  p_root_cause_summary TEXT,
  p_issue_url          TEXT,
  p_issue_id           INTEGER,
  p_handover_data      JSONB
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $func$
DECLARE
  v_summary    TEXT;
  v_mr_lines   TEXT;
  v_lines      TEXT[];
  v_path       TEXT;
  v_url        TEXT;
  v_iid        TEXT;
  v_idx        INT;
  v_total      INT;
  v_reason     TEXT;
  v_reason_cn  TEXT;
  v_fix_branch TEXT;
  v_attempt    INT;
  v_comment    TEXT;
  v_failure    TEXT;
  v_attempt_line TEXT;
  v_owner_proj_line TEXT;
  v_comment_line TEXT;
  v_failure_line TEXT;
BEGIN
  -- 截断 root_cause_summary 到 200 字（与 buildMessage 一致：.slice(0, 200)）
  v_summary := COALESCE(LEFT(p_root_cause_summary, 200), '');

  IF p_kind = 'fix_success' THEN
    -- 文案: ✅ 你负责的服务已自动修复，MR 等待合并 + 列表 + 摘要 + ai-approved
    v_total := COALESCE(jsonb_array_length(p_project_paths), 0);
    v_lines := ARRAY[]::TEXT[];
    FOR v_idx IN 0..GREATEST(v_total - 1, 0) LOOP
      EXIT WHEN v_idx >= v_total;
      v_path := p_project_paths->>v_idx;
      v_url := COALESCE(p_mr_urls->>v_idx, NULL);
      v_iid := COALESCE(p_mr_iids->>v_idx, '?');
      IF v_url IS NULL THEN
        v_lines := array_append(v_lines, '- ' || v_path || ': MR !' || v_iid);
      ELSE
        v_lines := array_append(v_lines, '- ' || v_path || ': ' || v_url);
      END IF;
    END LOOP;
    RETURN
      '✅ 你负责的服务已自动修复，MR 等待合并：' || E'\n' ||
      array_to_string(v_lines, E'\n') || E'\n' ||
      E'\n' ||
      '📋 修复方案：' || v_summary || E'\n' ||
      E'\n' ||
      'AI Review 结论：✅ ai-approved';

  ELSIF p_kind = 'fix_success_review_concerns' THEN
    v_total := COALESCE(jsonb_array_length(p_project_paths), 0);
    v_lines := ARRAY[]::TEXT[];
    FOR v_idx IN 0..GREATEST(v_total - 1, 0) LOOP
      EXIT WHEN v_idx >= v_total;
      v_path := p_project_paths->>v_idx;
      v_url := COALESCE(p_mr_urls->>v_idx, NULL);
      v_iid := COALESCE(p_mr_iids->>v_idx, '?');
      IF v_url IS NULL THEN
        v_lines := array_append(v_lines, '- ' || v_path || ': MR !' || v_iid);
      ELSE
        v_lines := array_append(v_lines, '- ' || v_path || ': ' || v_url);
      END IF;
    END LOOP;
    RETURN
      '⚠️ AI Review 发现问题' || E'\n' ||
      E'\n' ||
      '你负责的服务已修复并创建 MR：' || E'\n' ||
      array_to_string(v_lines, E'\n') || E'\n' ||
      E'\n' ||
      'AI Review 标签：⚠️ ai-needs-attention' || E'\n' ||
      '请关注并决定是否合并。';

  ELSIF p_kind = 'l4_created' THEN
    -- L4：summary 为空时换 fallback 文案
    RETURN
      '🛑 L4 架构级 Bug — 需人工接手' || E'\n' ||
      E'\n' ||
      '此 Bug 经 AI 分析判定为 L4，**无法自动修复**，Issue 已建好等你处理。' || E'\n' ||
      E'\n' ||
      'Issue: ' || COALESCE(p_issue_url, '') || E'\n' ||
      E'\n' ||
      '📋 根因摘要：' ||
      CASE WHEN v_summary = '' THEN '（未提取到摘要，详见 Issue 正文）' ELSE v_summary END;

  ELSIF p_kind = 'handover' THEN
    -- handover: reasonToCn 字典 + attemptLine / ownerProjectsLine / commentLine / failureLine
    v_reason := COALESCE(p_handover_data->>'reason', 'user_requested');
    v_reason_cn := CASE v_reason
      WHEN 'fix_exhausted'      THEN 'AI 修复多次未通过'
      WHEN 'revise_exhausted'   THEN 'AI 修订多次仍未通过'
      WHEN 'l4_manual'          THEN 'Bug 需架构级改动，AI 无法自动修复'
      WHEN 'low_confidence'     THEN 'AI 分析置信度过低'
      WHEN 'user_requested'     THEN '用户在前端主动请求转人工'
      WHEN 'owner_label'        THEN '你在 GitLab 标记了 needs-manual'
      WHEN 'tag_unrevisable'    THEN 'tag 版本 Bug 无法自动处理'
      ELSE v_reason
    END;
    -- fixBranch fallback: handoverData.fixBranch 或 'fix/issue-<issueId>'
    v_fix_branch := COALESCE(p_handover_data->>'fixBranch', 'fix/issue-' || COALESCE(p_issue_id::TEXT, '?'));
    -- attemptCount 仅 number 时显示
    IF jsonb_typeof(p_handover_data->'attemptCount') = 'number' THEN
      v_attempt := (p_handover_data->>'attemptCount')::INT;
      IF v_attempt IS NOT NULL AND v_attempt > 0 THEN
        v_attempt_line := 'AI 已尝试 ' || v_attempt::TEXT || ' 次';
      ELSE
        v_attempt_line := NULL;
      END IF;
    ELSE
      v_attempt_line := NULL;
    END IF;
    -- ownerProjectsLine 仅 projectPaths 非空时
    v_total := COALESCE(jsonb_array_length(p_project_paths), 0);
    IF v_total > 0 THEN
      v_lines := ARRAY[]::TEXT[];
      FOR v_idx IN 0..(v_total - 1) LOOP
        v_lines := array_append(v_lines, p_project_paths->>v_idx);
      END LOOP;
      v_owner_proj_line := '你负责的服务：' || array_to_string(v_lines, ', ');
    ELSE
      v_owner_proj_line := NULL;
    END IF;
    -- commentLine
    v_comment := p_handover_data->>'comment';
    IF v_comment IS NOT NULL AND v_comment != '' THEN
      v_comment_line := '用户说明：' || v_comment;
    ELSE
      v_comment_line := NULL;
    END IF;
    -- failureLine
    v_failure := p_handover_data->>'failureSummary';
    IF v_failure IS NOT NULL AND v_failure != '' THEN
      v_failure_line := '❗ AI 失败原因：' || E'\n' || v_failure;
    ELSE
      v_failure_line := NULL;
    END IF;
    -- 组装（与 buildMessage handover 分支顺序严格对齐）
    -- [
    --   '🛠 Bug 需你接手（AI 放弃自动修复）',
    --   '',
    --   '原因：xxx',
    --   ...(attemptLine ? [attemptLine] : []),
    --   ...(ownerProjectsLine ? [ownerProjectsLine] : []),
    --   '',
    --   'Issue：xxx',
    --   'fix 分支：xxx（已 push 到 GitLab，含 AI 的尝试 commit）',
    --   'Issue label：needs-manual',
    --   '',
    --   '📋 根因摘要：xxx 或 fallback',
    --   ...(failureLine ? ['', failureLine] : []),
    --   ...(commentLine ? ['', commentLine] : []),
    --   '',
    --   '请在 GitLab checkout 分支继续修改，或关闭 Issue 放弃。',
    -- ].join('\n')
    DECLARE
      v_out TEXT;
    BEGIN
      v_out := '🛠 Bug 需你接手（AI 放弃自动修复）' || E'\n' ||
               E'\n' ||
               '原因：' || v_reason_cn;
      IF v_attempt_line IS NOT NULL THEN
        v_out := v_out || E'\n' || v_attempt_line;
      END IF;
      IF v_owner_proj_line IS NOT NULL THEN
        v_out := v_out || E'\n' || v_owner_proj_line;
      END IF;
      v_out := v_out || E'\n' || E'\n' ||
               'Issue：' || COALESCE(p_issue_url, '') || E'\n' ||
               'fix 分支：' || v_fix_branch || '（已 push 到 GitLab，含 AI 的尝试 commit）' || E'\n' ||
               'Issue label：needs-manual' || E'\n' ||
               E'\n' ||
               '📋 根因摘要：' ||
               CASE WHEN v_summary = '' THEN '（详见 Issue 正文）' ELSE v_summary END;
      IF v_failure_line IS NOT NULL THEN
        v_out := v_out || E'\n' || E'\n' || v_failure_line;
      END IF;
      IF v_comment_line IS NOT NULL THEN
        v_out := v_out || E'\n' || E'\n' || v_comment_line;
      END IF;
      v_out := v_out || E'\n' || E'\n' ||
               '请在 GitLab checkout 分支继续修改，或关闭 Issue 放弃。';
      RETURN v_out;
    END;

  ELSE
    -- 不应该到这里 —— 外层 SQL 已经过滤了 should_notify=false 的 scenario
    RETURN NULL;
  END IF;
END;
$func$;

COMMENT ON FUNCTION build_notify_message IS
  'phase 4 T3 — 4 种 notify scenario 的 DM 文案拼接（与 src/agent/notify/notify-handler.ts:buildMessage 严格对齐）。仅文案；业务判定在外层 sql_query CTE 完成。';

-- ============================================================
-- 2. notify-internal pipeline (5 节点 DAG: compute_notify_plan → send_dms → write_success_events → write_failed_events)
-- ============================================================

DO $$
DECLARE
  v_pipeline_id INTEGER;
  v_pl_id       INTEGER;
BEGIN
  -- 跳过如已存在
  IF EXISTS (SELECT 1 FROM test_pipelines WHERE name='notify-internal') THEN
    SELECT id INTO v_pipeline_id FROM test_pipelines WHERE name='notify-internal';
    RAISE NOTICE 'schema-v40: notify-internal pipeline 已存在 id=%', v_pipeline_id;
  ELSE
    -- 选最小 id 的产线作为 internal pipeline 的承载体（与 schema-v37 同模式）
    SELECT id INTO v_pl_id FROM product_lines ORDER BY id LIMIT 1;
    IF v_pl_id IS NULL THEN
      RAISE NOTICE 'schema-v40: no product_lines, skip seeding notify-internal pipeline';
      RETURN;
    END IF;

    INSERT INTO test_pipelines (
      product_line_id, name, description, graph, trigger_params, enabled,
      server_roles, schedule, variables, stages
    )
    VALUES (
      v_pl_id,
      'notify-internal',
      'phase 4 T3: notify_bug handler 迁移 — 4 节点 DAG (sql_query → fan_out → db_update × 2)',
      $graph$
      {
        "nodes": [
          {
            "id": "compute_notify_plan",
            "stageType": "sql_query",
            "position": {"x": 100, "y": 100},
            "params": {
              "sqlTemplate": "WITH report AS (SELECT id, level, classification, issue_id, issue_url, root_cause_summary, primary_project_path, product_line_id FROM bug_analysis_reports WHERE id = {{triggerParams.reportId}}), latest_handover AS (SELECT data FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND code = 'handover' AND status = 'success' ORDER BY id DESC LIMIT 1), latest_approval_decision AS (SELECT (data->>'decision') AS decision FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND code = 'approval' ORDER BY id DESC LIMIT 1), scope_paths AS (SELECT DISTINCT project_path FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND project_path IS NOT NULL AND code IN ('scope_identified', 'fix_attempt', 'create_mr')), per_project AS (SELECT sp.project_path, (SELECT status FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND project_path = sp.project_path AND code = 'fix_attempt' ORDER BY id DESC LIMIT 1) AS fix_status, (SELECT data->>'error' FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND project_path = sp.project_path AND code = 'fix_attempt' AND status = 'failed' ORDER BY id DESC LIMIT 1) AS fix_error, (SELECT (data->>'mrIid')::int FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND project_path = sp.project_path AND code = 'create_mr' AND status = 'success' ORDER BY id DESC LIMIT 1) AS mr_iid, (SELECT data->>'mrUrl' FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND project_path = sp.project_path AND code = 'create_mr' AND status = 'success' ORDER BY id DESC LIMIT 1) AS mr_url, (SELECT data->>'label' FROM bug_fix_events WHERE report_id = {{triggerParams.reportId}} AND project_path = sp.project_path AND code = 'ai_review' ORDER BY id DESC LIMIT 1) AS review_label FROM scope_paths sp), scenario AS (SELECT CASE WHEN EXISTS (SELECT 1 FROM latest_handover) THEN 'handover' WHEN (SELECT decision FROM latest_approval_decision) = 'rejected' THEN 'approval_rejected' WHEN (SELECT decision FROM latest_approval_decision) = 'timeout' THEN 'approval_timeout' WHEN (SELECT decision FROM latest_approval_decision) = 'retry_analysis' THEN 'approval_retry_analysis' WHEN (SELECT classification = 'bug' AND level = 'l4' FROM report) AND NOT EXISTS (SELECT 1 FROM per_project WHERE mr_iid IS NOT NULL) THEN 'l4_created' WHEN (SELECT count(*) FROM per_project) > 0 AND NOT EXISTS (SELECT 1 FROM per_project WHERE fix_status != 'success' OR mr_iid IS NULL) THEN CASE WHEN EXISTS (SELECT 1 FROM per_project WHERE review_label = 'ai-needs-attention') THEN 'fix_success_review_concerns' ELSE 'fix_success' END WHEN EXISTS (SELECT 1 FROM per_project WHERE mr_iid IS NOT NULL) THEN CASE WHEN EXISTS (SELECT 1 FROM per_project WHERE review_label = 'ai-needs-attention') THEN 'fix_success_review_concerns' ELSE 'fix_success' END WHEN EXISTS (SELECT 1 FROM per_project WHERE fix_status = 'failed') THEN 'fix_failed' ELSE 'fix_failed' END AS kind), should_notify AS (SELECT (SELECT kind FROM scenario) IN ('fix_success', 'fix_success_review_concerns', 'l4_created', 'handover') AS yes), owner_plan AS (SELECT p.owner_id, jsonb_agg(pp.project_path ORDER BY pp.project_path) AS project_paths, COALESCE(jsonb_agg(pp.mr_iid ORDER BY pp.project_path) FILTER (WHERE pp.mr_iid IS NOT NULL), '[]'::jsonb) AS mr_iids, COALESCE(jsonb_agg(pp.mr_url ORDER BY pp.project_path) FILTER (WHERE pp.mr_url IS NOT NULL), '[]'::jsonb) AS mr_urls, jsonb_agg(pp.review_label ORDER BY pp.project_path) AS review_labels FROM per_project pp JOIN projects p ON p.gitlab_path = pp.project_path WHERE p.owner_id IS NOT NULL AND p.owner_id != '' GROUP BY p.owner_id) SELECT o.owner_id, o.project_paths, o.mr_iids, o.mr_urls, o.review_labels, (SELECT kind FROM scenario) AS scenario_kind, build_notify_message((SELECT kind FROM scenario), o.project_paths, o.mr_urls, o.mr_iids, o.review_labels, (SELECT root_cause_summary FROM report), (SELECT issue_url FROM report), (SELECT issue_id FROM report), (SELECT data FROM latest_handover)) AS message_text FROM owner_plan o WHERE (SELECT yes FROM should_notify)"
            }
          },
          {
            "id": "send_dms",
            "stageType": "fan_out",
            "position": {"x": 100, "y": 220},
            "params": {
              "source": "{{steps.compute_notify_plan.output.rows}}",
              "as": "owner",
              "parallel": 5,
              "onItemFailure": "continue",
              "body": [
                {
                  "id": "send_one_dm",
                  "nodeTypeKey": "dm",
                  "params": {
                    "platform": "dingtalk",
                    "userId": "{{owner.owner_id}}",
                    "text": "{{owner.message_text}}",
                    "extraMeta": {
                      "ownerId": "{{owner.owner_id}}",
                      "messageKind": "{{owner.scenario_kind}}",
                      "mrIids": "{{owner.mr_iids}}"
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
              "sqlTemplate": "INSERT INTO bug_fix_events (report_id, project_path, code, status, data) SELECT {{triggerParams.reportId}}, NULL, 'notify', 'success', jsonb_build_object('userId', item->'extraMeta'->>'ownerId', 'role', 'owner', 'messageKind', item->'extraMeta'->>'messageKind', 'mrIids', COALESCE(item->'extraMeta'->'mrIids', '[]'::jsonb)) FROM jsonb_array_elements('{{steps.send_dms.output.items | jsonStringify}}'::jsonb) item"
            }
          },
          {
            "id": "write_failed_events",
            "stageType": "db_update",
            "position": {"x": 100, "y": 460},
            "params": {
              "sqlTemplate": "INSERT INTO bug_fix_events (report_id, project_path, code, status, data) SELECT {{triggerParams.reportId}}, NULL, 'notify', 'failed', jsonb_build_object('userId', f->'item'->>'owner_id', 'role', 'owner', 'messageKind', f->'item'->>'scenario_kind', 'mrIids', COALESCE(f->'item'->'mr_iids', '[]'::jsonb), 'error', f->>'error') FROM jsonb_array_elements('{{steps.send_dms.output.failed | jsonStringify}}'::jsonb) f"
            }
          }
        ],
        "edges": [
          {"id": "e1", "source": "compute_notify_plan", "target": "send_dms"},
          {"id": "e2", "source": "send_dms",            "target": "write_success_events"},
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
    RAISE NOTICE 'schema-v40: notify-internal pipeline 创建 id=%', v_pipeline_id;
  END IF;

  -- 注册到 internal_capability_pipelines
  INSERT INTO internal_capability_pipelines (capability_key, pipeline_id)
  VALUES ('notify_bug', v_pipeline_id)
  ON CONFLICT (capability_key) DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id;
END $$;

-- 断言: notify_bug 必须存在于 internal_capability_pipelines（仅当 product_lines 非空时）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM product_lines) AND NOT EXISTS (
    SELECT 1 FROM internal_capability_pipelines WHERE capability_key='notify_bug'
  ) THEN
    RAISE EXCEPTION 'schema-v40: notify_bug 未注册到 internal_capability_pipelines';
  END IF;
END $$;
