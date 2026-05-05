// src/e2e/pipeline-a/nodes/llm-generator.ts
import { readFileSync } from 'fs'
import { executeCapabilityDirectForE2e } from '../llm-bridge.js'

const PLAYBOOK_PROMPT_TEMPLATE = `你是一个 e2e 测试工程师。根据 markdown 验收规约生成符合下述 schema 的 playbook YAML。playbook 是给后续 host Claude 看的"可执行场景"——含步骤建议和强制可机器验证的 acceptance。

输出必须是合法 YAML，且严格按下面结构。**下面所有 \`<...>\` / \`<example.../>\` 都是占位符示例，仅展示字段格式，不得当成真实端点 / 路径 / selector 写入你的输出**：

\`\`\`yaml
specPath: docs/test-specs/<filename>.md
specTitle: <规约标题，可选>
scenarios:
  - id: <字母数字 . _ -，整 playbook 里唯一>
    name: <场景名>
    tags: [<可选标签>]
    setup:                          # 可选
      hints:
        - "<可选：seed 数据 / 前置条件提示>"
    steps:                          # 给 Claude 的操作建议（自然语言）
      - "<操作 1>"
      - "<操作 2>"
    acceptance:                     # 至少 1 条，每条按 kind 选择字段
      - kind: url_match
        value: <字面 URL 路径，必须出自 spec>
        timeout_ms: 5000
      - kind: url_regex
        pattern: <正则，必须出自 spec>
      - kind: dom_visible
        selector: <CSS selector，必须出自 spec 或可由 spec 明示推断；不要凭通用 web 习惯造 data-testid>
      - kind: dom_text_contains
        selector: <selector>
        value: <文本，必须出自 spec>
      - kind: api_response
        request: <"METHOD /path" 字面，必须出自 spec>
        expect_status: <整数>
        expect_body_contains: <文本，必须出自 spec>
      - kind: log_contains
        source: <容器名 / 日志通道，必须出自 spec>
        value: <文本，必须出自 spec>
      - kind: db_query
        connection: <app_db_dsn 等已登记的 endpoint 名>
        sql: <SQL，必须出自 spec>
        expect:
          rows: <数字>
    on_fail_hints:                   # 可选
      - "<可选：常见失败诊断提示>"
\`\`\`

# 硬约束（违反任一条会让生成的 playbook 在 baseline check 阶段失败）

1. **不得编造 endpoints / paths / selectors / DOM 属性**。如果 spec 写"GET /health"，
   你只能写 \`/health\`，不能改成 \`/healthz\`、\`/api/health\`、\`/v1/health\` 等"看起来更规范"
   的版本。如果 spec 没明示 \`data-testid\` 或 selector 细节，用通用语义 selector
   （如 \`body\`、\`form\`、\`button[type=submit]\`），**不要凭空造 \`data-testid=user-menu\`
   这种属性**——产品代码里大概率没有。
2. **scenarios 数量必须等于 spec markdown 中明示列出的场景数**。spec 列了 1 个就生成
   1 个；列了 3 个就生成 3 个。**不要自动补充** "smoke.health_check"、"smoke.login_flow"、
   "authenticated_api" 等 spec 未要求的 scenarios。
3. **scenario.id 用 spec 中明示的 ID**（如 spec 写"poc.smoke"就用 \`poc.smoke\`，不要
   改成 \`smoke.health_check\` / \`smoke.poc\` 等"重命名"）。
4. **acceptance 数量与字段必须忠于 spec 的"验收"小节**。spec 说"2 条 acceptance：
   dom_visible body + api_response /health 200"，你就写 2 条且字段值与 spec 一致。
5. acceptance.kind 必须从上面 7 种选，字段严格匹配；db_query.connection 不能写
   "猜测"的值，未在沙盒 endpoints 中登记的就别加 db_query。
6. scenario.id 唯一，只允许字母数字 . _ -

spec 路径: %SPEC_PATH%
spec 标题: %TITLE%

spec 内容:
%CONTENT%

请直接输出 YAML，不要 \`\`\` 围栏，不要额外解释。**严格按 spec 内容生成；spec 没明示
的细节宁可少写也不要靠通用 web 经验补充。**`

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
