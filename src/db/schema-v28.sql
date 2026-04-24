-- ============================================================
-- schema-v28: PRD 主动提交 MR Pipeline
--   - 新事件表 prd_submit_events（仿 bug_fix_events）
--   - dingtalk_users 增 email 列 + 函数式索引（LOWER(email) 反查 user_id）
--   - 4 个 capability: prd_submit / prd_create_mr / prd_ai_review_mr / prd_notify
--   - 3-stage pipeline 种子: prd_create_mr → prd_ai_review_mr → prd_notify
--
-- 关键设计：
--   - prd_submit 不设 default_pipeline_id——走 handler-path，handler 内部
--     显式调用 runPipeline(...)（与 coordinator 对 defaultPipelineId 的行为互斥）
--   - 所有 stage 的 onFailure='continue'——保证 stage 3 `prd_notify` 始终
--     触发发 DM，即便上游 1/2 失败（硬约束：coordinator 零改动）
--   - prd_ai_review_mr.system_prompt 初始为 NULL，由 migrate.ts 两段式 UPDATE
--     从 src/agent/prd-submit/prompts.ts 注入（admin 手改保留，同 create_prd 模式）
--
-- id 段规划（延续 v26 约定"unix 时间戳 1776868065 起"）：
--   1776868081 = prd_submit         (handler-path 入口)
--   1776868082 = prd_create_mr      (pipeline stage 1)
--   1776868083 = prd_ai_review_mr   (pipeline stage 2)
--   1776868084 = prd_notify         (pipeline stage 3)
--   1776868085 = pipeline 种子 id
-- ============================================================

-- ─── 1. 事件表 ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prd_submit_events (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   TEXT NOT NULL,
  project_path    TEXT,
  code            TEXT NOT NULL,        -- prd_submit_requested | prd_create_mr | prd_ai_review_mr | prd_notify
  status          TEXT NOT NULL,        -- success | failed | running
  duration_ms     INT,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prd_submit_events_submission
  ON prd_submit_events (submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prd_submit_events_code
  ON prd_submit_events (submission_id, code);

-- ─── 2. dingtalk_users.email + 函数式索引 ───────────────────
-- 查询用 LOWER(email) = LOWER($1)，普通 (email) 索引不命中；必须函数式索引。
-- IF NOT EXISTS 保证幂等，未来若其他 feature 也要此列无冲突。

ALTER TABLE dingtalk_users ADD COLUMN IF NOT EXISTS email TEXT;
CREATE INDEX IF NOT EXISTS idx_dingtalk_users_email_lower
  ON dingtalk_users (LOWER(email));

-- ─── 3. 4 个 capability（INSERT ON CONFLICT DO NOTHING，保留 admin 编辑）─

-- 不用 v26 的 DELETE + INSERT 模式：v26 的 6 条 capability 是"代码是 prompt 唯一真相源，
-- admin 手改下次 migrate 被覆盖"；但本 feature 的 prd_ai_review_mr 需要 admin 可编辑
-- prompt（PRD §3.4 + §9.2）。DELETE 会把 admin 手改的 system_prompt 一起干掉，
-- 让下面 migrate.ts 的两段式 UPDATE 每次都从 NULL 重新注入代码版 prompt。
-- 改成 ON CONFLICT DO NOTHING：首次 migrate 新建 row，后续 migrate 对已存在 row
-- 是 no-op；system_prompt 的注入/覆盖完全交给 migrate.ts 的两段式 UPDATE 策略
-- 决定（见 create_prd / review_prd 已有模式）。
-- 代价：display_name / description 的更新需要通过手工 UPDATE 或 admin 后台；
-- 这 4 条 capability 的元数据 MVP 不太可能变动。

-- prd_submit: IM @agent 入口，handler-path，不设 default_pipeline_id
INSERT INTO capabilities (id, key, display_name, description, category, tool_names, needs_approval, is_system, system_prompt, default_system_prompt)
VALUES (1776868081, 'prd_submit', 'PRD MR 提交（入口）',
  'IM @agent 触发：解析指令 + URL + authorEmail 反查 → 显式启动 PRD MR pipeline',
  'action', '[]'::jsonb, false, true,
  NULL, NULL)
ON CONFLICT (key) DO NOTHING;

-- prd_create_mr: pipeline stage 1，负责 commit log 派生标题 + 新建或复用 MR + 强制 Draft
INSERT INTO capabilities (id, key, display_name, description, category, tool_names, needs_approval, is_system, system_prompt, default_system_prompt)
VALUES (1776868082, 'prd_create_mr', 'PRD 创建 MR',
  '派生 MR 标题（commit log 或 override）+ 新建或复用 open MR；始终置 Draft 状态（merge 闸门）',
  'action', '[]'::jsonb, false, true,
  NULL, NULL)
ON CONFLICT (key) DO NOTHING;

-- prd_ai_review_mr: pipeline stage 2，Claude review + JSON 解析 + pass 时解除 Draft
-- system_prompt 由 migrate.ts 从 prompts.ts 注入；admin 后台可编辑，两段式 UPDATE 保留
INSERT INTO capabilities (id, key, display_name, description, category, tool_names, needs_approval, is_system, system_prompt, default_system_prompt)
VALUES (1776868083, 'prd_ai_review_mr', 'PRD AI Review',
  '读 MR diff + Claude 结构化 review（JSON 输出）+ 回写 MR 评论；pass 时移除 Draft 前缀解锁 merge',
  'action', '[]'::jsonb, false, true,
  NULL, NULL)
ON CONFLICT (key) DO NOTHING;

-- prd_notify: pipeline stage 3，按 submissionId 汇总事件 + DM 提交者
INSERT INTO capabilities (id, key, display_name, description, category, tool_names, needs_approval, is_system, system_prompt, default_system_prompt)
VALUES (1776868084, 'prd_notify', 'PRD DM 回报',
  '汇总 prd_submit_events 后按 authorEmail → dingtalk_users.email → user_id 查到钉钉账号并 DM',
  'action', '[]'::jsonb, false, true,
  NULL, NULL)
ON CONFLICT (key) DO NOTHING;

-- ─── 4. Pipeline 种子（3 stage，全部 onFailure:continue）────

INSERT INTO test_pipelines (id, product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables)
VALUES (1776868085,
  (SELECT id FROM product_lines WHERE name = 'pam'),
  'PRD 主动提交 MR',
  'IM @agent 触发：开 MR（Draft） → AI review → DM 提交者。全 stage onFailure:continue 保证通知始终触达。',
  '[
    {
      "name": "PRD create MR",
      "stageType": "capability",
      "capabilityKey": "prd_create_mr",
      "timeoutSeconds": 300,
      "retryCount": 1,
      "onFailure": "continue",
      "targetRoles": [],
      "parallel": false,
      "capabilityParams": {
        "submissionId": "{{triggerParams.submissionId}}",
        "projectPath": "{{triggerParams.projectPath}}",
        "sourceBranch": "{{triggerParams.sourceBranch}}",
        "targetBranch": "{{triggerParams.targetBranch}}",
        "mrFilePath": "{{triggerParams.mrFilePath}}",
        "title": "{{triggerParams.title}}",
        "authorEmail": "{{triggerParams.authorEmail}}"
      }
    },
    {
      "name": "PRD AI review",
      "stageType": "capability",
      "capabilityKey": "prd_ai_review_mr",
      "timeoutSeconds": 900,
      "retryCount": 0,
      "onFailure": "continue",
      "targetRoles": [],
      "parallel": false,
      "capabilityParams": {
        "submissionId": "{{triggerParams.submissionId}}",
        "projectPath": "{{triggerParams.projectPath}}"
      }
    },
    {
      "name": "PRD notify",
      "stageType": "capability",
      "capabilityKey": "prd_notify",
      "timeoutSeconds": 120,
      "retryCount": 2,
      "onFailure": "continue",
      "targetRoles": [],
      "parallel": false,
      "capabilityParams": {
        "submissionId": "{{triggerParams.submissionId}}",
        "authorEmail": "{{triggerParams.authorEmail}}"
      }
    }
  ]'::jsonb,
  '{}'::jsonb, '', true,
  '{"submissionId":null,"projectPath":null,"sourceBranch":null,"targetBranch":null,"mrFilePath":null,"title":null,"authorEmail":null}'::jsonb,
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
  updated_at = NOW();

-- 注意：不 UPDATE capabilities.default_pipeline_id for prd_submit
-- 原因：prd_submit 走 handler-path；coordinator.ts 对有 defaultPipelineId 的
-- capability 会直接 runPipeline 跳过 handler（IM 解析逻辑无法执行）
