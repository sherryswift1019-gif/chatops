-- ============================================================
-- schema-v4: Unified Capability System + Pipeline Tools
-- ============================================================

-- 1. Pipeline Tools table (6 atomic infrastructure tools)
CREATE TABLE IF NOT EXISTS pipeline_tools (
  id           SERIAL PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description  TEXT DEFAULT '',
  param_schema JSONB NOT NULL DEFAULT '{}',
  is_system    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pipeline_tools (key, display_name, description) VALUES
  ('ssh_exec',      '远程命令执行', '通过SSH在远程服务器执行命令或脚本'),
  ('file_transfer', '文件传输',     'SCP/SFTP在服务器间上传/下载文件'),
  ('http_probe',    '网络探测',     'HTTP/TCP连通性检查，支持重试'),
  ('http_download', 'HTTP下载',     '从URL下载文件，支持校验和与自动解压'),
  ('docker_op',     '容器镜像操作', 'docker pull、docker compose等容器操作'),
  ('file_read',     '远程文件读取', '读取远程服务器上的日志/文件内容')
ON CONFLICT (key) DO NOTHING;

-- 2. Extend capabilities table
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS param_schema JSONB DEFAULT '{}';
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS playbook     JSONB DEFAULT '[]';
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS is_system    BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW();

-- Widen category CHECK
ALTER TABLE capabilities DROP CONSTRAINT IF EXISTS capabilities_category_check;
DO $$ BEGIN
  ALTER TABLE capabilities ADD CONSTRAINT capabilities_category_check
    CHECK (category IN ('query','action','admin','env_prep','verify','testing','result'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Seed 7 new capabilities
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, param_schema, is_system) VALUES
(
  'env_init', '环境初始化', '在新机器上从零搭建运行环境', 'env_prep',
  '["ssh_exec","file_transfer"]', false,
  '{"type":"object","properties":{"commands":{"type":"string","format":"textarea","title":"执行命令","description":"shell命令，每行一条。支持变量"},"script":{"type":"string","title":"脚本","description":"脚本路径（可带参数），如 /opt/scripts/init.sh -f"}}}',
  true
),
(
  'env_cleanup', '环境清理', '清理旧版本、停服务，为重新部署做准备', 'env_prep',
  '["ssh_exec"]', false,
  '{"type":"object","properties":{"commands":{"type":"string","format":"textarea","title":"执行命令","description":"shell命令，每行一条。支持变量"},"script":{"type":"string","title":"脚本","description":"脚本路径（可带参数）"}}}',
  true
),
(
  'health_check', '健康检查', '验证服务部署后是否正常运行', 'verify',
  '["http_probe","ssh_exec"]', false,
  '{"type":"object","required":["checkType","target"],"properties":{"checkType":{"type":"string","title":"检查方式","enum":["http","tcp","command"]},"target":{"type":"string","title":"检查目标","description":"支持变量，如 http://{{servers.app[0].host}}:8080/health"},"intervalSeconds":{"type":"integer","title":"检查间隔(秒)","default":5},"maxRetries":{"type":"integer","title":"最大重试次数","default":10},"expectedStatus":{"type":"integer","title":"期望状态码","default":200}}}',
  true
),
(
  'auto_test', '自动化测试', '拉取测试代码、执行测试、收集结果', 'testing',
  '["ssh_exec","file_transfer"]', false,
  '{"type":"object","required":["gitRepo","branch","workDir","command"],"properties":{"gitRepo":{"type":"string","title":"Git 仓库","description":"支持变量"},"branch":{"type":"string","title":"分支","description":"支持变量"},"workDir":{"type":"string","title":"工作目录"},"command":{"type":"string","format":"textarea","title":"测试命令","description":"支持变量"},"collectArtifacts":{"type":"array","items":{"type":"string"},"title":"收集制品路径"}}}',
  true
),
(
  'log_collect', '日志收集', '从目标服务器收集日志文件用于分析', 'result',
  '["file_read","file_transfer"]', false,
  '{"type":"object","required":["logPaths"],"properties":{"logPaths":{"type":"array","items":{"type":"string"},"title":"日志文件路径"},"grepKeywords":{"type":"array","items":{"type":"string"},"title":"过滤关键词"},"maxLines":{"type":"integer","title":"最大行数","default":1000}}}',
  true
),
(
  'report_gen', '报告生成', '流水线执行完毕后生成汇总报告', 'result',
  '[]', false,
  '{"type":"object","properties":{"format":{"type":"string","title":"报告格式","enum":["html"],"default":"html"},"includeStageLogs":{"type":"boolean","title":"包含阶段日志","default":true}}}',
  true
),
(
  'custom_script', '自定义脚本', '执行任意自定义命令或脚本', 'action',
  '["ssh_exec"]', false,
  '{"type":"object","properties":{"commands":{"type":"string","format":"textarea","title":"执行命令","description":"支持变量"},"script":{"type":"string","title":"脚本","description":"脚本路径（可带参数）"}}}',
  true
)
ON CONFLICT (key) DO NOTHING;

-- 4. Update existing deploy/rollback/restart with param_schema
UPDATE capabilities SET
  tool_names = '["execute_deploy","request_approval","ssh_exec","http_download","docker_op"]',
  param_schema = '{"type":"object","required":["deployType"],"properties":{"deployType":{"type":"string","title":"部署方式","enum":["package","container"]},"packageUrl":{"type":"string","title":"部署包地址","description":"支持变量，如 https://releases.example.com/{{branch}}/app.tar.gz","x-depends-on":{"deployType":"package"}},"downloadDir":{"type":"string","title":"下载目录","x-depends-on":{"deployType":"package"}},"checksum":{"type":"string","title":"校验和","description":"格式 algo:hash","x-depends-on":{"deployType":"package"}},"extract":{"type":"boolean","title":"自动解压","default":true,"x-depends-on":{"deployType":"package"}},"silentConfig":{"type":"string","format":"textarea","title":"Silent安装配置内容","description":"支持变量，如 DB_HOST={{servers.db[0].host}}","x-depends-on":{"deployType":"package"}},"installScript":{"type":"string","title":"安装脚本","description":"脚本路径（可带参数）","x-depends-on":{"deployType":"package"}},"image":{"type":"string","title":"镜像地址","description":"支持变量","x-depends-on":{"deployType":"container"}},"action":{"type":"string","title":"操作","enum":["pull","compose_up"],"x-depends-on":{"deployType":"container"}},"composeFile":{"type":"string","title":"Compose文件路径","x-depends-on":{"deployType":"container"}},"commands":{"type":"string","format":"textarea","title":"执行命令","description":"安装/启动命令"}}}',
  is_system = true, updated_at = NOW()
WHERE key = 'deploy';

UPDATE capabilities SET
  tool_names = '["execute_rollback","request_approval","ssh_exec"]',
  param_schema = '{"type":"object","properties":{"commands":{"type":"string","format":"textarea","title":"回滚命令"},"script":{"type":"string","title":"回滚脚本","description":"脚本路径（可带参数）"}}}',
  is_system = true, updated_at = NOW()
WHERE key = 'rollback';

UPDATE capabilities SET
  tool_names = '["execute_restart","request_approval","ssh_exec"]',
  param_schema = '{"type":"object","properties":{"commands":{"type":"string","format":"textarea","title":"重启命令"},"script":{"type":"string","title":"重启脚本","description":"脚本路径（可带参数）"}}}',
  is_system = true, updated_at = NOW()
WHERE key = 'restart';

-- Set is_system on existing query/admin capabilities
UPDATE capabilities SET is_system = true, updated_at = NOW()
WHERE key IN ('view_deployments','view_images','view_logs','view_commits','manage_role')
  AND is_system IS DISTINCT FROM true;

-- 5. Add trigger_params to test_pipelines
ALTER TABLE test_pipelines ADD COLUMN IF NOT EXISTS trigger_params JSONB DEFAULT '{}';

-- 6. Add x-ai-assist to commands fields for AI command generation
UPDATE capabilities SET param_schema = jsonb_set(param_schema, '{properties,commands,x-ai-assist}', 'true')
WHERE param_schema->'properties'->'commands' IS NOT NULL
  AND key IN ('env_init','env_cleanup','deploy','rollback','restart','custom_script');

-- 7. Add dingtalk_group_id to product_lines for group-to-productline mapping
ALTER TABLE product_lines ADD COLUMN IF NOT EXISTS dingtalk_group_id TEXT DEFAULT '';

-- 8. Auto-register existing pipelines as capabilities
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, param_schema, is_system)
SELECT 'pipeline_' || id, '执行流水线: ' || name, '触发测试流水线「' || name || '」', 'testing', '["autotest"]', false, '{}', false
FROM test_pipelines
ON CONFLICT (key) DO NOTHING;

INSERT INTO product_line_capabilities (product_line_id, capability_key, env_name, enabled, allowed_roles)
SELECT product_line_id, 'pipeline_' || id, '*', true, '["developer","tester","ops","admin"]'
FROM test_pipelines
ON CONFLICT (product_line_id, capability_key, env_name) DO NOTHING;
