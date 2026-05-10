/**
 * Quick-Impl 专用 MCP Server (PRD §8.4.1)
 *
 * 与 src/agent/mcp-server.ts 不同：本 server 仅 register `commit_artifact` 一个工具。
 * 物理隔离 → 子 agent 看不到 deploy / rollback / db_update / script 等危险工具。
 *
 * 由 src/quick-impl/skill-runner.ts 启 ClaudeRunner 时通过 mcpServerPath 参数指向本文件。
 *
 * 启动方式（Claude CLI 通过 mcpServers 配置）:
 *   node --import tsx/esm src/quick-impl/mcp-server.ts
 *
 * Env 入参：
 *   QI_REQUIREMENT_ID  必填——commit_artifact 用于校验分支名 / cwd 路径
 *   QI_NODE_ID         可选——日志标识
 */
import { exec } from 'child_process'
import { appendFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const execAsync = promisify(exec)

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mcpLog(msg: string): void {
  const line = `[${new Date().toISOString()}] [MCP-QI] ${msg}\n`
  try {
    appendFileSync('/tmp/mcp-server-quick-impl.log', line)
  } catch {
    /* ignore */
  }
}

const REQUIREMENT_ID = process.env.QI_REQUIREMENT_ID
const NODE_ID = process.env.QI_NODE_ID ?? 'unknown'

if (!REQUIREMENT_ID || !/^\d+$/.test(REQUIREMENT_ID)) {
  // eslint-disable-next-line no-console
  console.error(
    '[mcp-server-quick-impl] FATAL: QI_REQUIREMENT_ID env not set or invalid',
  )
  process.exit(1)
}

const REQ_ID_NUM = Number(REQUIREMENT_ID)
const WT_BASE = process.env.WORKTREE_BASE_QI ?? '/tmp/quick-impl'
const ALLOWED_BRANCH_RE = new RegExp(`^feat/qi-${REQ_ID_NUM}(-r\\d+)?$`)
const ALLOWED_CWD_PREFIX_RE = new RegExp(
  `^${escapeRegex(WT_BASE)}/qi-${REQ_ID_NUM}(/r\\d+)?(/|$)`,
)
const FORBIDDEN_PATH_PATTERNS = [
  /^\.git\//,
  /^\.github\//,
  /^\.gitlab-ci\.yml$/,
  /^\.gitlab\//,
  /^\.env(\.|$)/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /\.\.\//, // 路径穿越
]
const MAX_FILES_PER_COMMIT = 50
const MAX_MESSAGE_LEN = 200
const MESSAGE_BLOCKLIST = [/\[skip\s*ci\]/i, /\[ci\s*skip\]/i]

mcpLog(`startup: QI_REQUIREMENT_ID=${REQ_ID_NUM} QI_NODE_ID=${NODE_ID}`)

// =============================================================================
// commit_artifact tool
// =============================================================================

interface CommitArtifactInput {
  path: string
  message: string
  body?: string
  task_index?: number
  phase?: 'red' | 'green'
}

interface CommitArtifactOutput {
  commitSha: string
  filesChanged: number
}

async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
    cwd,
    timeout: 10_000,
  })
  return stdout.trim()
}

async function getStagedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execAsync('git diff --cached --name-only', {
    cwd,
    timeout: 10_000,
  })
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function commitArtifact(
  input: CommitArtifactInput,
): Promise<CommitArtifactOutput> {
  const cwd = process.cwd()

  // §8.4.4 校验
  if (!ALLOWED_CWD_PREFIX_RE.test(cwd)) {
    throw new Error(
      `cwd not allowed: ${cwd}（must be inside /tmp/quick-impl/qi-${REQ_ID_NUM}/）`,
    )
  }

  const branch = await getCurrentBranch(cwd)
  if (!ALLOWED_BRANCH_RE.test(branch)) {
    throw new Error(
      `branch not allowed: ${branch}（must match ^feat/qi-${REQ_ID_NUM}(-r\\d+)?$）`,
    )
  }

  // 输入校验
  if (!input.path || typeof input.path !== 'string') {
    throw new Error('path is required')
  }
  if (!input.message || typeof input.message !== 'string') {
    throw new Error('message is required')
  }
  if (input.message.length > MAX_MESSAGE_LEN) {
    throw new Error(
      `commit message too long: ${input.message.length} > ${MAX_MESSAGE_LEN}`,
    )
  }
  for (const blocked of MESSAGE_BLOCKLIST) {
    if (blocked.test(input.message)) {
      throw new Error(`commit message contains blocked pattern: ${blocked}`)
    }
  }

  for (const re of FORBIDDEN_PATH_PATTERNS) {
    if (re.test(input.path)) {
      throw new Error(`path forbidden by sandbox policy: ${input.path}`)
    }
  }

  if (input.task_index !== undefined && input.phase === undefined) {
    throw new Error('task_index requires phase')
  }
  if (input.phase !== undefined && input.task_index === undefined) {
    throw new Error('phase requires task_index')
  }
  if (
    input.task_index !== undefined &&
    (!Number.isInteger(input.task_index) || input.task_index < 0)
  ) {
    throw new Error('task_index must be non-negative integer')
  }
  if (input.phase && !['red', 'green'].includes(input.phase)) {
    throw new Error('phase must be "red" or "green"')
  }

  // git add + 改动文件数检查
  await execAsync(`git add -- ${shellQuote(input.path)}`, { cwd, timeout: 30_000 })
  const staged = await getStagedFiles(cwd)
  if (staged.length === 0) {
    throw new Error(
      `no changes to commit on ${input.path}（git diff --cached 为空）`,
    )
  }
  if (staged.length > MAX_FILES_PER_COMMIT) {
    throw new Error(
      `too many staged files: ${staged.length} > ${MAX_FILES_PER_COMMIT}`,
    )
  }

  // commit：把 message 写到临时文件，用 -F 引用——避免 shell 注入
  const fullMsg = input.body
    ? `${input.message}\n\n${input.body}`
    : input.message
  const tmpDir = mkdtempSync(join(tmpdir(), 'qi-commit-msg-'))
  const msgFile = join(tmpDir, 'COMMIT_MSG')
  writeFileSync(msgFile, fullMsg, 'utf8')

  try {
    await execAsync(`git commit -F ${shellQuote(msgFile)}`, {
      cwd,
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: 'ChatOps Quick-Impl',
        GIT_COMMITTER_EMAIL: 'chatops@quick-impl.local',
        GIT_AUTHOR_NAME: 'ChatOps Quick-Impl',
        GIT_AUTHOR_EMAIL: 'chatops@quick-impl.local',
      },
    })
  } catch (err) {
    // commit 失败回滚 staging，避免污染下一次调用
    await execAsync('git reset HEAD', { cwd, timeout: 10_000 }).catch(() => {})
    throw err
  } finally {
    try {
      unlinkSync(msgFile)
    } catch {
      /* ignore */
    }
  }

  const sha = await execAsync('git rev-parse HEAD', {
    cwd,
    timeout: 10_000,
  }).then((r) => r.stdout.trim())

  mcpLog(
    `commit_artifact ok: req=${REQ_ID_NUM} node=${NODE_ID} sha=${sha} files=${staged.length} task_index=${input.task_index ?? '-'} phase=${input.phase ?? '-'}`,
  )

  // TODO Day 7-9：通过 IPC / DB 把 task_completed 事件发回 chatops 主进程。
  // Phase 1 当前阶段无 IPC 通道——pipeline_run_events 写入由节点 executor 在
  // skill-runner 返回 result 之后写。这里不直接写 DB（MCP server 子进程）。

  return { commitSha: sha, filesChanged: staged.length }
}

// 简陋 shell quote（仅用于 git add 路径——不接受用户特殊字符触发的注入）
function shellQuote(s: string): string {
  if (!/[^a-zA-Z0-9_./-]/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// =============================================================================
// MCP server boilerplate
// =============================================================================

const server = new Server(
  { name: 'mcp-server-quick-impl', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

const TOOL_DEFS = [
  {
    name: 'commit_artifact',
    description:
      'Commit a single file artifact in the current quick-impl worktree. ' +
      'Required by quick-impl skills (spec / plan / code / tests). ' +
      'Validates cwd / branch / path against sandbox policy. Phase 1.',
    inputSchema: {
      type: 'object' as const,
      required: ['path', 'message'],
      properties: {
        path: {
          type: 'string',
          description:
            'Relative path to the artifact within the worktree, e.g. "docs/specs/qi-5.md"',
        },
        message: {
          type: 'string',
          description: 'Commit message (≤ 200 chars, no [skip ci])',
        },
        body: {
          type: 'string',
          description: 'Optional commit body (multi-line description)',
        },
        task_index: {
          type: 'number',
          description:
            'For dev-loop role: 0..N-1 dense index. Must be paired with phase.',
        },
        phase: {
          type: 'string',
          enum: ['red', 'green'],
          description:
            'For dev-loop role: red=failing test commit, green=passing implementation commit',
        },
      },
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFS,
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  if (name !== 'commit_artifact') {
    throw new Error(`unknown tool: ${name}`)
  }
  try {
    const result = await commitArtifact(args as unknown as CommitArtifactInput)
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    mcpLog(`commit_artifact error: ${msg}`)
    return {
      isError: true,
      content: [{ type: 'text', text: msg }],
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
mcpLog('connected')
