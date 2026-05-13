-- v1016: brainstorm_waiters — multi-round LLM brainstorm 持久化（spec_brainstorm 节点）
-- 每轮一行 waiter，存 5-section question + 选项 + 用户答复 + BrainstormState 快照。
-- 无 FK：跟随 requirement_approval_waiters / checkpoints 既有约定，删 requirement 时手动级联。

CREATE TABLE IF NOT EXISTS brainstorm_waiters (
  id                    SERIAL PRIMARY KEY,
  requirement_id        INT NOT NULL,
  pipeline_run_id       INT NOT NULL,
  thread_id             TEXT NOT NULL,
  node_id               TEXT NOT NULL,
  round                 INT NOT NULL,
  question_md           TEXT NOT NULL,
  options               JSONB NOT NULL DEFAULT '[]'::jsonb,
  enriched_input        JSONB NOT NULL DEFAULT '{}'::jsonb,
  history               JSONB NOT NULL DEFAULT '[]'::jsonb,
  failed_quality_rounds INT NOT NULL DEFAULT 0,
  ready_for_spec        BOOLEAN NOT NULL DEFAULT false,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'expired')),
  source                TEXT CHECK (source IS NULL OR source IN ('web', 'im')),
  chosen_option         TEXT,
  free_text             TEXT,
  answered_at           TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS brainstorm_waiters_run_node_round_uniq
  ON brainstorm_waiters(pipeline_run_id, node_id, round);

CREATE INDEX IF NOT EXISTS brainstorm_waiters_pending_idx
  ON brainstorm_waiters(requirement_id, status) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS brainstorm_waiters_expires_idx
  ON brainstorm_waiters(expires_at) WHERE status = 'pending';
