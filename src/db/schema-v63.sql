-- ============================================================================
-- schema-v63.sql — 字段级反馈（PRD §7 step 6）
--
-- 给 requirement_approval_waiters 加两列：
--   target_task_id  — 人审"此问题在哪个 task"的精准定位（'T1' / 'T2' / NULL=全局）
--   cited_ai_notes  — 人审从 AI reviewer notes 里勾选的"已确认是真问题"子集（JSONB 数组）
--
-- 配合 plan_escalation decisionSet 的 rejected_plan 决策使用：让 plan-decomposer round 2
-- 拿到结构化反馈而非自由文本，精准修订指定 task。
-- ============================================================================

ALTER TABLE requirement_approval_waiters
  ADD COLUMN IF NOT EXISTS target_task_id TEXT,
  ADD COLUMN IF NOT EXISTS cited_ai_notes JSONB;

COMMENT ON COLUMN requirement_approval_waiters.target_task_id IS
  '人审反馈定位的 task id（如 T1/T2），NULL=全局问题。仅 decisionSet=plan_escalation 使用';

COMMENT ON COLUMN requirement_approval_waiters.cited_ai_notes IS
  'JSONB string array，人审从 AI reviewer notes 中勾选的 msg 子集。仅 decisionSet=plan_escalation 使用';
