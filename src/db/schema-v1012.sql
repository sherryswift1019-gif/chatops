-- v1012: Phase 3 product-reviewer config keys — Plan Stage Upgrade Phase 3 Task 16
-- 灰度期 qi.productReviewMode=warn 不阻断 pipeline；硬启用切 enforce
-- 上限 qi.planProductReviewMaxRetries=2 触底升级 plan_human_gate (source=product_review_max_retries)

INSERT INTO system_config (key, value, updated_at)
VALUES (
  'qi.productReviewMode',
  '"warn"'::jsonb,
  NOW()
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_config (key, value, updated_at)
VALUES (
  'qi.planProductReviewMaxRetries',
  '2'::jsonb,
  NOW()
)
ON CONFLICT (key) DO NOTHING;
