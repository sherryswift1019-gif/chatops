-- ============================================================
-- schema-v25: PAM 产线依赖 bootstrap（每次 migrate 都跑，ON CONFLICT DO NOTHING 幂等）
-- 原本命名为 schema-v21；upstream main 合并时 v21 已被 view_branches 能力占用，
-- v22（trigger_sources）/ v23（PRD metrics）/ v24（Arch Agent 表）亦已分配，挪号到 v25。
-- ============================================================
-- 内容：产线依赖的初始化数据
--   §1 产品线 pam
--   §2 成员 hanff = admin
--   §3 pam 下模块 pas（owner=hanff）
--   §4 pam 启用全部 capability
--   §5 pam 代码仓库 / 知识库配置
--   §6 L1-L4 Pipeline 模板
--
-- 幂等：
--   §1-§5 用 ON CONFLICT DO NOTHING（保护管理员 Web UI 对产线/成员/仓库/模块的手改）
--   §6   用 DELETE by name + INSERT with timestamp id（强制刷新 L1-L4 pipeline 模板，
--        跟 schema-v26 capability prompt 同语义——代码是模板真相源）
-- ============================================================

-- §1 产品线
INSERT INTO product_lines (name, display_name, description)
VALUES ('pam', 'PAM 特权访问管理', '堡垒机、密码管理、审计等')
ON CONFLICT (name) DO NOTHING;

-- §2 成员（hanff = admin）
INSERT INTO product_line_members (product_line_id, user_id, user_name, role)
SELECT id, '183832601538060368', 'hanff', 'admin'
FROM product_lines WHERE name = 'pam'
AND NOT EXISTS (
  SELECT 1 FROM product_line_members
  WHERE user_id = '183832601538060368' AND product_line_id = (SELECT id FROM product_lines WHERE name = 'pam')
);

-- §3 PAM 下的模块（project），owner = §2 里的 hanff
INSERT INTO projects (product_line_id, name, display_name, gitlab_path, owner_id, owner_name)
SELECT pl.id, 'pas', 'PAS', 'PAM/java-code/pas-6.0', '183832601538060368', 'hanff'
FROM product_lines pl WHERE pl.name = 'pam'
ON CONFLICT (name) DO NOTHING;

-- §4 为 PAM 启用所有 capability（全角色、全环境）
INSERT INTO product_line_capabilities (product_line_id, capability_key, env_name, enabled, allowed_roles)
SELECT pl.id, c.key, '*', true, '["developer","tester","ops","admin"]'::jsonb
FROM product_lines pl, capabilities c
WHERE pl.name = 'pam'
ON CONFLICT DO NOTHING;

-- §5 PAM 代码仓库 + 知识库配置
INSERT INTO product_knowledge_repos (product_line_id, code_repo_url, code_default_branch, knowledge_repo_url, ai_summary_path)
SELECT id, 'http://code.paraview.cn/PAM/java-code/pas-6.0.git', 'test', '', 'docs/ai-summary'
FROM product_lines WHERE name = 'pam'
ON CONFLICT (product_line_id) DO NOTHING;

-- ============================================================
-- §6 L1-L4 Pipeline 模板
-- 幂等策略：INSERT with timestamp id + ON CONFLICT (id) DO UPDATE
--   - 低位 id (1..4) 会跟 Web UI 用 SERIAL 新建的 pipeline 撞；改用 1.7B 时间戳 id 避免
--   - 不用 DELETE：DELETE 会 CASCADE 到 test_runs，而 test_runs 被
--     bug_analysis_reports.pipeline_run_id FK 引用，开发 DB 跑过 run 后再 migrate 会 FK 失败
--   - ON CONFLICT DO UPDATE：首次 INSERT，复跑时刷新 stages/description 等字段，历史
--     test_runs / bug_analysis_reports 不受影响
--
-- id 段规划（接 v22 的序列）：
--   1776868071 = L1-配置类
--   1776868072 = L2-代码缺陷
--   1776868073 = L3-业务逻辑
--   1776868074 = L4-复杂问题
-- ============================================================

-- L1 配置类 Bug 修复
INSERT INTO test_pipelines (id, product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
VALUES (1776868071,
  (SELECT id FROM product_lines WHERE name = 'pam'),
  'L1-配置类', '不改代码，改配置/SQL/参数就能修。如初始化SQL缺失、错误码没加',
  '[
    {"name":"L1 修复","stageType":"capability","capabilityKey":"fix_bug_l1","timeoutSeconds":1800,"retryCount":0,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"创建 MR","stageType":"capability","capabilityKey":"create_mr","timeoutSeconds":300,"retryCount":1,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"AI Review","stageType":"capability","capabilityKey":"ai_review_mr","timeoutSeconds":600,"retryCount":0,"onFailure":"continue","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null}'::jsonb,
  '{}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  product_line_id = EXCLUDED.product_line_id,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  stages = EXCLUDED.stages,
  server_roles = EXCLUDED.server_roles,
  schedule = EXCLUDED.schedule,
  enabled = EXCLUDED.enabled,
  trigger_params = EXCLUDED.trigger_params,
  variables = EXCLUDED.variables,
  updated_at = now();

-- L2 简单代码 Bug 修复（含重试，最多 3 次）
INSERT INTO test_pipelines (id, product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
VALUES (1776868072,
  (SELECT id FROM product_lines WHERE name = 'pam'),
  'L2-代码缺陷', '代码有明确bug，修复方式确定。如并发缺同步、空指针、类型转换错误',
  '[
    {"name":"L2 修复","stageType":"capability","capabilityKey":"fix_bug_l2","timeoutSeconds":2400,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"创建 MR","stageType":"capability","capabilityKey":"create_mr","timeoutSeconds":300,"retryCount":1,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"AI Review","stageType":"capability","capabilityKey":"ai_review_mr","timeoutSeconds":600,"retryCount":0,"onFailure":"continue","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null}'::jsonb,
  '{}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  product_line_id = EXCLUDED.product_line_id,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  stages = EXCLUDED.stages,
  server_roles = EXCLUDED.server_roles,
  schedule = EXCLUDED.schedule,
  enabled = EXCLUDED.enabled,
  trigger_params = EXCLUDED.trigger_params,
  variables = EXCLUDED.variables,
  updated_at = now();

-- L3 业务逻辑 Bug 修复（方案审批 + 修复）
-- approval stage 用 approverIdsResolver='primary_project_owner' 运行时动态查主仓库 owner
-- (见 src/pipeline/approval-resolvers.ts 和 src/agent/approval/resolvers.ts)
INSERT INTO test_pipelines (id, product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
VALUES (1776868073,
  (SELECT id FROM product_lines WHERE name = 'pam'),
  'L3-业务逻辑', '业务逻辑类 Bug。第一步"方案审批"发钉钉卡片给主仓库 owner 等同意/拒绝（resolver 动态查，不需在配置里硬编码审批人），同意后才开始 fix → MR → Review → 通知。从仓库 owner 在 pipeline 启动时会收到 FYI 知情 DM（由 coordinator 发送，非审批）。',
  '[
    {"name":"方案审批","stageType":"approval","approverIdsResolver":"primary_project_owner","approvalDescription":"L3 Bug 修复方案审批","timeoutSeconds":3600,"retryCount":0,"onFailure":"stop","targetRoles":[],"parallel":false},
    {"name":"L3 修复","stageType":"capability","capabilityKey":"fix_bug_l3","timeoutSeconds":2400,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"创建 MR","stageType":"capability","capabilityKey":"create_mr","timeoutSeconds":300,"retryCount":1,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"AI Review","stageType":"capability","capabilityKey":"ai_review_mr","timeoutSeconds":600,"retryCount":0,"onFailure":"continue","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}},
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null}'::jsonb,
  '{}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  product_line_id = EXCLUDED.product_line_id,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  stages = EXCLUDED.stages,
  server_roles = EXCLUDED.server_roles,
  schedule = EXCLUDED.schedule,
  enabled = EXCLUDED.enabled,
  trigger_params = EXCLUDED.trigger_params,
  variables = EXCLUDED.variables,
  updated_at = now();

-- L4 复杂问题（无自动修复，仅创建 Issue + DM 各 project owner 人工接手）
INSERT INTO test_pipelines (id, product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
VALUES (1776868074,
  (SELECT id FROM product_lines WHERE name = 'pam'),
  'L4-复杂问题', '无自动修复能力的 Bug 分析结果，仅创建 Issue 并通知各涉及 project 负责人（owner）人工接手',
  '[
    {"name":"通知","stageType":"capability","capabilityKey":"notify_bug","timeoutSeconds":120,"retryCount":2,"onFailure":"stop","targetRoles":[],"parallel":false,"capabilityParams":{"reportId":"{{triggerParams.reportId}}"}}
  ]'::jsonb,
  '{}'::jsonb, '', true,
  '{"reportId":null}'::jsonb,
  '{}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  product_line_id = EXCLUDED.product_line_id,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  stages = EXCLUDED.stages,
  server_roles = EXCLUDED.server_roles,
  schedule = EXCLUDED.schedule,
  enabled = EXCLUDED.enabled,
  trigger_params = EXCLUDED.trigger_params,
  variables = EXCLUDED.variables,
  updated_at = now();

-- 不需要 setval：显式指定大 id 不会推进 SERIAL 序列。Web UI 新建 pipeline 仍从序列自然位拿小 id，跟 1.7B 隔很远。
