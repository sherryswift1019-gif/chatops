-- product_lines
CREATE TABLE IF NOT EXISTS product_lines (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  description   TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- product_line_members
CREATE TABLE IF NOT EXISTS product_line_members (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  user_name        TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('developer','tester','ops','admin')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_line_id, user_id)
);

-- projects
CREATE TABLE IF NOT EXISTS projects (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  name             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  gitlab_path      TEXT DEFAULT '',
  harbor_project   TEXT DEFAULT '',
  owner_id         TEXT DEFAULT '',
  owner_name       TEXT DEFAULT '',
  description      TEXT DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- environments
CREATE TABLE IF NOT EXISTS environments (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- product_line_envs
CREATE TABLE IF NOT EXISTS product_line_envs (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  env_id           INT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  runtime          TEXT NOT NULL CHECK (runtime IN ('kubernetes','docker')),
  namespace        TEXT DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(product_line_id, env_id)
);

-- dingtalk_users
CREATE TABLE IF NOT EXISTS dingtalk_users (
  user_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT DEFAULT '',
  department  TEXT DEFAULT '',
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- system_config
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add product_line_id to existing approval_rules
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS product_line_id INT REFERENCES product_lines(id) ON DELETE CASCADE;

-- tool_permissions (tool × env × allowed roles per product line)
DROP TABLE IF EXISTS tool_permissions;
CREATE TABLE IF NOT EXISTS tool_permissions (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  tool_name        TEXT NOT NULL,
  env_name         TEXT NOT NULL DEFAULT '*',
  allowed_roles    JSONB NOT NULL DEFAULT '[]',
  UNIQUE(product_line_id, tool_name, env_name)
);

-- capabilities (system-wide capability definitions)
CREATE TABLE IF NOT EXISTS capabilities (
  id             SERIAL PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  description    TEXT DEFAULT '',
  category       TEXT NOT NULL DEFAULT 'query' CHECK (category IN ('query','action','admin')),
  tool_names     JSONB NOT NULL DEFAULT '[]',
  needs_approval BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- product_line_capabilities (per product line capability enablement)
CREATE TABLE IF NOT EXISTS product_line_capabilities (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  capability_key   TEXT NOT NULL,
  env_name         TEXT NOT NULL DEFAULT '*',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_roles    JSONB NOT NULL DEFAULT '["developer","tester","ops","admin"]',
  UNIQUE(product_line_id, capability_key, env_name)
);

CREATE INDEX IF NOT EXISTS idx_plc_lookup ON product_line_capabilities(product_line_id, capability_key, env_name);

-- Seed default capabilities
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval) VALUES
  ('view_deployments', '查看部署状态', '查询部署历史和当前版本', 'query', '["query_deployments"]', false),
  ('view_images', '查看镜像列表', '列出可用容器镜像', 'query', '["list_images"]', false),
  ('view_logs', '查看日志', '拉取和分析容器日志', 'query', '["get_logs"]', false),
  ('view_commits', '查看提交记录', '查看GitLab代码提交', 'query', '["get_gitlab_commits"]', false),
  ('deploy', '部署服务', '部署指定镜像到指定环境', 'action', '["request_approval","execute_deploy"]', true),
  ('rollback', '回滚服务', '回滚到上一版本', 'action', '["request_approval","execute_rollback"]', true),
  ('restart', '重启服务', '重启运行中的服务', 'action', '["request_approval","execute_restart"]', true),
  ('manage_role', '管理角色', '授予或撤销用户角色', 'admin', '["manage_role"]', true)
ON CONFLICT (key) DO NOTHING;
