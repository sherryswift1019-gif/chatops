-- schema-v8.sql: 研发 AI 助手数据层
-- 7 张新表 + 6 个新 capability + 索引

-- ============================================================
-- 1. Bug 分析报告（Agent 间 handoff 契约）
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_analysis_reports (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER NOT NULL,
  issue_url TEXT NOT NULL,
  product_line_id INTEGER NOT NULL REFERENCES product_lines(id),
  agent_session_id TEXT,
  level VARCHAR(8) NOT NULL,
  classification VARCHAR(16) NOT NULL,
  confidence VARCHAR(8) NOT NULL,
  confidence_score NUMERIC(3,2),
  root_cause_summary TEXT,
  solutions_json JSONB NOT NULL DEFAULT '[]',
  affected_modules JSONB,
  analysis_steps JSONB,
  metadata JSONB,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_issue ON bug_analysis_reports(issue_id);
CREATE INDEX IF NOT EXISTS idx_bug_reports_product ON bug_analysis_reports(product_line_id);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_analysis_reports(status);

-- ============================================================
-- 2. 模块 → 负责人映射
-- ============================================================
CREATE TABLE IF NOT EXISTS module_owners (
  id SERIAL PRIMARY KEY,
  product_line_id INTEGER NOT NULL REFERENCES product_lines(id),
  module_pattern TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  backup_owner_user_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_module_owners_unique
  ON module_owners(product_line_id, module_pattern);

-- ============================================================
-- 3. 产品线 → 知识库仓库映射
-- ============================================================
CREATE TABLE IF NOT EXISTS product_knowledge_repos (
  id SERIAL PRIMARY KEY,
  product_line_id INTEGER NOT NULL UNIQUE REFERENCES product_lines(id),
  code_repo_url TEXT NOT NULL,
  code_default_branch TEXT NOT NULL DEFAULT 'develop',
  knowledge_repo_url TEXT NOT NULL,
  ai_summary_path TEXT NOT NULL DEFAULT 'docs/ai',
  image_storage_config JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 4. Bug 根因归因
-- ============================================================
CREATE TABLE IF NOT EXISTS root_cause_attributions (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER NOT NULL,
  report_id INTEGER REFERENCES bug_analysis_reports(id),
  root_cause_type VARCHAR(32) NOT NULL,
  context TEXT,
  attributed_by TEXT,
  attributed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_root_cause_issue ON root_cause_attributions(issue_id);
CREATE INDEX IF NOT EXISTS idx_root_cause_type ON root_cause_attributions(root_cause_type);

-- ============================================================
-- 5. 知识库命中统计
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_hit_stats (
  id SERIAL PRIMARY KEY,
  entry_id TEXT NOT NULL,
  product_line_id INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_hits_unique
  ON knowledge_hit_stats(entry_id, product_line_id);

-- ============================================================
-- 6. 分析任务统计
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_analysis_stats (
  id SERIAL PRIMARY KEY,
  report_id INTEGER REFERENCES bug_analysis_reports(id),
  duration_ms INTEGER NOT NULL,
  cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
  token_count INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 7. 日级指标聚合
-- ============================================================
CREATE TABLE IF NOT EXISTS metrics_daily (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  product_line_id INTEGER REFERENCES product_lines(id),
  metric_key VARCHAR(64) NOT NULL,
  metric_value NUMERIC NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_daily_unique
  ON metrics_daily(date, product_line_id, metric_key);

-- ============================================================
-- 8. 注册 6 个研发 AI 助手 capability
-- ============================================================
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval)
VALUES
  ('analyze_bug', 'Bug 分析', '读代码定位根因，输出置信度、分级、修复方案', 'action', '["read_code","search_knowledge","create_issue","download_image","switch_version"]', false),
  ('fix_bug_l1', 'L1 配置修复', '自动修复配置类 Bug：改代码、跑测试、提 MR', 'action', '["fix_code","run_tests","create_mr","update_ai_summary","switch_version"]', false),
  ('fix_bug_l2', 'L2 代码修复', '自动修复简单代码 Bug：改代码、跑测试、提 MR，含重试', 'action', '["fix_code","run_tests","create_mr","update_ai_summary","switch_version"]', false),
  ('fix_bug_l3', 'L3 业务修复', '方案审批通过后自动修复业务逻辑 Bug', 'action', '["fix_code","run_tests","create_mr","update_ai_summary","switch_version"]', true),
  ('ai_review_mr', 'AI Review', '独立视角审查 MR diff，标记风险', 'action', '["review_mr_diff"]', false),
  ('search_knowledge', '知识库查询', '查询知识库 index.json，命中时返回历史方案', 'query', '["search_knowledge"]', false)
ON CONFLICT (key) DO NOTHING;
