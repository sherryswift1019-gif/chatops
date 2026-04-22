-- schema-v17.sql: PRD Agent Web 对话面板
-- 新增两张表，支持 Web 端流式对话 + 刷新可续

-- ============================================================
-- 1. Web PRD 对话会话（与 ClaudeRunner 内存 session 不同层，持久化）
-- ============================================================
CREATE TABLE IF NOT EXISTS prd_chat_sessions (
  id                  SERIAL PRIMARY KEY,
  session_key         TEXT NOT NULL UNIQUE,
  prd_id              INTEGER REFERENCES prd_documents(id) ON DELETE CASCADE,
  product_line_id     INTEGER NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  created_by          TEXT NOT NULL,
  porygon_session_id  TEXT,
  last_active_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prd_chat_session_prd ON prd_chat_sessions(prd_id);
CREATE INDEX IF NOT EXISTS idx_prd_chat_session_pl  ON prd_chat_sessions(product_line_id);
CREATE INDEX IF NOT EXISTS idx_prd_chat_session_by  ON prd_chat_sessions(created_by);

-- ============================================================
-- 2. 对话消息
--   role:
--     user         — 人类输入
--     assistant    — AI 回复正文
--     tool_use     — 工具调用请求（content 存 JSON 序列化的 input）
--     tool_result  — 工具调用结果（content 存工具输出文本）
--     error        — 错误事件
-- ============================================================
CREATE TABLE IF NOT EXISTS prd_chat_messages (
  id           SERIAL PRIMARY KEY,
  session_key  TEXT NOT NULL REFERENCES prd_chat_sessions(session_key) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','tool_use','tool_result','error')),
  content      TEXT NOT NULL DEFAULT '',
  tool_name    TEXT,
  tool_use_id  TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prd_chat_msg_session ON prd_chat_messages(session_key, created_at);
