-- schema-v14.sql: bug_analysis_reports 加 completed_at 字段
--
-- 背景：前端列表"完成时间"列需要独立时间戳（不能用 updated_at，后者会被中间字段更新污染）
-- 写入时机：status 变为终态（completed / aborted / pending_manual）时
-- 幂等：已非空时不再覆盖
ALTER TABLE bug_analysis_reports
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;

COMMENT ON COLUMN bug_analysis_reports.completed_at IS
  '终态（completed/aborted/pending_manual）时由 updateReportStatus 写入，历史数据为 NULL';
