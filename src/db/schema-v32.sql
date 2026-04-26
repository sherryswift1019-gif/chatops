-- v32: phase 2 — IM 入口职责从 capabilities 剥离到 im_triggers
-- 见 spec §3.1/§3.2/§5.2

-- ── 1. CREATE TABLE im_triggers ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS im_triggers (
  id                       SERIAL PRIMARY KEY,
  key                      TEXT NOT NULL UNIQUE,
  display_name             TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  pipeline_id              INTEGER REFERENCES test_pipelines(id) ON DELETE RESTRICT,
  intent_hints             TEXT NOT NULL DEFAULT '',
  examples                 JSONB NOT NULL DEFAULT '[]',
  failure_messages         JSONB NOT NULL DEFAULT '{}',
  default_approval_rule_id INTEGER REFERENCES approval_rules(id) ON DELETE SET NULL,
  is_system                BOOLEAN NOT NULL DEFAULT FALSE,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_im_triggers_pipeline ON im_triggers(pipeline_id);

-- pipeline_id 是 nullable: 数据迁移时 capabilities.default_pipeline_id 可能为 null;
-- 不影响 IM 触发(只在 trigger 时报"该入口未绑定 pipeline")。后续可改 NOT NULL。

-- ── 2. CREATE TABLE product_line_im_triggers ──────────────────────────────
CREATE TABLE IF NOT EXISTS product_line_im_triggers (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  im_trigger_key   TEXT NOT NULL REFERENCES im_triggers(key) ON UPDATE CASCADE ON DELETE CASCADE,
  env_name         TEXT NOT NULL DEFAULT '*',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_roles    JSONB NOT NULL DEFAULT '["developer","tester","ops","admin"]'::jsonb,
  trigger_sources  JSONB NOT NULL DEFAULT '["im","web"]'::jsonb,
  approval_rule_id INTEGER REFERENCES approval_rules(id) ON DELETE SET NULL,
  UNIQUE(product_line_id, im_trigger_key, env_name)
);
CREATE INDEX IF NOT EXISTS idx_plit_lookup
  ON product_line_im_triggers(product_line_id, im_trigger_key, env_name);

-- ── 3. ALTER approval_rules: action → im_trigger_key ──────────────────────
-- 幂等: 仅在旧列 action 还存在时改名(re-run migrate 不报错)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'approval_rules' AND column_name = 'action'
  ) THEN
    ALTER TABLE approval_rules RENAME COLUMN action TO im_trigger_key;
  END IF;
END $$;
-- 注:不立刻加 FK 约束(im_trigger_key 可能含通配符 '*'),保持灵活。
-- router.ts 的路由逻辑保留通配符语义。

-- ── 4. 数据迁移: capabilities → im_triggers ───────────────────────────────
-- 入口类 capability 定义: category IN ('query','action','admin')
-- 这是 spec §3.4 提到的"入口类"——其它 category(env_prep/verify/testing/result)
-- 是 2026-04-14 unified spec 残留,不是 IM 入口,跳过。
INSERT INTO im_triggers (key, display_name, description, pipeline_id, examples, failure_messages, is_system, enabled)
SELECT
  key,
  display_name,
  description,
  default_pipeline_id,
  COALESCE(
    -- 如果 capabilities 行已有 examples(罕见),拷贝过来;否则用空数组(后续 manual fill)
    CASE WHEN jsonb_typeof(NULLIF(playbook, 'null'::jsonb)) = 'array' THEN '[]'::jsonb ELSE '[]'::jsonb END,
    '[]'::jsonb
  ) AS examples,
  '{}'::jsonb AS failure_messages,
  is_system,
  TRUE  -- 默认 enabled
FROM capabilities
WHERE category IN ('query', 'action', 'admin')
ON CONFLICT (key) DO NOTHING;

-- ── 5. 数据迁移: product_line_capabilities → product_line_im_triggers ─────
-- 仅迁移 capability_key 在 im_triggers 里的行(避免外键违反)
-- 注: 显式确保 trigger_sources 列存在(v22 添加),让 resetTestDb 跳过 v22 的
-- 测试场景下 v32 仍能正常 SELECT plc.trigger_sources。生产环境 v22 已跑过,
-- IF NOT EXISTS 是 no-op。
ALTER TABLE product_line_capabilities
  ADD COLUMN IF NOT EXISTS trigger_sources JSONB NOT NULL DEFAULT '["im","web"]'::jsonb;

INSERT INTO product_line_im_triggers
  (product_line_id, im_trigger_key, env_name, enabled, allowed_roles, trigger_sources)
SELECT
  plc.product_line_id,
  plc.capability_key,
  plc.env_name,
  plc.enabled,
  plc.allowed_roles,
  plc.trigger_sources
FROM product_line_capabilities plc
WHERE EXISTS (SELECT 1 FROM im_triggers it WHERE it.key = plc.capability_key)
ON CONFLICT (product_line_id, im_trigger_key, env_name) DO NOTHING;

-- ── 6. 断言: im_triggers 至少有 5 行(基础入口能力数量下限) ───────────────
DO $$
DECLARE
  v_im_triggers_count INT;
  v_entry_caps_count INT;
BEGIN
  SELECT COUNT(*) INTO v_entry_caps_count
    FROM capabilities WHERE category IN ('query', 'action', 'admin');

  SELECT COUNT(*) INTO v_im_triggers_count FROM im_triggers;

  IF v_im_triggers_count < v_entry_caps_count THEN
    RAISE EXCEPTION 'schema-v32 数据迁移失败: im_triggers 行数(%)<入口类 capability 数(%)', v_im_triggers_count, v_entry_caps_count;
  END IF;

  IF v_im_triggers_count < 5 THEN
    RAISE EXCEPTION 'schema-v32 数据迁移失败: im_triggers 行数(%)异常少,期望 ≥5', v_im_triggers_count;
  END IF;

  RAISE NOTICE 'schema-v32 数据迁移验证通过: im_triggers=% / 入口类 capabilities=%', v_im_triggers_count, v_entry_caps_count;
END $$;
