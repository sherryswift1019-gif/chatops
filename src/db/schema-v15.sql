-- ============================================================
-- schema-v15: Bind a default pipeline to a capability (IM-triggered)
-- 原本命名为 schema-v13；因 upstream 在 main 上已占用 v13（handover），
-- 合并 main 时挪号到 v15。
-- ============================================================
--
-- 当 IM 消息触发某 capability 时，若 default_pipeline_id 非空，
-- coordinator 将启动对应 pipeline（通常首节点为 im_input 参数澄清 stage），
-- 不再直接裸跑 Agent。这样 IM 对话式操作也具备 pipeline 的审批/容错/回滚能力。
--
-- ON DELETE SET NULL：pipeline 删除时，binding 自动解除，不连带删除 capability。

ALTER TABLE capabilities
  ADD COLUMN IF NOT EXISTS default_pipeline_id INTEGER
    REFERENCES test_pipelines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_capabilities_default_pipeline
  ON capabilities(default_pipeline_id)
  WHERE default_pipeline_id IS NOT NULL;

-- 扩展 test_runs.trigger_type CHECK 以容纳 IM 触发。
-- schema-v3 定义的 constraint 名字是 test_runs_trigger_type_check（Postgres 默认命名）。
ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS test_runs_trigger_type_check;
ALTER TABLE test_runs
  ADD CONSTRAINT test_runs_trigger_type_check
  CHECK (trigger_type IN ('manual', 'api', 'scheduled', 'im'));

-- ============================================================
-- Seed: deploy-im-demo 样板 pipeline（IM 驱动）
--
-- 绑到 'deploy' capability，首节点 im_input 做参数澄清（project/env/branch），
-- 然后 approval → execute capability('deploy' 由 trigger_params 带参)。
-- 若环境无 product_lines 记录（新库/测试库），SELECT 空集 → INSERT 不发生，
-- 待运维在管理后台创建产线后再手动执行本段（或重跑 migrate，幂等）。
-- ============================================================

DO $$
DECLARE
  v_pl_id INTEGER;
  v_pipeline_id INTEGER;
BEGIN
  -- 选最小 id 的产线作为 demo 承载体；生产上应由运维显式指定
  SELECT id INTO v_pl_id FROM product_lines ORDER BY id LIMIT 1;
  IF v_pl_id IS NULL THEN
    RAISE NOTICE 'schema-v15 seed: no product_lines, skipping deploy-im-demo';
    RETURN;
  END IF;

  -- 若已存在同名 pipeline 则复用 id，避免重复插入
  SELECT id INTO v_pipeline_id
    FROM test_pipelines
    WHERE product_line_id = v_pl_id AND name = 'deploy-im-demo';

  IF v_pipeline_id IS NULL THEN
    INSERT INTO test_pipelines (
      product_line_id, name, description, stages, server_roles, enabled
    )
    VALUES (
      v_pl_id,
      'deploy-im-demo',
      'IM 驱动的部署流水线（参数澄清 → 审批 → 执行 deploy capability）',
      $stages$[
        {
          "name": "参数澄清",
          "stageType": "im_input",
          "targetRoles": [],
          "parallel": false,
          "timeoutSeconds": 600,
          "retryCount": 0,
          "onFailure": "stop",
          "imInputConfig": {
            "prompt": "请告诉我：模块 / 环境 / 分支。可以一次性写 `project=xxx env=dev branch=main`，也可以分条回。回 `取消` 中止。",
            "paramSchema": {
              "type": "object",
              "required": ["project", "env", "branch"],
              "properties": {
                "project": {"type": "string", "title": "模块"},
                "env":     {"type": "string", "title": "环境", "enum": ["dev", "staging", "prod"]},
                "branch":  {"type": "string", "title": "分支"}
              }
            },
            "timeoutSeconds": 600
          }
        },
        {
          "name": "部署审批",
          "stageType": "approval",
          "targetRoles": [],
          "parallel": false,
          "timeoutSeconds": 1800,
          "retryCount": 0,
          "onFailure": "stop",
          "approvalDescription": "部署 {{triggerParams.project}} 到 {{triggerParams.env}} 分支 {{triggerParams.branch}}"
        },
        {
          "name": "执行部署",
          "stageType": "capability",
          "targetRoles": [],
          "parallel": false,
          "timeoutSeconds": 1200,
          "retryCount": 0,
          "onFailure": "stop",
          "capabilityKey": "deploy",
          "capabilityParams": {
            "project": "{{triggerParams.project}}",
            "env":     "{{triggerParams.env}}",
            "branch":  "{{triggerParams.branch}}"
          }
        }
      ]$stages$::jsonb,
      '{}'::jsonb,
      true
    )
    RETURNING id INTO v_pipeline_id;
    RAISE NOTICE 'schema-v15 seed: deploy-im-demo pipeline created id=%', v_pipeline_id;
  ELSE
    RAISE NOTICE 'schema-v15 seed: deploy-im-demo pipeline already exists id=%', v_pipeline_id;
  END IF;

  -- 把 deploy capability 绑到 deploy-im-demo（若未绑定）
  UPDATE capabilities
    SET default_pipeline_id = v_pipeline_id, updated_at = NOW()
    WHERE key = 'deploy' AND default_pipeline_id IS NULL;
END $$;
