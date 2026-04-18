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
-- 7. AI 助手 Pipeline 模板（L1/L2/L3 修复流程）
-- ============================================================

-- L1 配置类 Bug 修复（不重试，一次搞定）
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L1-配置类', '不改代码，改配置/SQL/参数就能修。如初始化SQL缺失、错误码没加',
  '[{"name":"L1 修复","stageType":"capability","capabilityKey":"fix_bug_l1","timeoutSeconds":600,"retryCount":0,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}","issueId":"{{triggerParams.issueId}}"}}]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null,"issueId":null}'::jsonb,
  '{}'::jsonb
FROM product_lines WHERE name = 'pam'
ON CONFLICT DO NOTHING;

-- L2 简单代码 Bug 修复（含重试，最多 3 次）
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L2-代码缺陷', '代码有明确bug，修复方式确定。如并发缺同步、空指针、类型转换错误',
  '[{"name":"L2 修复","stageType":"capability","capabilityKey":"fix_bug_l2","timeoutSeconds":2400,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}","issueId":"{{triggerParams.issueId}}"}}]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null,"issueId":null}'::jsonb,
  '{}'::jsonb
FROM product_lines WHERE name = 'pam'
ON CONFLICT DO NOTHING;

-- L3 业务逻辑 Bug 修复（审批 + 修复）
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
SELECT id, 'L3-业务逻辑', '需要理解业务上下文才能判断对错。如流程判断错误、权限规则遗漏、状态机转换错误',
  '[{"name":"方案审批","stageType":"approval","timeoutSeconds":86400,"retryCount":0,"onFailure":"stop","targetRoles":[],"parallel":false,"approvalDescription":"L3 Bug 修复方案审批"},{"name":"L3 修复","stageType":"capability","capabilityKey":"fix_bug_l3","timeoutSeconds":2400,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}","issueId":"{{triggerParams.issueId}}"}}]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null,"issueId":null}'::jsonb,
  '{}'::jsonb
FROM product_lines WHERE name = 'pam'
ON CONFLICT DO NOTHING;
