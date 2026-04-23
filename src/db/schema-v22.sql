-- v22: 产线内能力 IM 触发开关
-- 新增 trigger_sources JSONB 白名单，控制该能力在该产线下允许的触发源。
-- 值枚举：'im'（IM 群聊）、'web'（管理后台手动，v1 预留）；未来扩展 schedule/webhook。
-- 默认 ["im","web"]：向后兼容，迁移后现有数据等价于全部允许。

ALTER TABLE product_line_capabilities
  ADD COLUMN IF NOT EXISTS trigger_sources JSONB NOT NULL DEFAULT '["im","web"]'::jsonb;
