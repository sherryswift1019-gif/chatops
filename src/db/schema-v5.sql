-- ============================================================
-- schema-v5: Split stage operations from capabilities
-- ============================================================
-- B 类阶段操作从 capabilities 拆到独立 stage_operations 表
-- capabilities 表只保留 A 类（用户意图）+ C 类（流水线包装）

-- 1. 创建 stage_operations 表
CREATE TABLE IF NOT EXISTS stage_operations (
  id           SERIAL PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description  TEXT DEFAULT '',
  category     TEXT NOT NULL CHECK (category IN ('env_prep','verify','testing','result','action')),
  tool_names   JSONB NOT NULL DEFAULT '[]',
  param_schema JSONB NOT NULL DEFAULT '{}',
  playbook     JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 从 capabilities 迁移 B 类记录到 stage_operations
--    包括纯 B 类 + 同时用作 stage 的 A 类（deploy/rollback/restart/custom_script）
INSERT INTO stage_operations (key, display_name, description, category, tool_names, param_schema, playbook)
SELECT key, display_name, description, category, tool_names, param_schema, playbook
FROM capabilities
WHERE key IN (
  'env_init', 'env_cleanup', 'health_check', 'auto_test',
  'log_collect', 'report_gen', 'custom_script',
  'deploy', 'rollback', 'restart'
)
ON CONFLICT (key) DO NOTHING;

-- 3. 从 capabilities 删除纯 B 类记录
--    保留 custom_script/deploy/rollback/restart（它们同时是 A 类用户意图）
DELETE FROM capabilities
WHERE key IN ('env_init', 'env_cleanup', 'health_check', 'auto_test', 'log_collect', 'report_gen');

-- 4. 清理 product_line_capabilities 中对应的纯 B 类记录
DELETE FROM product_line_capabilities
WHERE capability_key IN ('env_init', 'env_cleanup', 'health_check', 'auto_test', 'log_collect', 'report_gen');
