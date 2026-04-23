-- schema-v24.sql: Architecture Design Agent — 架构设计 Agent 基础表
-- 对应实现方案 docs/prds/arch-agent-design.md。
-- 原本命名为 schema-v19；upstream main 合并时 v19 已被 capability.default_pipeline_id 占用，
-- v20/v21/v22 亦已分配，与 v23 (PRD metrics) 连续挪号到 v24。
-- 包含 arch_documents（架构文档主表）、arch_chat_sessions、arch_chat_messages 三张表。


-- ──────────────────────────────────────────────
-- 架构文档主表
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS arch_documents (
  id               SERIAL PRIMARY KEY,
  product_line_id  INTEGER NOT NULL REFERENCES product_lines(id),
  source_prd_id    INTEGER REFERENCES prd_documents(id),  -- 可选关联 PRD
  title            TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'drafting',
  -- 状态枚举: drafting | review_blocked | draft | approved | archived
  content_markdown TEXT,
  content_json     JSONB NOT NULL DEFAULT '{}',
  -- content_json 形态:
  --   { structuredArch?: StructuredArch, phase?: string,
  --     contextSummary?: string, pendingQuestions?: string[] }
  review_result    JSONB,
  review_history   JSONB NOT NULL DEFAULT '[]',
  created_by       TEXT NOT NULL,
  agent_session_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE arch_documents IS '架构设计文档，由 Architecture Design Agent 对话生成';
COMMENT ON COLUMN arch_documents.source_prd_id IS '可选关联的来源 PRD，Agent 读取作为输入上下文';
COMMENT ON COLUMN arch_documents.content_json IS '结构化数据：structuredArch（StructuredArch 对象）+ 对话上下文字段';

-- ──────────────────────────────────────────────
-- 对话会话表（与 prd_chat_sessions 同构）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS arch_chat_sessions (
  id                  SERIAL PRIMARY KEY,
  session_key         TEXT NOT NULL UNIQUE,
  arch_id             INTEGER REFERENCES arch_documents(id),
  source_prd_id       INTEGER REFERENCES prd_documents(id),
  product_line_id     INTEGER NOT NULL,
  porygon_session_id  TEXT,
  created_by          TEXT NOT NULL,
  last_active_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE arch_chat_sessions IS '架构设计 Agent 对话会话，session_key 为前端唯一标识';

-- ──────────────────────────────────────────────
-- 消息历史（与 prd_chat_messages 同构）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS arch_chat_messages (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES arch_chat_sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  -- role 枚举: user | assistant | tool_use | tool_result | error
  content      TEXT NOT NULL,
  tool_name    TEXT,
  tool_use_id  TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE arch_chat_messages IS '架构设计对话消息历史';

-- ──────────────────────────────────────────────
-- 注册 create_arch capability
-- ──────────────────────────────────────────────
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, is_system)
VALUES (
  'create_arch',
  '架构设计',
  '通过多轮对话协助架构师产出结构化架构设计文档（ADD）。仅在用户消息显式提到架构设计 / 架构文档 / ADD 时才路由到此能力。',
  'action',
  '["save_arch","read_arch","update_arch_context","search_existing_arch","read_prd","search_knowledge"]',
  false,
  true
) ON CONFLICT (key) DO NOTHING;

-- ──────────────────────────────────────────────
-- 索引
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_arch_documents_product_line ON arch_documents(product_line_id);
CREATE INDEX IF NOT EXISTS idx_arch_documents_source_prd   ON arch_documents(source_prd_id) WHERE source_prd_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_arch_documents_status       ON arch_documents(status);
CREATE INDEX IF NOT EXISTS idx_arch_chat_sessions_key      ON arch_chat_sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_arch_chat_messages_session  ON arch_chat_messages(session_id, created_at);
