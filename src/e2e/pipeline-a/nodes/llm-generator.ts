// src/e2e/pipeline-a/nodes/llm-generator.ts
import { readFileSync } from 'fs'
import { executeCapabilityDirectForE2e } from '../llm-bridge.js'

const PLAYBOOK_PROMPT_TEMPLATE = `你是一个 e2e 测试工程师。根据 markdown 验收规约生成符合下述 schema 的 playbook YAML。playbook 是给后续 host Claude 看的"可执行场景"——含步骤建议和强制可机器验证的 acceptance。

输出必须是合法 YAML，且严格按下面结构：

\`\`\`yaml
specPath: docs/test-specs/<filename>.md
specTitle: <规约标题，可选>
scenarios:
  - id: <字母数字 . _ -，整 playbook 里唯一>
    name: <场景名>
    tags: [smoke, auth]            # 可选标签数组
    setup:                          # 可选
      hints:
        - "可以用 seed 数据 testuser/testpass"
    steps:                          # 给 Claude 的操作建议（自然语言）
      - "打开 /login"
      - "填写账号密码并提交"
    acceptance:                     # 至少 1 条，每条按 kind 选择字段
      - kind: url_match
        value: /dashboard
        timeout_ms: 5000
      - kind: url_regex
        pattern: ^/users/\\d+$
      - kind: dom_visible
        selector: "[data-testid=user-menu]"
      - kind: dom_text_contains
        selector: h1
        value: 欢迎
      - kind: api_response
        request: GET /api/me
        expect_status: 200
        expect_body_contains: testuser
      - kind: log_contains
        source: app
        value: login success
      - kind: db_query
        connection: app_db_dsn       # 必须是 sandboxHandle.endpoints 已登记的名字
        sql: SELECT count(*) FROM users WHERE email='x@y.com'
        expect:
          rows: 1
    on_fail_hints:                   # 可选
      - "若 401，先 GET /healthz 看 seed 是否就绪"
\`\`\`

硬约束：
- scenarios 至少 1 个，每个至少 1 条 acceptance
- acceptance 必须从上面 7 种 kind 选一种，字段严格匹配
- db_query.connection 不能写"猜测"的值，未在沙盒 endpoints 中登记的就别加 db_query
- scenario.id 唯一，只允许字母数字 . _ -

spec 路径: %SPEC_PATH%
spec 标题: %TITLE%

spec 内容:
%CONTENT%

请直接输出 YAML，不要 \`\`\` 围栏，不要额外解释。`

export async function runE2eLlmGenerator(specPath: string, title: string): Promise<string> {
  let specContent = ''
  try { specContent = readFileSync(specPath, 'utf8') } catch { /* spec in git, not local */ }

  const prompt = PLAYBOOK_PROMPT_TEMPLATE
    .replace('%SPEC_PATH%', specPath)
    .replace('%TITLE%', title)
    .replace('%CONTENT%', specContent || '(文件需要从 GitLab 读取，请根据路径推断场景)')

  const result = await executeCapabilityDirectForE2e(prompt, 'generate_playbook')
  return result
}
