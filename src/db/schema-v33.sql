-- v33: phase 2 cleanup — DROP capabilities 5 个 legacy 字段
-- 这些字段的职责已经迁出:
--   - default_pipeline_id: 迁到 im_triggers.pipeline_id (phase 2)
--   - category: 已废 (phase 2 cleanup 用 im_triggers 替代 query/action/admin 区分)
--   - param_schema / playbook: 2026-04-14 unified spec 残留, 推翻 (phase 0/1/2)
--   - needs_approval: 已废 (审批由 approval_rules 决定, phase 2 已完成)
-- 见 docs/superpowers/specs/2026-04-26-capability-pipeline-refactor-design.md §3.4

ALTER TABLE capabilities
  DROP COLUMN IF EXISTS default_pipeline_id,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS param_schema,
  DROP COLUMN IF EXISTS playbook,
  DROP COLUMN IF EXISTS needs_approval;

-- 验证: capabilities 表只剩核心 LLM agent 配置字段 (key/displayName/description/
-- toolNames/systemPrompt/defaultSystemPrompt/maxTurns/timeoutMs/requiresWorktree/
-- requiresDeployLock/isSystem/createdAt/updatedAt)
DO $$
DECLARE
  v_dropped_remaining INT;
BEGIN
  SELECT COUNT(*) INTO v_dropped_remaining
  FROM information_schema.columns
  WHERE table_name = 'capabilities'
    AND column_name IN ('default_pipeline_id','category','param_schema','playbook','needs_approval');
  IF v_dropped_remaining > 0 THEN
    RAISE EXCEPTION 'schema-v33: 仍有 % 个 legacy 字段未删', v_dropped_remaining;
  END IF;
  RAISE NOTICE 'schema-v33: capabilities 5 个 legacy 字段已删除';
END $$;
