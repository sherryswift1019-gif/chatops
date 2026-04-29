-- v57: im_triggers 新增 category 字段，用于 greet 分类展示
-- 枚举值：info（信息抓取）/ ops（运维操作）/ bug（Bug 修复）/ feature（需求开发）
ALTER TABLE im_triggers
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'ops';

-- 为已知触发器按语义分配分类
UPDATE im_triggers SET category = 'info' WHERE key IN (
  'list_projects', 'search_knowledge',
  'view_branches', 'view_commits', 'view_deployments', 'view_images', 'view_logs'
);

UPDATE im_triggers SET category = 'bug' WHERE key IN (
  'analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3', 'notify_bug'
);

UPDATE im_triggers SET category = 'feature' WHERE key IN (
  'create_arch', 'create_mr', 'create_prd', 'review_prd',
  'prd_submit', 'prd_create_mr', 'prd_notify', 'prd_ai_review_mr',
  'ai_review_mr', 'approve_l3'
);

-- 其余（deploy, restart, rollback, custom_script, request_handover, manage_role 等）
-- 保持默认 ops，无需显式 UPDATE
