// src/e2e/pipeline-a/nodes/llm-generator.ts
import { readFileSync } from 'fs'
import { executeCapabilityDirectForE2e } from '../llm-bridge.js'

const PLAYBOOK_PROMPT_TEMPLATE = `你是一个 e2e 测试工程师。根据 markdown 验收规约生成符合下述 schema 的 playbook YAML。playbook 是给后续 host Claude 看的"可执行场景"——含步骤建议和强制可机器验证的 acceptance。

输出必须是合法 YAML，且严格按下面结构。**下面所有 \`<...>\` / \`<example.../>\` 都是占位符示例，仅展示字段格式，不得当成真实端点 / 路径 / selector 写入你的输出**：

\`\`\`yaml
specPath: docs/test-specs/<filename>.md
specTitle: <规约中文标题，可从 spec markdown 第一行 # 标题派生>
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

# 字段分两类，规则不同

## 业务字段（必须严格按 spec，不得编造）

这些字段值是产品代码层的"事实"，写错就会让验证 fail：
- endpoints / paths：spec 写 \`/health\` 你只能写 \`/health\`，不能改 \`/healthz\`、\`/api/health\` 等
- selector / DOM 属性：spec 没明示 \`data-testid\` 就不要造，用通用语义 selector（\`body\`、\`form\`、\`button[type=submit]\`）
- scenario.id：用 spec 中明示的 ID（spec 写 \`poc.smoke\` 就用 \`poc.smoke\`，不要重命名）
- acceptance.kind / request / sql / db_query.connection：spec 怎么写就怎么写
- scenarios 数量：等于 spec markdown 中明示列出的场景数；spec 列 1 个就生成 1 个，**不要补充 spec 未要求的 scenarios**

## metadata 字段（可由 LLM 合理派生，让 playbook 完整可用）

这些字段不影响验证正确性，是给 host Claude 跑场景时的辅助信息，**应该补全**：
- \`specTitle\`：取 spec markdown 第一行 \`# 标题\` 的完整中文标题，**不要**简化成文件名
- \`scenario.name\`：用 spec 中场景章节标题的完整描述，**不要**截短成 2-4 字
- \`tags\`：从 specTitle / scenario.name 提取关键词（如含"烟测"加 \`smoke\`、含"鉴权"加 \`auth\`、含"PoC"加 \`poc\`）。spec 没明示也应派生 1-3 个 tag
- \`setup.hints\`：根据 scenario 性质给前置说明（如"沙盒已部署完毕，endpoints 在 sandboxHandle 里"、"使用 seed 用户 testuser/testpass"）。1-2 条
- \`steps\`：给 host Claude 的操作建议，可以提示具体工具（如"用 mcp__playwright__browser_navigate 打开 X"、"用 curl GET /health"），让 host Claude 知道走哪条路径
- \`acceptance.timeout_ms\`：给合理默认（DOM 类 5000-10000，API 类 3000-5000）
- \`on_fail_hints\`：根据 acceptance.kind 给 2-3 条失败诊断提示（如 dom_visible fail → "检查 selector 是否在 SPA 异步加载中"；api_response 5xx → "看 docker logs"）

# 硬约束

1. acceptance.kind 必须从上面 7 种选，字段严格匹配
2. db_query.connection 不能写"猜测"的值，未在沙盒 endpoints 中登记的就别加 db_query
3. scenario.id 唯一，只允许字母数字 . _ -

spec 路径: %SPEC_PATH%
spec 标题: %TITLE%

spec 内容:
%CONTENT%

请直接输出 YAML，不要 \`\`\` 围栏，不要额外解释。**业务字段忠于 spec；metadata 字段补全到 playbook 可独立运行的完整度**。`

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
