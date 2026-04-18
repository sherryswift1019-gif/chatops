/**
 * 集成测试：模拟钉钉消息进入后的完整分析链路
 * 跳过钉钉，直接调 ClaudeRunner.run() 验证：
 * 1. productLineId 是否正确传递
 * 2. worktree 是否创建
 * 3. MCP 工具 read_code 是否能读到代码
 * 4. Claude 是否返回分析结果
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import { acquire, release, remove } from '../../agent/worktree/manager.js'
import { getByProductLineId } from '../../db/repositories/product-knowledge-repos.js'
import { buildClaudeAuthEnv } from '../../agent/claude-auth.js'
import { createPorygon } from '@snack-kit/porygon'
import { existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('Integration: Worktree + MCP 读代码链路', () => {
  let productLineId: number

  beforeAll(async () => {
    await resetTestDb()

    // seed 数据
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO product_lines (name, display_name, description)
       VALUES ('pam', 'PAM', 'test') ON CONFLICT (name) DO NOTHING RETURNING id`
    )
    productLineId = rows[0]?.id
    if (!productLineId) {
      const existing = await pool.query(`SELECT id FROM product_lines WHERE name = 'pam'`)
      productLineId = existing.rows[0].id
    }

    await pool.query(
      `INSERT INTO product_knowledge_repos (product_line_id, code_repo_url, code_default_branch, knowledge_repo_url, ai_summary_path)
       VALUES ($1, 'http://code.paraview.cn/PAM/java-code/pas-6.0.git', 'test', '', 'docs/ai-summary')
       ON CONFLICT (product_line_id) DO NOTHING`,
      [productLineId]
    )
  })

  it('product_knowledge_repos 配置存在', async () => {
    const repo = await getByProductLineId(productLineId)
    expect(repo).not.toBeNull()
    expect(repo!.codeRepoUrl).toContain('pas-6.0')
    expect(repo!.codeDefaultBranch).toBe('test')
  })

  it('WorktreeManager clone + worktree + read_code 完整链路', async () => {
    const worktree = await acquire({
      userId: 'test-user',
      product: `pl-${productLineId}`,
      version: 'test',
      sessionId: `test-session-${Date.now()}`,
      repoUrl: 'http://code.paraview.cn/PAM/java-code/pas-6.0.git',
    })

    try {
      console.log('[Test] Worktree path:', worktree.path)
      expect(worktree.path).toContain('/tmp/analysis/')
      expect(existsSync(worktree.path)).toBe(true)

      // 验证代码文件存在
      const files = readdirSync(worktree.path)
      console.log('[Test] Worktree files:', files.slice(0, 10).join(', '))
      expect(files.length).toBeGreaterThan(0)

      // 直接调 read_code 读文件
      const { readCodeTool } = await import('../../agent/tools/read-code.js')
      const result = await readCodeTool.execute(
        { path: 'pom.xml' },
        { taskId: 'test', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin' as const, cwd: worktree.path }
      )

      console.log('[Test] read_code result:', result.success, result.output.substring(0, 200))
      expect(result.success).toBe(true)
      expect(result.output.length).toBeGreaterThan(0)
    } finally {
      // 清理 worktree
      const { remove } = await import('../../agent/worktree/manager.js')
      await remove(worktree)
    }
  }, 120_000)

  it('端到端：worktree + Claude 读代码分析', async () => {
    const worktree = await acquire({
      userId: 'test-e2e',
      product: `pl-${productLineId}`,
      version: 'test',
      sessionId: `e2e-${Date.now()}`,
      repoUrl: 'http://code.paraview.cn/PAM/java-code/pas-6.0.git',
    })

    try {
      const authEnv = buildClaudeAuthEnv(process.env.ANTHROPIC_API_KEY)
      const porygon = createPorygon({
        defaultBackend: 'claude',
        backends: {
          claude: {
            model: 'sonnet',
            interactive: false,
            cliPath: join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'claude'),
          },
        },
        defaults: { timeoutMs: 60_000, maxTurns: 5 },
      })

      // 让 Claude 读 worktree 里的代码
      const mcpServerPath = join(__dirname, '..', '..', 'agent', 'mcp-server.ts')
      let textBuffer = ''

      for await (const msg of porygon.query({
        prompt: `读取 pom.xml 文件，告诉我这个项目的 artifactId 和 version。用 read_code 工具。`,
        appendSystemPrompt: '你是代码分析助手。使用 read_code 工具读取文件。只回复文件内容的关键信息。',
        mcpServers: {
          'chatops-tools': {
            command: 'node',
            args: ['--import', 'tsx/esm', mcpServerPath],
            env: {
              ...(process.env as Record<string, string>),
              CHATOPS_TASK_CONTEXT: JSON.stringify({ taskId: 'e2e', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin', cwd: worktree.path }),
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

      console.log('[Test] Claude E2E output (first 500):', textBuffer.substring(0, 500))

      expect(textBuffer).not.toContain('hit your limit')
      expect(textBuffer.length).toBeGreaterThan(10)

      await porygon.dispose()
    } finally {
      await remove(worktree)
    }
  }, 120_000)
})
