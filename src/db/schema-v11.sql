-- schema-v11.sql: Pipeline 全链路动态编排
-- 1. 新建 bug_fix_events 表 + 索引
-- 2. bug_analysis_reports 扩展字段
-- 3. capabilities 表新增 3 条记录（approve_l3 / create_mr / notify_bug）
-- 4. test_pipelines 更新 L1/L2/L3 stages + 新建 L4

-- ============================================================
-- 1. bug_fix_events 表
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_fix_events (
  id            SERIAL PRIMARY KEY,
  report_id     INTEGER NOT NULL REFERENCES bug_analysis_reports(id),
  project_path  TEXT,
  code          VARCHAR(50) NOT NULL,  -- 允许值：analysis / scope_identified / create_issue / fix_attempt / create_mr / ai_review / approval / notify / lifecycle_sync
  status        VARCHAR(20) NOT NULL DEFAULT 'success',
  duration_ms   INTEGER,
  data          JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_fix_events_report
  ON bug_fix_events(report_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bug_fix_events_project
  ON bug_fix_events(report_id, project_path, code);

-- ============================================================
-- 2. bug_analysis_reports 扩展字段
-- ============================================================
ALTER TABLE bug_analysis_reports
  ADD COLUMN IF NOT EXISTS pipeline_run_id INTEGER REFERENCES test_runs(id),
  ADD COLUMN IF NOT EXISTS primary_project_path TEXT;

-- status 字段是 VARCHAR，无需改 enum；业务层使用以下取值：
-- 'draft' | 'published' | 'pipeline_success' | 'completed' | 'aborted'

-- ============================================================
-- 3. capabilities 表新增 3 条记录
-- ============================================================
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, is_system)
VALUES
  ('approve_l3', 'L3 方案审批',
   'L3 Bug 修复方案审批：给主仓库 owner 发审批 DM，给从仓库 owner 发知情 DM',
   'action', '[]'::jsonb, true, true),
  ('create_mr', '创建 MR',
   '对每个涉及的 project 创建 GitLab Merge Request，description 引用主 Issue',
   'action', '[]'::jsonb, false, true),
  ('notify_bug', '修复完成通知',
   'Pipeline 终态通知：L4 创建 / AI Review 需关注时 DM 给各涉及 project 负责人（owner）。本版不发触发人 DM（触发人通过 Bug 修复实例页面查看进度）',
   'action', '[]'::jsonb, false, true)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 4. test_pipelines 更新 L1/L2/L3 stages + 新建 L4
-- ============================================================

-- L1 Pipeline
UPDATE test_pipelines
SET stages = '[
  {
    "name": "L1 修复", "stageType": "capability", "capabilityKey": "fix_bug_l1",
    "timeoutSeconds": 1800, "retryCount": 0, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "创建 MR", "stageType": "capability", "capabilityKey": "create_mr",
    "timeoutSeconds": 300, "retryCount": 1, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "AI Review", "stageType": "capability", "capabilityKey": "ai_review_mr",
    "timeoutSeconds": 600, "retryCount": 0, "onFailure": "continue",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "通知", "stageType": "capability", "capabilityKey": "notify_bug",
    "timeoutSeconds": 120, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  }
]'::jsonb
WHERE name = 'L1-配置类';

-- L2 Pipeline
UPDATE test_pipelines
SET stages = '[
  {
    "name": "L2 修复", "stageType": "capability", "capabilityKey": "fix_bug_l2",
    "timeoutSeconds": 2400, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "创建 MR", "stageType": "capability", "capabilityKey": "create_mr",
    "timeoutSeconds": 300, "retryCount": 1, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "AI Review", "stageType": "capability", "capabilityKey": "ai_review_mr",
    "timeoutSeconds": 600, "retryCount": 0, "onFailure": "continue",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "通知", "stageType": "capability", "capabilityKey": "notify_bug",
    "timeoutSeconds": 120, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  }
]'::jsonb
WHERE name = 'L2-代码缺陷';

-- L3 Pipeline: approve_l3 是 stageType=capability（不是 approval）
-- 注意：capabilityParams.approvalTimeoutMs 必须与 stage.timeoutSeconds 保持同步
--       （handler 内部 fail-fast：未配置或非法会直接 return invalid_timeout）
UPDATE test_pipelines
SET stages = '[
  {
    "name": "方案审批", "stageType": "capability", "capabilityKey": "approve_l3",
    "timeoutSeconds": 3600, "retryCount": 0, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}", "approvalTimeoutMs": 3600000}
  },
  {
    "name": "L3 修复", "stageType": "capability", "capabilityKey": "fix_bug_l3",
    "timeoutSeconds": 2400, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "创建 MR", "stageType": "capability", "capabilityKey": "create_mr",
    "timeoutSeconds": 300, "retryCount": 1, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "AI Review", "stageType": "capability", "capabilityKey": "ai_review_mr",
    "timeoutSeconds": 600, "retryCount": 0, "onFailure": "continue",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "通知", "stageType": "capability", "capabilityKey": "notify_bug",
    "timeoutSeconds": 120, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  }
]'::jsonb
WHERE name = 'L3-业务逻辑';

-- L4 Pipeline（新建，单 stage）
INSERT INTO test_pipelines (product_line_id, name, description, stages, enabled, trigger_params, variables)
SELECT
  id AS product_line_id,
  'L4-复杂问题' AS name,
  '无自动修复能力的 Bug 分析结果，仅创建 Issue 并通知各涉及 project 负责人（owner）人工接手' AS description,
  '[
    {
      "name": "通知", "stageType": "capability", "capabilityKey": "notify_bug",
      "timeoutSeconds": 120, "retryCount": 2, "onFailure": "stop",
      "targetRoles": [], "parallel": false,
      "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
    }
  ]'::jsonb AS stages,
  true AS enabled,
  '{}'::jsonb AS trigger_params,
  '{}'::jsonb AS variables
FROM product_lines
WHERE name = 'pam'
  AND NOT EXISTS (SELECT 1 FROM test_pipelines WHERE name = 'L4-复杂问题');
