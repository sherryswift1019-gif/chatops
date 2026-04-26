-- ============================================================
-- schema-v29: 补齐 product_lines 引用的 ON DELETE CASCADE
-- ============================================================
-- 背景：v8 / v24 创建的 4 张表引用 product_lines(id) 时漏写了
-- ON DELETE CASCADE，导致管理后台删除产线被 FK 阻塞：
--   product_knowledge_repos_product_line_id_fkey violation
-- 该项目其他产线关联表（projects / product_line_envs /
-- product_line_capabilities / approval_rules ...）一律 CASCADE，
-- 这 4 张表是疏漏。本 migration DROP + ADD 重建约束以补齐风格。
--
-- 约束名沿用 PostgreSQL 默认命名 <table>_<column>_fkey，
-- 与现网一致（错误信息已确认 product_knowledge_repos 的命名）。
-- ALTER TABLE ... DROP ... ADD ... 同语句原子执行，幂等：
-- 每次 migrate 都重置成最终定义，无副作用。
-- ============================================================

ALTER TABLE bug_analysis_reports
  DROP CONSTRAINT IF EXISTS bug_analysis_reports_product_line_id_fkey,
  ADD CONSTRAINT bug_analysis_reports_product_line_id_fkey
    FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE CASCADE;

ALTER TABLE product_knowledge_repos
  DROP CONSTRAINT IF EXISTS product_knowledge_repos_product_line_id_fkey,
  ADD CONSTRAINT product_knowledge_repos_product_line_id_fkey
    FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE CASCADE;

ALTER TABLE metrics_daily
  DROP CONSTRAINT IF EXISTS metrics_daily_product_line_id_fkey,
  ADD CONSTRAINT metrics_daily_product_line_id_fkey
    FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE CASCADE;

ALTER TABLE arch_documents
  DROP CONSTRAINT IF EXISTS arch_documents_product_line_id_fkey,
  ADD CONSTRAINT arch_documents_product_line_id_fkey
    FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE CASCADE;
