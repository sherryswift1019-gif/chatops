// src/e2e/playbook-draft/llm-generator.ts
import { ClaudeRunner } from '../../agent/claude-runner.js'
import type { TaskContext } from '../../agent/tools/types.js'

let _runner: ClaudeRunner | null = null

function getRunner(): ClaudeRunner {
  if (!_runner) _runner = new ClaudeRunner()
  return _runner
}

const DRAFT_CONTEXT: TaskContext = {
  taskId: 'e2e-playbook-draft',
  groupId: 'e2e-playbook-draft',
  platform: 'internal',
  initiatorId: 'playbook-draft',
  initiatorRole: null,
}

const PLAYBOOK_DRAFT_PROMPT_TEMPLATE = `你是一个 Playwright 测试工程师。根据用户对调试场景的自然语言描述，生成符合下面 schema 的 playbook YAML。

用户场景描述：
%SCENARIO_INPUT%

目标项目 ID：%PROJECT_ID%
目标项目默认分支：%DEFAULT_BRANCH%

输出必须是合法 YAML，严格按照以下结构（下面所有 \`<...>\` 是占位符示例，不得原样写入输出）：

\`\`\`yaml
specPath: draft://%PROJECT_ID%/%TIMESTAMP%
specTitle: <从场景描述提炼的标题>
scenarios:
  - id: <字母数字 . _ -，整 playbook 里唯一>
    name: <场景名>
    tags: [<可选标签>]
    setup:                          # 可选
      hints:
        - "<可选：前置条件提示>"
    steps:                          # 给 Claude 的操作建议（自然语言）
      - "<操作 1>"
      - "<操作 2>"
    acceptance:                     # 至少 1 条，每条按 kind 选择字段
      - kind: url_match
        value: <字面 URL 路径，必须出自用户描述>
        timeout_ms: 5000
      - kind: url_regex
        pattern: <正则，必须出自用户描述>
      - kind: dom_visible
        selector: <CSS selector；无明示 data-testid 时用通用语义如 form / button[type=submit]>
      - kind: dom_text_contains
        selector: <selector>
        value: <文本，必须出自用户描述>
      - kind: api_response
        request: <"METHOD /path" 字面，必须出自用户描述>
        expect_status: <整数>
        expect_body_contains: <文本，必须出自用户描述>
      - kind: log_contains
        source: <容器名 / 日志通道，必须出自用户描述>
        value: <文本，必须出自用户描述>
      - kind: db_query
        connection: <用户描述中明确的 endpoint 名，不确定时不要加此条>
        sql: <SQL，必须出自用户描述>
        expect:
          rows: <数字>
    on_fail_hints:                   # 可选
      - "<常见失败诊断提示>"
\`\`\`

# 字段分两类，规则不同

## 业务字段（必须忠于用户描述，不得编造）

这些字段是产品代码层的"事实"，写错会导致验证 fail：
- endpoints / paths：用户描述写 \`/api/login\` 就只能写 \`/api/login\`，不能改为 \`/login\` 等
- selector：用户描述未明示 \`data-testid\` 就不要造，用通用语义 selector（\`body\`、\`form\`、\`button[type=submit]\`）
- scenario.id：用字母数字下划线连字符，唯一即可；若用户明示了 ID 则忠于用户
- acceptance.kind / request / sql / db_query.connection：用户怎么描述就怎么写
- **scenarios 数量按用户描述判断**：用户描述提到 N 个场景就生成 N 个，不补编、不拆细

## metadata 字段（可由 LLM 合理派生，让 playbook 完整可用）

这些字段不影响验证正确性，是给 host Claude 跑场景时的辅助信息，**应该补全**：
- \`specTitle\`：从用户描述中提取核心意图作为标题，完整描述功能点
- \`scenario.name\`：用描述中该场景的完整叙述，不要截短
- \`tags\`：从标题/名称提取关键词（如含"登录"加 \`auth\`、含"烟测"加 \`smoke\`、含"支付"加 \`payment\`），1-3 个
- \`setup.hints\`：根据场景性质给前置说明（如"需要已注册的测试账号"、"沙盒环境已启动"）1-2 条
- \`steps\`：给 host Claude 的操作建议，可提示具体工具（如"用 mcp__playwright__browser_navigate 打开登录页"），让执行者知道路径
- \`acceptance.timeout_ms\`：合理默认（DOM 类 5000-10000，API 类 3000-5000）
- \`on_fail_hints\`：根据 acceptance.kind 给 2-3 条失败诊断提示（dom_visible fail → "检查 selector 是否在 SPA 异步加载中"；api_response 5xx → "看 docker logs"）

# 硬约束

1. acceptance.kind 必须从上面 7 种选（url_match / url_regex / dom_visible / dom_text_contains / api_response / log_contains / db_query），字段严格匹配对应 kind
2. db_query.connection 只在用户描述明确提到数据库连接名时才使用，不确定时不要加 db_query 条目
3. scenario.id 唯一，只允许字母数字 . _ -
4. specPath 必须是 draft://%PROJECT_ID%/%TIMESTAMP%（按上面格式，不要改）

请直接输出 YAML，**不要 \`\`\` 围栏，不要任何解释文本**。业务字段忠于用户描述；metadata 字段补全到 playbook 可独立运行的完整度。`

export async function generatePlaybookFromInput(args: {
  scenarioInput: string
  projectId: string
  projectDefaultBranch: string
  onChunk?: (chunk: string) => void
}): Promise<string> {
  const { scenarioInput, projectId, projectDefaultBranch, onChunk } = args
  const timestamp = Date.now().toString()

  const prompt = PLAYBOOK_DRAFT_PROMPT_TEMPLATE
    .replace(/%PROJECT_ID%/g, projectId)
    .replace(/%DEFAULT_BRANCH%/g, projectDefaultBranch)
    .replace(/%TIMESTAMP%/g, timestamp)
    .replace('%SCENARIO_INPUT%', scenarioInput)

  // executeCapabilityDirect 不支持 streaming chunk callback——整个完成后返回完整文本。
  // onChunk 退化为"完成后一次性发送完整内容"，admin 路由 SSE 层再广播给前端。
  const result = await getRunner().executeCapabilityDirect({
    prompt,
    systemPrompt: 'You are a Playwright test engineer. Output only YAML.',
    context: DRAFT_CONTEXT,
    tools: [],
    cwd: process.cwd(),
    sessionKey: `playbook-draft-${projectId}-${timestamp}`,
    freshSession: true,
    maxTurns: 20,
    timeoutMs: 600_000,
  })

  if (onChunk) {
    onChunk(result)
  }

  return result
}
