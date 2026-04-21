-- schema-v15.sql: bug_analysis_reports 新增 triggered_by 字段
--
-- 背景：
--   触发人信息原本存在 test_runs.triggered_by（通过 pipeline_run_id 关联），
--   但前端 Bug 修复实例列表每行都需要 join 拿触发人很别扭，且非 bug 分类路径
--   （draft→completed 直达，无 pipeline_run_id）根本没法拿到。
--   方案 C：在 bug_analysis_reports 加独立字段，analyzer 创建时写入 context.initiatorId。
--
-- 幂等：`ADD COLUMN IF NOT EXISTS` 重复执行无副作用。

ALTER TABLE bug_analysis_reports
  ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(200);

COMMENT ON COLUMN bug_analysis_reports.triggered_by IS
  '触发人 userId（如钉钉 userid），analyzer 从 TriggerContext.initiatorId 写入。与 test_runs.triggered_by 独立存储，避免 join + 覆盖非 bug 分类场景。';

-- 存量数据补齐（从对应 test_runs 回填，对已有 pipeline_run_id 的报告）
UPDATE bug_analysis_reports r
SET triggered_by = tr.triggered_by
FROM test_runs tr
WHERE r.pipeline_run_id = tr.id
  AND r.triggered_by IS NULL
  AND tr.triggered_by IS NOT NULL;
