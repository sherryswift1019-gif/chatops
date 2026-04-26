-- v31: capabilities 表瘦身第一步——ADD 4 个 LLM agent 配置字段
-- 这些字段把 src/agent/claude-runner.ts 当前 3 处硬编码挪进 DB:
--   - max_turns / timeout_ms: 替代 ClaudeRunner 构造时的 Porygon defaults (line 197-198)
--   - requires_worktree:    替代 CODE_CAPABILITIES 数组 (line 648)
--   - requires_deploy_lock: 替代 writeCapabilities Set (line 473)
-- 旧字段(default_pipeline_id / category / param_schema / playbook / needs_approval)
-- 不在本迁移删除,phase 2 cleanup PR 单独处理(spec §3.6)

ALTER TABLE capabilities
  ADD COLUMN IF NOT EXISTS max_turns INT NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS timeout_ms INT NOT NULL DEFAULT 1200000,
  ADD COLUMN IF NOT EXISTS requires_worktree BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requires_deploy_lock BOOLEAN NOT NULL DEFAULT FALSE;

-- backfill: deploy / rollback / restart 需要 deploy lock
UPDATE capabilities
   SET requires_deploy_lock = TRUE
 WHERE key IN ('deploy', 'rollback', 'restart');

-- backfill: bug 分析 + 自动修复 需要 worktree
UPDATE capabilities
   SET requires_worktree = TRUE
 WHERE key IN ('analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3');

-- 断言: backfill 命中数符合预期
DO $$
DECLARE
  v_lock_count INT;
  v_worktree_count INT;
BEGIN
  SELECT COUNT(*) INTO v_lock_count
    FROM capabilities
   WHERE requires_deploy_lock = TRUE
     AND key IN ('deploy', 'rollback', 'restart');
  IF v_lock_count <> 3 THEN
    RAISE EXCEPTION 'schema-v31 backfill 失败: requires_deploy_lock=true 应匹配 3 行(deploy/rollback/restart),实际 %', v_lock_count;
  END IF;

  SELECT COUNT(*) INTO v_worktree_count
    FROM capabilities
   WHERE requires_worktree = TRUE
     AND key IN ('analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3');
  IF v_worktree_count <> 4 THEN
    RAISE EXCEPTION 'schema-v31 backfill 失败: requires_worktree=true 应匹配 4 行(analyze_bug + fix_bug_l1/l2/l3),实际 %', v_worktree_count;
  END IF;

  RAISE NOTICE 'schema-v31 backfill 验证通过: lock=%, worktree=%', v_lock_count, v_worktree_count;
END $$;
