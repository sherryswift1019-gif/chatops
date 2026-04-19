-- base.sql: E2E 测试基础 seed
-- 每个 spec 运行前通过 resetTestDb() 重建 schema 后，由 globalSetup 执行此文件
-- 约定：所有 ON CONFLICT DO NOTHING，便于手动重复执行排错
--
-- 包含：
--   1. dingtalk_users — 测试角色：触发人、主仓库 owner、从仓库 owner
--   2. product_lines  — 'pam' 产品线
--   3. product_line_members — hanff 为 admin
--   4. product_knowledge_repos — pam 的 GitLab 路径前缀（测试中 gitlabUrl 指向 mock server）
--   5. projects — PAM/pas-api（主仓）、PAM/pas-web（从仓）
--   6. product_line_capabilities — pam 开启全部 capability
--   7. test_pipelines — L1/L2/L3/L4，stages 与 schema-v11.sql 保持一致

-- ============================================================
-- 1. dingtalk_users
-- ============================================================
INSERT INTO dingtalk_users (user_id, name) VALUES
  ('u-trigger',   '触发人'),
  ('u-primary',   '主负责人'),
  ('u-secondary', '从负责人')
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- 2. product_lines
-- ============================================================
INSERT INTO product_lines (name, display_name, description)
VALUES ('pam', 'PAM 特权访问管理', 'e2e 测试用')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 3. product_line_members — admin
-- ============================================================
INSERT INTO product_line_members (product_line_id, user_id, user_name, role)
SELECT id, 'u-trigger', '触发人', 'admin' FROM product_lines WHERE name = 'pam'
ON CONFLICT (product_line_id, user_id) DO NOTHING;

-- ============================================================
-- 4. product_knowledge_repos
-- ============================================================
INSERT INTO product_knowledge_repos (product_line_id, code_repo_url, code_default_branch, knowledge_repo_url, ai_summary_path)
SELECT id, 'http://mock-gitlab/PAM/pas-api.git', 'test', '', ''
FROM product_lines WHERE name = 'pam'
ON CONFLICT (product_line_id) DO NOTHING;

-- ============================================================
-- 5. projects — 主仓 + 从仓
-- ============================================================
INSERT INTO projects (product_line_id, name, display_name, gitlab_path, owner_id, owner_name)
SELECT id, 'pas-api', 'PAS API', 'PAM/pas-api', 'u-primary', '主负责人'
FROM product_lines WHERE name = 'pam'
ON CONFLICT (name) DO NOTHING;

INSERT INTO projects (product_line_id, name, display_name, gitlab_path, owner_id, owner_name)
SELECT id, 'pas-web', 'PAS Web', 'PAM/pas-web', 'u-secondary', '从负责人'
FROM product_lines WHERE name = 'pam'
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 6. product_line_capabilities — pam 开启全部（含 v11 新增的 approve_l3 / create_mr / notify_bug）
-- ============================================================
INSERT INTO product_line_capabilities (product_line_id, capability_key, env_name, enabled, allowed_roles)
SELECT pl.id, c.key, '*', true, '["developer","tester","ops","admin"]'::jsonb
FROM product_lines pl, capabilities c
WHERE pl.name = 'pam'
ON CONFLICT DO NOTHING;

-- 给 analyze_bug / fix_bug_l1/l2/l3 / ai_review_mr 等 capability 设置 system_prompt，
-- 否则 analyzer / reviewer 会因 systemPrompt 为空直接返回错误（生产由 seed.sql 注入，
-- 但 resetTestDb 不跑 seed.sql，故在这里为 e2e 最小化补齐）。
UPDATE capabilities SET system_prompt = COALESCE(system_prompt, '你是 Bug 分析/修复专家（e2e stub prompt）。')
 WHERE key IN ('analyze_bug','fix_bug_l1','fix_bug_l2','fix_bug_l3','ai_review_mr','search_knowledge');

-- ============================================================
-- 7. test_pipelines — L1/L2/L3/L4，stages JSON 与 schema-v11.sql 等价
-- ============================================================

-- L1-配置类
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L1-配置类', '不改代码，改配置/SQL/参数就能修',
  '[
    {"name":"L1 修复","stageType":"capability","capabilityKey":"fix_bug_l1","timeoutSeconds":1800,"retryCount":0,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"创建 MR","stageType":"capability","capabilityKey":"create_mr","timeoutSeconds":300,"retryCount":1,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"AI Review","stageType":"capability","capabilityKey":"ai_review_mr","timeoutSeconds":600,"retryCount":0,"onFailure":"continue","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true, '{"reportId":null}'::jsonb, '{}'::jsonb
FROM product_lines WHERE name = 'pam'
  AND NOT EXISTS (SELECT 1 FROM test_pipelines WHERE name = 'L1-配置类');

-- L2-代码缺陷
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L2-代码缺陷', '代码有明确 bug，修复方式确定',
  '[
    {"name":"L2 修复","stageType":"capability","capabilityKey":"fix_bug_l2","timeoutSeconds":2400,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"创建 MR","stageType":"capability","capabilityKey":"create_mr","timeoutSeconds":300,"retryCount":1,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"AI Review","stageType":"capability","capabilityKey":"ai_review_mr","timeoutSeconds":600,"retryCount":0,"onFailure":"continue","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true, '{"reportId":null}'::jsonb, '{}'::jsonb
FROM product_lines WHERE name = 'pam'
  AND NOT EXISTS (SELECT 1 FROM test_pipelines WHERE name = 'L2-代码缺陷');

-- L3-业务逻辑（approve_l3 作为 capability stage）
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L3-业务逻辑', '需要理解业务上下文才能判断对错',
  '[
    {"name":"方案审批","stageType":"capability","capabilityKey":"approve_l3","timeoutSeconds":3600,"retryCount":0,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"L3 修复","stageType":"capability","capabilityKey":"fix_bug_l3","timeoutSeconds":2400,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"创建 MR","stageType":"capability","capabilityKey":"create_mr","timeoutSeconds":300,"retryCount":1,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"AI Review","stageType":"capability","capabilityKey":"ai_review_mr","timeoutSeconds":600,"retryCount":0,"onFailure":"continue","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true, '{"reportId":null}'::jsonb, '{}'::jsonb
FROM product_lines WHERE name = 'pam'
  AND NOT EXISTS (SELECT 1 FROM test_pipelines WHERE name = 'L3-业务逻辑');

-- L4-复杂问题（仅 notify）
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L4-复杂问题', '无自动修复能力，仅创建 Issue 并通知各涉及 project 负责人（owner）人工接手',
  '[
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true, '{"reportId":null}'::jsonb, '{}'::jsonb
FROM product_lines WHERE name = 'pam'
  AND NOT EXISTS (SELECT 1 FROM test_pipelines WHERE name = 'L4-复杂问题');
