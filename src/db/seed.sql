-- seed.sql: 研发 AI 助手初始化数据（PAM 产品线）
-- 在 schema 迁移后执行：DATABASE_URL=... psql -f src/db/seed.sql
-- 幂等：所有 INSERT 用 ON CONFLICT DO NOTHING

-- ============================================================
-- 1. 产品线
-- ============================================================
INSERT INTO product_lines (name, display_name, description)
VALUES ('pam', 'PAM 特权访问管理', '堡垒机、密码管理、审计等')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 2. 成员（hanff = admin）
-- ============================================================
INSERT INTO product_line_members (product_line_id, user_id, user_name, role)
SELECT id, '183832601538060368', 'hanff', 'admin'
FROM product_lines WHERE name = 'pam'
AND NOT EXISTS (
  SELECT 1 FROM product_line_members
  WHERE user_id = '183832601538060368' AND product_line_id = (SELECT id FROM product_lines WHERE name = 'pam')
);

-- ============================================================
-- 3. 为 PAM 启用所有 capability（全角色、全环境）
-- ============================================================
INSERT INTO product_line_capabilities (product_line_id, capability_key, env_name, enabled, allowed_roles)
SELECT pl.id, c.key, '*', true, '["developer","tester","ops","admin"]'::jsonb
FROM product_lines pl, capabilities c
WHERE pl.name = 'pam'
ON CONFLICT DO NOTHING;

-- ============================================================
-- 4. PAM 代码仓库 + 知识库配置
-- ============================================================
INSERT INTO product_knowledge_repos (product_line_id, code_repo_url, code_default_branch, knowledge_repo_url, ai_summary_path)
SELECT id, 'http://code.paraview.cn/PAM/java-code/pas-6.0.git', 'test', '', 'docs/ai-summary'
FROM product_lines WHERE name = 'pam'
ON CONFLICT (product_line_id) DO NOTHING;

-- ============================================================
-- 5. 模块 → 负责人映射
-- ============================================================
INSERT INTO module_owners (product_line_id, module_pattern, owner_user_id, backup_owner_user_id)
SELECT id, 'pas-secret-task', '183832601538060368', NULL FROM product_lines WHERE name = 'pam'
ON CONFLICT (product_line_id, module_pattern) DO NOTHING;

INSERT INTO module_owners (product_line_id, module_pattern, owner_user_id, backup_owner_user_id)
SELECT id, 'pas-bastion-host', '183832601538060368', NULL FROM product_lines WHERE name = 'pam'
ON CONFLICT (product_line_id, module_pattern) DO NOTHING;

-- ============================================================
-- 6. AI 助手 capability systemPrompt
-- ============================================================
UPDATE capabilities SET
  system_prompt = '你是一个 Bug 分析专家，服务于研发团队。用户描述问题后，使用 MCP 工具读代码定位根因，输出分析报告。信息不足时可以反问。只使用提供的 MCP 工具。',
  default_system_prompt = system_prompt
WHERE key = 'analyze_bug' AND system_prompt IS NULL;

UPDATE capabilities SET
  system_prompt = '你是代码修复专家。基于分析报告修复 Bug。',
  default_system_prompt = system_prompt
WHERE key IN ('fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3') AND system_prompt IS NULL;

UPDATE capabilities SET
  system_prompt = '你是独立代码审查专家。审查 MR diff，标记风险。',
  default_system_prompt = system_prompt
WHERE key = 'ai_review_mr' AND system_prompt IS NULL;

UPDATE capabilities SET
  system_prompt = '你是知识库查询助手。查询知识库，命中时返回历史方案。',
  default_system_prompt = system_prompt
WHERE key = 'search_knowledge' AND system_prompt IS NULL;

-- ============================================================
-- 7. AI 助手 Pipeline 模板（L1/L2/L3/L4）
-- 注意：stages 结构与 schema-v11.sql 的 UPDATE/INSERT 保持一致；
-- 新环境走 seed.sql 初始化后即可直接跑全链路（analyze → fix → create_mr → ai_review → notify）。
-- ============================================================

-- L1 配置类 Bug 修复
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L1-配置类', '不改代码，改配置/SQL/参数就能修。如初始化SQL缺失、错误码没加',
  '[
    {"name":"L1 修复","stageType":"capability","capabilityKey":"fix_bug_l1","timeoutSeconds":1800,"retryCount":0,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"创建 MR","stageType":"capability","capabilityKey":"create_mr","timeoutSeconds":300,"retryCount":1,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"AI Review","stageType":"capability","capabilityKey":"ai_review_mr","timeoutSeconds":600,"retryCount":0,"onFailure":"continue","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null}'::jsonb,
  '{}'::jsonb
FROM product_lines WHERE name = 'pam'
ON CONFLICT DO NOTHING;

-- L2 简单代码 Bug 修复（含重试，最多 3 次）
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L2-代码缺陷', '代码有明确bug，修复方式确定。如并发缺同步、空指针、类型转换错误',
  '[
    {"name":"L2 修复","stageType":"capability","capabilityKey":"fix_bug_l2","timeoutSeconds":2400,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"创建 MR","stageType":"capability","capabilityKey":"create_mr","timeoutSeconds":300,"retryCount":1,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"AI Review","stageType":"capability","capabilityKey":"ai_review_mr","timeoutSeconds":600,"retryCount":0,"onFailure":"continue","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null}'::jsonb,
  '{}'::jsonb
FROM product_lines WHERE name = 'pam'
ON CONFLICT DO NOTHING;

-- L3 业务逻辑 Bug 修复（capability 化审批 + 修复，approvalTimeoutMs 必须显式配置）
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L3-业务逻辑', '需要理解业务上下文才能判断对错。如流程判断错误、权限规则遗漏、状态机转换错误',
  '[
    {"name":"方案审批","stageType":"capability","capabilityKey":"approve_l3","timeoutSeconds":3600,"retryCount":0,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}","approvalTimeoutMs":3600000}},
    {"name":"L3 修复","stageType":"capability","capabilityKey":"fix_bug_l3","timeoutSeconds":2400,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"创建 MR","stageType":"capability","capabilityKey":"create_mr","timeoutSeconds":300,"retryCount":1,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"AI Review","stageType":"capability","capabilityKey":"ai_review_mr","timeoutSeconds":600,"retryCount":0,"onFailure":"continue","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null}'::jsonb,
  '{}'::jsonb
FROM product_lines WHERE name = 'pam'
ON CONFLICT DO NOTHING;

-- L4 复杂问题（无自动修复，仅创建 Issue + DM 各 project owner 人工接手）
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L4-复杂问题', '无自动修复能力的 Bug 分析结果，仅创建 Issue 并通知各涉及 project 负责人（owner）人工接手',
  '[
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null}'::jsonb,
  '{}'::jsonb
FROM product_lines WHERE name = 'pam'
ON CONFLICT DO NOTHING;
