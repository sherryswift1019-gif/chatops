-- v49: capabilities 业务分类自动预填
UPDATE capabilities SET category = 'info_query' WHERE key IN (
  'view_deployments', 'view_images', 'view_logs', 'view_commits',
  'list_projects', 'view_branches', 'search_knowledge'
);

UPDATE capabilities SET category = 'ops' WHERE key IN (
  'deploy', 'rollback', 'restart', 'manage_role', 'custom_script'
);

UPDATE capabilities SET category = 'bug_fix' WHERE key IN (
  'analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3',
  'notify_bug', 'ai_review_mr', 'approve_l3', 'request_handover'
);

UPDATE capabilities SET category = 'feature_dev' WHERE key IN (
  'create_mr', 'create_prd', 'review_prd', 'create_arch',
  'prd_submit', 'prd_create_mr', 'prd_ai_review_mr', 'prd_notify'
);
