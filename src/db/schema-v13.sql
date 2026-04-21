-- ============================================================
-- schema-v13: Bind a default pipeline to a capability (IM-triggered)
-- ============================================================
--
-- 当 IM 消息触发某 capability 时，若 default_pipeline_id 非空，
-- coordinator 将启动对应 pipeline（通常首节点为 im_input 参数澄清 stage），
-- 不再直接裸跑 Agent。这样 IM 对话式操作也具备 pipeline 的审批/容错/回滚能力。
--
-- ON DELETE SET NULL：pipeline 删除时，binding 自动解除，不连带删除 capability。

ALTER TABLE capabilities
  ADD COLUMN IF NOT EXISTS default_pipeline_id INTEGER
    REFERENCES test_pipelines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_capabilities_default_pipeline
  ON capabilities(default_pipeline_id)
  WHERE default_pipeline_id IS NOT NULL;

-- 扩展 test_runs.trigger_type CHECK 以容纳 IM 触发。
-- schema-v3 定义的 constraint 名字是 test_runs_trigger_type_check（Postgres 默认命名）。
ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS test_runs_trigger_type_check;
ALTER TABLE test_runs
  ADD CONSTRAINT test_runs_trigger_type_check
  CHECK (trigger_type IN ('manual', 'api', 'scheduled', 'im'));
