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
  role             TEXT NOT NULL CHECK (role IN ('developer','ops','admin')),
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

-- tool_permissions (overrides default tool roles per product line)
CREATE TABLE IF NOT EXISTS tool_permissions (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT REFERENCES product_lines(id) ON DELETE CASCADE,
  tool_name        TEXT NOT NULL,
  min_role         TEXT NOT NULL CHECK (min_role IN ('developer','ops','admin')),
  UNIQUE(product_line_id, tool_name)
);
