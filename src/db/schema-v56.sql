-- v56: PAM Proxy 部署流水线迁移——移除 im_input 首节点，填充 param_schema/im_prompt
-- 幂等：无 product_lines 或无该流水线时自动跳过。
DO $$
DECLARE
  v_pl_id   INTEGER;
  v_pipe_id INTEGER;
  v_graph   JSONB;
BEGIN
  SELECT id INTO v_pl_id FROM product_lines ORDER BY id LIMIT 1;
  IF v_pl_id IS NULL THEN
    RAISE NOTICE 'schema-v56: no product_lines found, skipping';
    RETURN;
  END IF;

  SELECT id INTO v_pipe_id
    FROM test_pipelines
    WHERE product_line_id = v_pl_id AND name = 'PAM Proxy部署';
  IF v_pipe_id IS NULL THEN
    RAISE NOTICE 'schema-v56: PAM Proxy部署 pipeline not found, skipping';
    RETURN;
  END IF;

  -- 新 graph：去掉 im_input 节点（01HPAM00000000000000000001）和 edge e01，
  -- 直接从「清理旧部署」节点（01HPAM00000000000000000002）开始。
  v_graph := '{
    "nodes": [
      {
        "id": "01HPAM00000000000000000002",
        "name": "清理旧部署",
        "stageType": "script",
        "targetRoles": ["proxy"],
        "parallel": false,
        "timeoutSeconds": 120,
        "retryCount": 0,
        "onFailure": "stop",
        "position": {"x": 100, "y": 100},
        "script": "# TODO: 清理脚本待提供\necho 清理完成"
      },
      {
        "id": "01HPAM00000000000000000003",
        "name": "分析选择安装包",
        "stageType": "llm_agent",
        "agentMode": "custom",
        "allowedTools": ["WebFetch"],
        "outputFormat": "json",
        "targetRoles": [],
        "parallel": false,
        "timeoutSeconds": 60,
        "retryCount": 0,
        "onFailure": "stop",
        "position": {"x": 100, "y": 250},
        "customPrompt": "请访问以下 URL 获取安装包文件列表：\nhttp://10.10.2.234:8000/pam/deploy/Proxy-Deploy/{{triggerParams.branch}}?json=true\n\n从返回的 files 数组中，找出 mtime 最大的、文件名不以 .sha256 结尾的文件。\n\n只返回以下 JSON，不要任何其他内容：\n{\"filename\": \"<文件名>\", \"downloadUrl\": \"http://10.10.2.234:8000/pam/deploy/Proxy-Deploy/{{triggerParams.branch}}/<文件名>\"}"
      },
      {
        "id": "01HPAM00000000000000000004",
        "name": "下载并解压",
        "stageType": "script",
        "targetRoles": ["proxy"],
        "parallel": false,
        "timeoutSeconds": 300,
        "retryCount": 0,
        "onFailure": "stop",
        "position": {"x": 100, "y": 400},
        "script": "curl -fSL \"{{steps.01HPAM00000000000000000003.output.downloadUrl}}\" -o /tmp/pam-proxy-deploy.tar.gz\nmkdir -p /tmp/pam-proxy-deploy\ntar -xzf /tmp/pam-proxy-deploy.tar.gz -C /tmp/pam-proxy-deploy --strip-components=1"
      },
      {
        "id": "01HPAM00000000000000000005",
        "name": "执行安装",
        "stageType": "script",
        "targetRoles": ["proxy"],
        "parallel": false,
        "timeoutSeconds": 300,
        "retryCount": 0,
        "onFailure": "continue",
        "position": {"x": 100, "y": 550},
        "script": "cd /tmp/pam-proxy-deploy\nPAM_ADDRESS={{triggerParams.pam_address}} ./install.sh"
      },
      {
        "id": "01HPAM00000000000000000006",
        "name": "诊断修复",
        "stageType": "llm_agent",
        "agentMode": "capability",
        "capabilityKey": "diagnose_and_repair",
        "targetRoles": [],
        "parallel": false,
        "timeoutSeconds": 1200,
        "retryCount": 0,
        "onFailure": "continue",
        "position": {"x": 350, "y": 550},
        "capabilityParams": {
          "failedCommand": "cd /tmp/pam-proxy-deploy && PAM_ADDRESS={{triggerParams.pam_address}} ./install.sh",
          "stdout": "{{steps.01HPAM00000000000000000005.output.stdout}}",
          "stderr": "{{steps.01HPAM00000000000000000005.output.stderr}}",
          "serverHost": "{{server.host}}",
          "maxRetries": 4
        }
      },
      {
        "id": "01HPAM00000000000000000007",
        "name": "通知成功",
        "stageType": "dm",
        "targetRoles": [],
        "parallel": false,
        "timeoutSeconds": 30,
        "retryCount": 0,
        "onFailure": "continue",
        "position": {"x": 100, "y": 700},
        "params": {
          "platform": "{{triggerParams.imPlatform}}",
          "userId": "{{triggerParams.imUserId}}",
          "text": "✅ PAM Proxy 部署成功 | 分支: {{triggerParams.branch}} | 环境: {{triggerParams.env}} | 地址: {{triggerParams.pam_address}}"
        }
      },
      {
        "id": "01HPAM00000000000000000008",
        "name": "通知失败",
        "stageType": "dm",
        "targetRoles": [],
        "parallel": false,
        "timeoutSeconds": 30,
        "retryCount": 0,
        "onFailure": "continue",
        "position": {"x": 350, "y": 700},
        "params": {
          "platform": "{{triggerParams.imPlatform}}",
          "userId": "{{triggerParams.imUserId}}",
          "text": "❌ PAM Proxy 部署失败，已重试 4 次，请人工介入 | 分支: {{triggerParams.branch}} | 环境: {{triggerParams.env}}"
        }
      }
    ],
    "edges": [
      {"id": "e02", "source": "01HPAM00000000000000000002", "target": "01HPAM00000000000000000003"},
      {"id": "e03", "source": "01HPAM00000000000000000003", "target": "01HPAM00000000000000000004"},
      {"id": "e04", "source": "01HPAM00000000000000000004", "target": "01HPAM00000000000000000005"},
      {"id": "e05", "source": "01HPAM00000000000000000005", "target": "01HPAM00000000000000000007", "condition": {"kind": "onSuccess"}},
      {"id": "e06", "source": "01HPAM00000000000000000005", "target": "01HPAM00000000000000000006", "condition": {"kind": "onFailure"}},
      {"id": "e07", "source": "01HPAM00000000000000000006", "target": "01HPAM00000000000000000007", "condition": {"kind": "onSuccess"}},
      {"id": "e08", "source": "01HPAM00000000000000000006", "target": "01HPAM00000000000000000008", "condition": {"kind": "onFailure"}}
    ]
  }'::jsonb;

  UPDATE test_pipelines
  SET
    graph        = v_graph,
    param_schema = '{
      "type": "object",
      "required": ["branch", "env", "pam_address"],
      "properties": {
        "branch":      {"type": "string", "title": "分支"},
        "env":         {"type": "string", "title": "环境", "enum": ["staging", "prod"]},
        "pam_address": {"type": "string", "title": "PAM_ADDRESS"}
      }
    }'::jsonb,
    im_prompt    = E'请提供 PAM Proxy 部署信息：\n- branch（分支名，如 main）\n- env（环境，如 staging / prod）\n- pam_address（PAM 服务地址，如 192.168.1.100:8080）',
    updated_at   = NOW()
  WHERE id = v_pipe_id;

  RAISE NOTICE 'schema-v56: PAM Proxy部署 pipeline migrated (im_input removed, param_schema set) id=%', v_pipe_id;
END $$;
