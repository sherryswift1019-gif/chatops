/**
 * 集成测试：完整 Bug 分析链路（非钉钉触发）
 *
 * 模拟：用户说"分析 TASK_PWD_4001" → 全自动完成：
 * 1. 意图识别 → analyze_bug
 * 2. acquire worktree（clone PAM 仓库）
 * 3. Claude 通过 MCP 工具读代码
 * 4. Claude 输出分析结果
 * 5. 解析结构化报告（如果有）
 * 6. 验证结果非空
 * 7. 清理 worktree
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import { ClaudeRunner } from '../../agent/claude-runner.js'
import { buildClaudeAuthEnv } from '../../agent/claude-auth.js'
import { listCapabilities } from '../../db/repositories/capabilities.js'
import { parseAnalysisOutput, buildMarkdownReport } from '../../agent/analysis/analyzer.js'
import { acquire, remove } from '../../agent/worktree/manager.js'
import { getByProductLineId } from '../../db/repositories/product-knowledge-repos.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Step 1/2/3/4 都依赖真实 Claude CLI + git clone + GitLab 网络。
// 原先只在 Step 3/4 加 skipIf，导致 Step 1/2 在 CI 也跑崩。
// 整组 describe.skipIf 统一：CI 默认 skip，本地 RUN_CLAUDE_TESTS=1 开启。
describe.skipIf(!process.env.RUN_CLAUDE_TESTS)('Integration: 完整 Bug 分析链路（非钉钉）', () => {
  let runner: ClaudeRunner
  let authEnv: Record<string, string>
  let productLineId: number

  beforeAll(async () => {
    await resetTestDb()
    runner = new ClaudeRunner()
    authEnv = buildClaudeAuthEnv(process.env.ANTHROPIC_API_KEY)

    // seed
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO product_lines (name, display_name, description) VALUES ('pam', 'PAM', 'test') ON CONFLICT (name) DO NOTHING RETURNING id`
    )
    productLineId = rows[0]?.id ?? (await pool.query(`SELECT id FROM product_lines WHERE name = 'pam'`)).rows[0].id

    await pool.query(
      `INSERT INTO product_knowledge_repos (product_line_id, code_repo_url, code_default_branch, knowledge_repo_url, ai_summary_path)
       VALUES ($1, 'http://code.paraview.cn/PAM/java-code/pas-6.0.git', 'test', '', 'docs/ai-summary')
       ON CONFLICT (product_line_id) DO NOTHING`, [productLineId]
    )

    // capability systemPrompt
    await pool.query(`UPDATE capabilities SET system_prompt = '你是 Bug 分析专家。使用 MCP 工具读代码分析问题。' WHERE key = 'analyze_bug' AND system_prompt IS NULL`)
  })

  // ─── Step 1: 意图识别 ──────────────────────────────────

  it('Step 1: 意图识别 → analyze_bug', async () => {
    const caps = await listCapabilities()
    const capList = caps.map(c => `- ${c.key}: ${c.displayName} (${c.description})`).join('\n')

    const result = await (runner as any).porygon.run({
      prompt: `识别意图。\n可用能力:\n${capList}\n\n用户: 帮我分析 pas-secret-task 模块的 TASK_PWD_4001 错误码问题，版本 v6.6.1.2\n\n返回JSON：{"capability":"key","summary":"..."}`,
      appendSystemPrompt: '只返回 JSON。',
      envVars: authEnv,
    })

    const text = String(result)
    console.log('[Step 1] Intent:', text)
    expect(text).toContain('analyze_bug')
  }, 30_000)

  // ─── Step 2: Worktree 创建 ─────────────────────────────

  it('Step 2: Worktree clone + 创建', async () => {
    const repo = await getByProductLineId(productLineId)
    expect(repo).not.toBeNull()

    const worktree = await acquire({
      userId: 'test-integration',
      product: `pl-${productLineId}`,
      version: repo!.codeDefaultBranch,
      sessionId: `full-flow-${Date.now()}`,
      repoUrl: repo!.codeRepoUrl,
    })

    expect(worktree.path).toContain('/tmp/analysis/')
    console.log('[Step 2] Worktree:', worktree.path)

    // 存起来给后续测试用
    ;(globalThis as any).__testWorktree = worktree
  }, 120_000)

  // ─── Step 3: Claude 通过 MCP 读代码并分析 ──────────────

  it.skipIf(!process.env.RUN_CLAUDE_TESTS)('Step 3: Claude 通过 MCP 读代码 + 输出分析', async () => {
    const worktree = (globalThis as any).__testWorktree
    expect(worktree).toBeTruthy()

    const mcpServerPath = join(__dirname, '..', '..', 'agent', 'mcp-server.ts')
    let textBuffer = ''

    const porygon = (runner as any).porygon

    for await (const msg of porygon.query({
      prompt: `分析 pas-secret-task 模块的 TASK_PWD_4001 错误码问题。
1. 用 read_code 读取相关代码文件
2. 找到 TASK_PWD_4001 的定义和使用
3. 给出根因分析和修复建议`,
      appendSystemPrompt: '你是 Bug 分析专家。使用 read_code 工具读代码。输出中文分析报告。',
      mcpServers: {
        'chatops-tools': {
          command: 'node',
          args: ['--import', 'tsx/esm', mcpServerPath],
          env: {
            ...(process.env as Record<string, string>),
            CHATOPS_TASK_CONTEXT: JSON.stringify({
              taskId: 'full-flow-test',
              groupId: 'test',
              platform: 'test',
              initiatorId: 'test',
              initiatorRole: 'admin',
              cwd: worktree.path,
            }),
            DATABASE_URL: process.env.DATABASE_URL ?? '',
            ...authEnv,
          },
        },
      },
      disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill', 'AskUserQuestion'],
      envVars: authEnv,
    })) {
      if (msg.type === 'assistant' && 'text' in msg && msg.text) textBuffer += msg.text
      if (msg.type === 'result' && 'text' in msg && msg.text) textBuffer += msg.text
    }

    console.log('[Step 3] Claude output length:', textBuffer.length)
    console.log('[Step 3] Claude output (first 500):', textBuffer.substring(0, 500))

    expect(textBuffer).not.toContain('hit your limit')
    expect(textBuffer.length).toBeGreaterThan(50)

    // 存给 step 4
    ;(globalThis as any).__testOutput = textBuffer
  }, 300_000)

  // ─── Step 4: 解析结构化报告 ────────────────────────────

  it.skipIf(!process.env.RUN_CLAUDE_TESTS)('Step 4: 验证分析结果', async () => {
    const output = (globalThis as any).__testOutput as string
    expect(output).toBeTruthy()
    expect(output.length).toBeGreaterThan(50)

    // 尝试解析结构化 JSON（Claude 不一定严格按格式）
    const parsed = parseAnalysisOutput(output)
    if (parsed) {
      console.log('[Step 4] Parsed report:', JSON.stringify({
        classification: parsed.classification,
        level: parsed.level,
        confidence: parsed.confidence,
        modules: parsed.affected_modules,
      }))
      const md = buildMarkdownReport(parsed)
      expect(md).toContain('## AI 分析报告')
    } else {
      console.log('[Step 4] Claude 未返回严格 JSON 格式，但有分析内容（OK for MVP）')
    }

    // 无论是否 JSON，分析内容应该有意义
    expect(output.length).toBeGreaterThan(100)
  })

  // ─── Step 5: 清理 ─────────────────────────────────────

  afterAll(async () => {
    const worktree = (globalThis as any).__testWorktree
    if (worktree) {
      await remove(worktree).catch(() => {})
      console.log('[Cleanup] Worktree removed')
    }
  })
})
