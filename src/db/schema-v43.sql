-- v43: im_triggers 支持关联 capability（与 pipeline_id 互斥二选一）

-- 1. 加列
ALTER TABLE im_triggers
  ADD COLUMN IF NOT EXISTS capability_key TEXT REFERENCES capabilities(key) ON DELETE RESTRICT;

-- 2. 互斥约束（不能同时设置 pipeline_id 和 capability_key）
ALTER TABLE im_triggers
  ADD CONSTRAINT im_triggers_exclusive_target
    CHECK (pipeline_id IS NULL OR capability_key IS NULL);

-- 3. 索引
CREATE INDEX IF NOT EXISTS idx_im_triggers_capability ON im_triggers(capability_key);

-- 4. 数据迁移：为无 pipeline 的 IM 触发器关联对应能力（key 相同则直接关联）
--    覆盖 v32 从 capabilities 迁移来的系统触发器：
--    view_deployments, view_images, view_logs, view_commits,
--    deploy, rollback, restart, manage_role
UPDATE im_triggers t
SET capability_key = t.key
WHERE EXISTS (SELECT 1 FROM capabilities c WHERE c.key = t.key)
  AND t.pipeline_id IS NULL
  AND t.capability_key IS NULL;

-- 5. 断言：有匹配 capability 的 IM 触发器都已完成关联
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM im_triggers t
    JOIN capabilities c ON c.key = t.key
    WHERE t.pipeline_id IS NULL AND t.capability_key IS NULL
  ) THEN
    RAISE EXCEPTION 'v43 migration incomplete: some im_triggers match a capability but have no target configured';
  END IF;
END $$;
