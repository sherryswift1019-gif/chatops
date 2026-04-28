-- v46: capability_invocations 表
--
-- 目的：补齐裸 capability handler 调用的执行记录。
-- test_runs 只覆盖 pipeline 路径（runPipeline → createTestRun）；当 triggerCapability
-- 走到 coordinator.ts 末尾的 handler 分支（既无 im_trigger.pipeline 也不在
-- PIPELINE_DAG_HANDLERS），完全没记录。新表独立保存这种"非 pipeline-shaped"
-- capability 调用，前端可在专门页面查看 IM/Webhook/API/Admin 触发的日志。
--
-- 写入时机（src/agent/coordinator.ts handler 分支）：
--   - 进入 handler 前 createInvocation(status='running')
--   - handler 返回 / 抛异常后 finishInvocation(status='success'|'failed', output, error)
--   - opts._suppressInvocationLog === true 时跳过（pipeline executor-hooks/legacy
--     调子 capability 时设此标记，避免与外层 test_runs 重复）

CREATE TABLE IF NOT EXISTS capability_invocations (
  id              SERIAL PRIMARY KEY,
  capability_key  TEXT NOT NULL,
  trigger_type    TEXT NOT NULL,
  platform        TEXT NOT NULL DEFAULT '',
  group_id        TEXT NOT NULL DEFAULT '',
  triggered_by    TEXT NOT NULL DEFAULT '',
  task_id         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  params          JSONB NOT NULL DEFAULT '{}'::jsonb,
  output          TEXT NOT NULL DEFAULT '',
  error_message   TEXT NOT NULL DEFAULT '',
  duration_ms     INTEGER,
  parent_pipeline_run_id INT REFERENCES test_runs(id) ON DELETE SET NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_capability_invocations_key
  ON capability_invocations(capability_key);
CREATE INDEX IF NOT EXISTS idx_capability_invocations_status
  ON capability_invocations(status);
CREATE INDEX IF NOT EXISTS idx_capability_invocations_started
  ON capability_invocations(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_capability_invocations_group
  ON capability_invocations(platform, group_id);
