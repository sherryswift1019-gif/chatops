-- schema-v16.sql: PRD Agent
-- 新增 prd_documents 表 + create_prd / review_prd 两个 capability

-- ============================================================
-- 1. PRD 文档表
-- ============================================================
CREATE TABLE IF NOT EXISTS prd_documents (
  id                SERIAL PRIMARY KEY,
  product_line_id   INTEGER NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  title             TEXT NOT NULL DEFAULT '',
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'drafting'
                      CHECK (status IN ('drafting','reviewing','review_blocked','draft','approved','archived')),
  content_markdown  TEXT NOT NULL DEFAULT '',
  content_json      JSONB NOT NULL DEFAULT '{}',
  review_result     JSONB,
  review_history    JSONB NOT NULL DEFAULT '[]',
  created_by        TEXT NOT NULL,
  group_id          TEXT,
  platform          TEXT,
  agent_session_id  TEXT,
  tags              JSONB NOT NULL DEFAULT '[]',
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prd_product ON prd_documents(product_line_id);
CREATE INDEX IF NOT EXISTS idx_prd_status ON prd_documents(status);
CREATE INDEX IF NOT EXISTS idx_prd_product_status ON prd_documents(product_line_id, status);
CREATE INDEX IF NOT EXISTS idx_prd_created_by ON prd_documents(created_by);

-- ============================================================
-- 2. 注册 create_prd capability（多轮对话生成 PRD）
-- ============================================================
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, is_system)
VALUES (
  'create_prd',
  'PRD 创建',
  '通过多轮对话创建结构化 PRD（产品需求文档）。仅在用户消息显式提到 PRD / 产品需求文档 / 需求文档 时才路由到此能力。',
  'action',
  '["save_prd","read_prd","update_prd_context","search_existing_prds","search_knowledge"]',
  false,
  true
) ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 3. 注册 review_prd capability（独立自审）
-- ============================================================
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, is_system)
VALUES (
  'review_prd',
  'PRD 自审',
  '独立审查 PRD 文档质量（9 维度）。系统内部调用，不由用户直接触发。',
  'action',
  '["read_prd"]',
  false,
  true
) ON CONFLICT (key) DO NOTHING;
