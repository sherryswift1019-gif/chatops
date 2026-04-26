-- ============================================================
-- schema-v30: PRD 主动提交 MR Pipeline —— 身份从 email 切到 imUserId
--   - 1776868085 这条 pipeline 的 stages JSONB / trigger_params 把
--     `{{triggerParams.authorEmail}}` 全换成 `{{triggerParams.imUserId}}`
--   - capabilities 表 prd_submit / prd_notify 的 description 同步更新文案
--
-- 注：原打算占用 v29，但 main 上 v29 已被 product_lines FK CASCADE 修复
-- (commit 8e0b759) 抢先用掉，rebase 时把本 migration 让到 v30。
--
-- 设计动因（与 notify_bug 对齐）：
--   notify_bug 直接拿 projects.owner_id（dingtalk userId）发 DM，不绕 email。
--   prd_submit 入口本来就握有钉钉 userId（来自 IM 适配层），绕一圈 email 反查
--   只是徒增依赖（必须先把 dingtalk_users.email 列填上才能用，且 GitLab 上
--   MR description 显示邮箱不如显示中文姓名友好）。本 v30 切到 userId 路线。
--
-- 兼容性：
--   - dingtalk_users.email 列 / 函数式索引保持不动（其他 feature 可能用）
--   - 历史 prd_submit_events.data.authorEmail 字段不变（read-only 历史）
--   - in-flight pipeline run 在部署窗口里：stage 3 因 imUserId 取不到 DM 失败，
--     但 onFailure=continue 不影响 pipeline 整体收尾。低概率边缘情况。
-- ============================================================

-- ─── 1. 更新 pipeline 1776868085 的 stages 和 trigger_params ──

UPDATE test_pipelines
SET stages = '[
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
        "imUserId": "{{triggerParams.imUserId}}"
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
        "imUserId": "{{triggerParams.imUserId}}"
      }
    }
  ]'::jsonb,
  trigger_params = '{"submissionId":null,"projectPath":null,"sourceBranch":null,"targetBranch":null,"mrFilePath":null,"title":null,"imUserId":null}'::jsonb,
  updated_at = NOW()
WHERE id = 1776868085;

-- ─── 2. 同步 capability 描述文案（cosmetic，对运行时无影响）─────

UPDATE capabilities
  SET description = 'IM @agent 触发：解析指令 + URL + 钉钉账号校验 → 显式启动 PRD MR pipeline',
      updated_at = NOW()
WHERE key = 'prd_submit';

UPDATE capabilities
  SET description = '汇总 prd_submit_events 后直接用 imUserId（钉钉 userId）DM 提交者',
      updated_at = NOW()
WHERE key = 'prd_notify';
