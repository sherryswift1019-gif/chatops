-- schema-v13.sql: handover MVP（对齐 V2 spec §27）（原 v12，合并 main 时让号改为 v13）
--
-- MVP 范围：
-- 1. bug_fix_events code 白名单注释追加 'handover'（实际约束在业务层）
-- 2. bug_analysis_reports.status 新增 'pending_manual' 取值（字段是 VARCHAR(20)，无需 DDL 变更）
-- 3. capabilities 新增 request_handover
--
-- MVP 不做（V2 才做）：
-- - bug_report_pipeline_runs 关联表
-- - handover-pipeline 模板（MVP 由 coordinator 直接 triggerCapability 调用 handler，不走 Pipeline）
-- - revise_fix / notify_tester
-- - 前端多轮分组视图所需的数据模型扩展

-- ============================================================
-- 1. 事件码白名单注释更新（仅注释，业务层校验）
-- ============================================================
-- 允许值（V1 9 种 + handover）：
--   analysis / scope_identified / create_issue / fix_attempt /
--   create_mr / ai_review / approval / notify / lifecycle_sync / handover
COMMENT ON COLUMN bug_fix_events.code IS
  'V1: analysis/scope_identified/create_issue/fix_attempt/create_mr/ai_review/approval/notify/lifecycle_sync; MVP: +handover';

-- ============================================================
-- 2. bug_analysis_reports.status 取值扩展
--    'draft' | 'published' | 'pipeline_success' | 'pending_manual' (MVP 新增) | 'completed' | 'aborted'
--    字段是 VARCHAR(20)，无需 DDL 变更，业务层保证合法值。
-- ============================================================
COMMENT ON COLUMN bug_analysis_reports.status IS
  'draft | published | pipeline_success | pending_manual (MVP) | completed | aborted';

-- ============================================================
-- 3. capabilities 新增 request_handover（V2 完整接口，MVP 实现 3 个 reason）
-- ============================================================
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, is_system, system_prompt)
VALUES
  ('request_handover', '转人工接手',
   'AI 自动化失败后转交 owner 人工处理：Issue 打 needs-manual label、保留 fix 分支、DM owner（附分支 URL 和失败摘要）。V2 完整接口预留；MVP 实现 fix_exhausted / l4_manual / user_requested 三个 reason',
   'action', '[]'::jsonb, false, true, '')
ON CONFLICT (key) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description  = EXCLUDED.description;
