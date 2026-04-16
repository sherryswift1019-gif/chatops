import { createPorygon, type Porygon } from '@snack-kit/porygon'
import type { IMAdapter } from '../adapters/im/types.js'
import { getTool, getAllTools, getPermittedTools } from './tools/index.js'
import type { AgentTool, TaskContext, Role } from './tools/types.js'
import { getRecentTasks } from '../db/repositories/tasks.js'
import { listCapabilities, getCapabilityByKey, type Capability } from '../db/repositories/capabilities.js'
import { checkCapabilityAccess } from '../db/repositories/product-line-capabilities.js'
import { getProductLineById } from '../db/repositories/product-lines.js'
import { listProjects } from '../db/repositories/projects-repo.js'
import { listTestServers } from '../db/repositories/test-servers.js'
import { listProductLineEnvs } from '../db/repositories/product-line-envs.js'
import { buildClaudeAuthEnv } from './claude-auth.js'
import { listEnvironments } from '../db/repositories/environments-repo.js'
import { buildClaudeEnv } from './claude-config.js'
import { ApprovalRouter } from '../approval/router.js'
import { getApprovalRules } from '../db/repositories/approval-rules.js'
import { acquireLock, releaseLock } from './deploy-lock.js'
import { acquire, release, type Worktree } from './worktree/manager.js'
import { getByProductLineId } from '../db/repositories/product-knowledge-repos.js'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface RunOptions {
  prompt: string
  context: TaskContext
  groupId: string
  platform: string
  adapter: IMAdapter
  executionMode?: boolean
  approvedBy?: string
  productLineId?: number
  lockProject?: string
  lockEnv?: string
}

interface DetectedIntent {
  capability: string
  project?: string
  env?: string
  summary: string
}

// Session per user with auto-expiry
interface UserSession {
  sessionId: string
  lastUsed: number
  tools: AgentTool[]
  lock?: { project: string; env: string }
}

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes

function interpolatePrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

async function buildProjectContext(productLineId: number): Promise<string> {
  const [pl, projects, servers, envs] = await Promise.all([
    getProductLineById(productLineId),
    listProjects(productLineId),
    listTestServers(productLineId),
    listProductLineEnvs(productLineId),
  ])

  const lines: string[] = ['', '--- 当前上下文 ---']

  if (pl) {
    lines.push(`产品线: ${pl.displayName} (${pl.name})`)
  }

  if (projects.length > 0) {
    lines.push('模块:')
    for (const p of projects) {
      const parts = [p.displayName || p.name]
      if (p.gitlabPath) parts.push(`GitLab=${p.gitlabPath}`)
      if (p.composePath) parts.push(`Compose=${p.composePath}`)
      if (p.dockerContainerName) parts.push(`容器=${p.dockerContainerName}`)
      if (p.k8sProjectName) parts.push(`K8s=${p.k8sProjectName}`)
      if (p.harborProject) parts.push(`Harbor=${p.harborProject}`)
      lines.push(`- ${parts.join(', ')}`)
    }
  }

  if (servers.length > 0) {
    lines.push('服务器:')
    for (const s of servers) {
      lines.push(`- ${s.name} (${s.role}): ${s.host}:${s.port}`)
    }
  }

  if (envs.length > 0) {
    const summary = new Map<string, number>()
    for (const e of envs) {
      summary.set(e.runtime, (summary.get(e.runtime) ?? 0) + 1)
    }
    lines.push(`环境: ${[...summary.entries()].map(([r, n]) => `${r} x${n}`).join(', ')}`)
  }

  return lines.join('\n')
}

export class ClaudeRunner {
  private porygon: Porygon
  private sessions = new Map<string, UserSession>()

  constructor() {
    this.porygon = createPorygon({
      defaultBackend: 'claude',
      backends: {
        claude: {
          model: 'sonnet',
          interactive: false,
          cliPath: join(__dirname, '..', '..', 'node_modules', '.bin', 'claude'),
        },
      },
      defaults: {
        timeoutMs: 1_200_000, // 20 分钟（分析 Bug 可能需要多轮工具调用）
        maxTurns: 30,
      },
    })

    // session 定时清理（含 lock 释放）
    setInterval(() => {
      for (const [userId, session] of this.sessions) {
        if (Date.now() - session.lastUsed > SESSION_TTL_MS) {
          if (session.lock) releaseLock(session.lock.project, session.lock.env, userId)
          this.sessions.delete(userId)
        }
      }
    }, 10 * 60 * 1000)
  }

  private getSessionId(userId: string): string | undefined {
    const session = this.sessions.get(userId)
    if (!session) return undefined
    if (Date.now() - session.lastUsed > SESSION_TTL_MS) {
      this.clearSession(userId)
      return undefined
    }
    return session.sessionId
  }

  private saveSession(userId: string, sessionId: string, tools: AgentTool[], lock?: { project: string; env: string }): void {
    const existing = this.sessions.get(userId)
    this.sessions.set(userId, {
      sessionId,
      lastUsed: Date.now(),
      tools,
      lock: lock ?? existing?.lock,
    })
  }

  private clearSession(userId: string): void {
    const session = this.sessions.get(userId)
    if (session?.lock) {
      releaseLock(session.lock.project, session.lock.env, userId)
    }
    this.sessions.delete(userId)
  }

  async run(opts: RunOptions): Promise<void> {
    const { prompt, context, adapter, executionMode = false, productLineId } = opts
    const userId = context.initiatorId

    try {
      // executionMode（审批通过后）
      if (executionMode) {
        // 审批后执行也需要部署锁
        if (opts.lockProject && opts.lockEnv) {
          const lockMsg = acquireLock(opts.lockProject, opts.lockEnv, userId, 'deploy')
          if (lockMsg) {
            await adapter.sendMessage({ type: 'group', id: opts.groupId }, { text: lockMsg })
            return
          }
        }
        const tools = getAllTools().filter(t => t.name !== 'request_approval')
        try {
          await this.executeWithPorygon(opts, tools)
        } finally {
          if (opts.lockProject && opts.lockEnv) releaseLock(opts.lockProject, opts.lockEnv, userId)
        }
        return
      }

      // Step 1: 每次都先 intent 检测
      console.log('[Runner] Step 1: detecting intent for:', prompt)
      const intent = await this.detectIntent(prompt)
      console.log('[Runner] Intent result:', JSON.stringify(intent))

      // Step 2: greet → 固定帮助（永不 resume）
      if (intent?.capability === 'greet') {
        await this.sendGreeting(adapter, opts.groupId)
        return
      }

      // Step 3: intent=null（跟进回复如"好""是的"）→ 尝试 resume
      if (!intent) {
        const session = this.sessions.get(userId)
        if (session && (Date.now() - session.lastUsed) <= SESSION_TTL_MS) {
          try {
            console.log(`[Runner] Resuming session for user ${userId} with: "${prompt}"`)
            await this.executeWithPorygon(opts, session.tools)
            return
          } catch {
            // Porygon session 可能已过期，清除避免死循环
            this.clearSession(userId)
          }
        }
        // 无 session 也无 intent → 当 greet
        await this.sendGreeting(adapter, opts.groupId)
        return
      }

      // Step 4: 有具体 capability → 查找 + 权限检查
      const capability = await getCapabilityByKey(intent.capability)
      if (!capability) {
        await adapter.sendMessage(
          { type: 'group', id: opts.groupId },
          { text: `抱歉，「${intent.capability}」不是我支持的能力。` }
        )
        return
      }

      const userRole = context.initiatorRole ?? 'developer'

      // 4a: 未绑定产线的用户无法执行非查询类能力
      if (!productLineId && capability.category !== 'query') {
        await adapter.sendMessage(
          { type: 'group', id: opts.groupId },
          { text: `⛔ 你还未加入任何产线，无法执行「${capability.displayName}」。请联系管理员将你添加到产线成员中。` }
        )
        return
      }

      // 4b: 已有产线的用户检查 capability-level 权限
      if (productLineId) {
        const envName = intent.env ?? '*'
        const access = await checkCapabilityAccess(productLineId, capability.key, envName, userRole)
        if (!access.allowed) {
          await adapter.sendMessage(
            { type: 'group', id: opts.groupId },
            { text: `⛔ 无法执行「${capability.displayName}」：${access.reason}` }
          )
          return
        }
      }

      // 4c: 检查用户 role 是否有权使用该能力的核心工具
      if (productLineId) {
        const permitted = await getPermittedTools(userRole as Role, productLineId)
        const permittedNames = new Set(permitted.map(t => t.name))
        const hasAnyCapTool = capability.toolNames.some(name => permittedNames.has(name))
        if (!hasAnyCapTool) {
          await adapter.sendMessage(
            { type: 'group', id: opts.groupId },
            { text: `⛔ 你的角色（${userRole}）无权执行「${capability.displayName}」。如需此权限，请联系管理员。` }
          )
          return
        }
      }

      // Step 5: 加载工具
      const capabilityTools = capability.toolNames
        .map(name => getTool(name))
        .filter((t): t is AgentTool => t !== undefined)

      if (capabilityTools.length === 0) {
        await adapter.sendMessage(
          { type: 'group', id: opts.groupId },
          { text: `「${capability.displayName}」能力暂无可用工具。` }
        )
        return
      }

      // Step 6: 审批拦截（代码级强制）
      if (capability.needsApproval && !executionMode) {
        const rules = await getApprovalRules()
        const router = new ApprovalRouter(rules)
        const envName = intent.env ?? '*'
        const rule = router.route(capability.key, envName)

        if (rule) {
          console.log(`[Runner] Approval required for ${capability.key} env=${envName}`)
          const approvalOnly = capabilityTools.filter(t => t.name === 'request_approval')
          if (approvalOnly.length === 0) {
            await adapter.sendMessage(
              { type: 'group', id: opts.groupId },
              { text: `「${capability.displayName}」需要审批但审批工具不可用。请联系管理员。` }
            )
            return
          }
          opts.context.originalPrompt = prompt
          // 清旧 session → 加锁 → 执行审批
          this.clearSession(userId)
          await this.executeWithPorygon(opts, approvalOnly, capability)
          return
        }
        console.log(`[Runner] No approval rule for ${capability.key} env=${envName}, auto-approved`)
      }

      // ── 所有检查通过，清旧 session + 加锁 + 执行 ──

      this.clearSession(userId)

      // 写操作加 deploy lock
      const writeCapabilities = new Set(['deploy', 'rollback', 'restart'])
      const needsLock = writeCapabilities.has(intent.capability) && intent.project && intent.env
      let lockInfo: { project: string; env: string } | undefined

      if (needsLock) {
        // 归一化 project/env 名称
        const projects = await listProjects()
        const p = projects.find(x => x.name === intent.project || x.displayName === intent.project)
        const normalizedProject = p?.name ?? intent.project!
        const envs = await listEnvironments()
        const e = envs.find(x => x.name === intent.env || x.displayName === intent.env)
        const normalizedEnv = e?.name ?? intent.env!

        const lockMsg = acquireLock(normalizedProject, normalizedEnv, userId, intent.capability)
        if (lockMsg) {
          await adapter.sendMessage({ type: 'group', id: opts.groupId }, { text: lockMsg })
          return
        }
        lockInfo = { project: normalizedProject, env: normalizedEnv }
      }

      try {
        await this.executeWithPorygon(opts, capabilityTools, capability, lockInfo)
      } catch (err) {
        // 异常时释放未被 session 接管的锁
        if (lockInfo && !this.sessions.has(userId)) {
          releaseLock(lockInfo.project, lockInfo.env, userId)
        }
        throw err
      }

    } catch (err) {
      console.error('[Runner] Error:', err)
      await adapter.sendMessage(
        { type: 'group', id: opts.groupId },
        { text: `❌ Agent error: ${String(err)}` }
      ).catch(e => console.error('[Runner] Failed to send error to IM:', e))
    }
  }

  private async sendGreeting(adapter: IMAdapter, groupId: string): Promise<void> {
    const caps = await listCapabilities()
    const examples: Record<string, string> = {
      deploy: '部署 ssh-proxy 到 dev 环境，分支 develop',
      rollback: '回滚 ssh-proxy dev 环境',
      restart: '重启 rdp-proxy dev 环境',
      custom_script: '在 proxy-server 上执行 df -h',
      manage_role: '给黄文华 ops 角色',
      view_deployments: '查看 ssh-proxy 的部署历史',
      view_images: '查看 rdp-proxy 的镜像列表',
      view_logs: '查看 ssh-proxy dev 环境最近 50 行日志',
      view_commits: '查看 ssh-proxy 最近的提交记录',
      view_projects: '查看当前产线有哪些模块',
    }
    const capsList = caps.map(c => {
      const ex = examples[c.key]
      return ex
        ? `- **${c.displayName}** — ${c.description}\n  > 💬 \`${ex}\``
        : `- **${c.displayName}** — ${c.description}`
    }).join('\n')
    const text = [
      '## 你好！我是 ChatOps 助手',
      '**我目前支持以下能力：**',
      capsList,
      '直接用自然语言告诉我你想做什么即可。',
    ].join('\n\n')
    await adapter.sendMessage({ type: 'group', id: groupId }, { text })
  }

  private async detectIntent(prompt: string): Promise<DetectedIntent | null> {
    const capabilities = await listCapabilities()
    const capList = capabilities.map(c => `- ${c.key}: ${c.displayName} (${c.description})`).join('\n')

    try {
      console.log('[Runner] Calling porygon.run for intent detection...')
      const result = await this.porygon.run({
        prompt: `分析以下用户请求，识别意图。

可用能力:
${capList}

用户请求: ${prompt}

重要规则:
1. 如果用户提到"执行"、"运行"、"触发"某个流水线名称，优先匹配 pipeline_ 开头的能力
2. 流水线名称可能是产品名、模块名等，如"执行Windows流水线"应匹配 pipeline_X 而非 view_deployments
3. 如果用户回复是简短的确认、否认或补充信息（如"好"、"是的"、"不"、"1"、"对"、"用 dev 分支"、"ssh-proxy"），说明是在回复之前的对话，返回 null（不要返回 JSON）
4. 仅当用户主动打招呼、问好、或询问系统功能时才返回 greet

返回 JSON（不要代码块）：
{"capability":"能力key","project":"模块名(如有)","env":"环境名(如有)","summary":"一句话总结"}

如果用户在打招呼、问好、询问功能，返回：
{"capability":"greet","summary":"打招呼"}

如果不属于任何已知能力，返回：
{"capability":"unknown","summary":"无法识别"}

如果是简短的确认/否认/补充信息，直接返回文本 null`,
        maxTurns: 1,
        disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill', 'AskUserQuestion'],
        envVars: await buildClaudeEnv(),
      })

      console.log('[Runner] Porygon raw result:', result)
      const cleaned = result.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()
      if (cleaned === 'null' || cleaned === '') return null
      const parsed = JSON.parse(cleaned) as DetectedIntent
      return parsed.capability === 'unknown' ? null : parsed
    } catch (err) {
      console.error('[Runner] detectIntent error:', err)
      return null
    }
  }

  private async executeWithPorygon(opts: RunOptions, tools: AgentTool[], capability?: Capability, lockInfo?: { project: string; env: string }): Promise<void> {
    const { prompt, context, adapter, executionMode = false } = opts
    const userId = context.initiatorId

    const FALLBACK_PROMPT = '你是一个 DevOps 助手。用户通过群聊与你交互。只使用提供给你的 MCP 工具，不要使用 Bash 等内置工具。'

    let systemPrompt: string
    if (executionMode) {
      systemPrompt = '你是一个 DevOps 自动化 agent，正在执行已审批的操作。直接执行，无需再次确认。'
    } else if (capability?.systemPrompt) {
      systemPrompt = interpolatePrompt(capability.systemPrompt, {
        initiatorRole: context.initiatorRole ?? 'developer',
      })
    } else {
      systemPrompt = FALLBACK_PROMPT
    }

    // 注入项目上下文
    if (opts.productLineId) {
      try {
        systemPrompt += await buildProjectContext(opts.productLineId)
      } catch (err) {
        console.error('[Runner] Failed to build project context:', err)
      }
    }

    // 需要代码访问的 capability，自动创建 worktree
    const CODE_CAPABILITIES = ['analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3']
    let worktree: Worktree | null = null
    console.log(`[Runner] worktree check: capability=${capability?.key}, productLineId=${opts.productLineId}`)
    if (capability && CODE_CAPABILITIES.includes(capability.key) && opts.productLineId) {
      try {
        const knowledgeRepo = await getByProductLineId(opts.productLineId)
        if (knowledgeRepo) {
          worktree = await acquire({
            userId: context.initiatorId,
            product: `pl-${opts.productLineId}`,
            version: knowledgeRepo.codeDefaultBranch,
            sessionId: context.taskId,
            repoUrl: knowledgeRepo.codeRepoUrl,
          })
          context.cwd = worktree.path
          console.log(`[Runner] Worktree acquired: ${worktree.path}`)
        }
      } catch (err) {
        console.error('[Runner] Failed to acquire worktree:', err)
      }
    }

    const recentTasks = await getRecentTasks(context.groupId, 5)
    const contextNote = recentTasks.length
      ? `\n最近活动:\n${recentTasks.map(t => `- ${t.intent} (${t.status})`).join('\n')}`
      : ''

    const toolNames = tools.map(t => t.name)
    const mcpServerPath = join(__dirname, 'mcp-server.ts')
    console.log(`[Runner] executeWithPorygon: mcpServerPath=${mcpServerPath}, tools=[${toolNames.join(',')}]`)

    // Resume existing session for this user if available
    const existingSessionId = this.getSessionId(userId)
    if (existingSessionId) {
      console.log(`[Runner] Resuming session: ${existingSessionId} for user: ${userId}`)
    } else {
      console.log(`[Runner] New session for user: ${userId}`)
    }

    let textBuffer = ''

    try {
      console.log('[Runner] Starting porygon.query()...')
      const claudeEnv = await buildClaudeEnv()
      for await (const msg of this.porygon.query({
        prompt: prompt + contextNote,
        appendSystemPrompt: systemPrompt,
        ...(existingSessionId ? { resume: existingSessionId } : {}),
        mcpServers: {
          'chatops-tools': {
            command: 'node',
            args: ['--import', 'tsx/esm', mcpServerPath],
            env: {
              ...(process.env as Record<string, string>),
              CHATOPS_TASK_CONTEXT: JSON.stringify(context),
              CHATOPS_ALLOWED_TOOLS: toolNames.join(','),
              DATABASE_URL: process.env.DATABASE_URL ?? '',
              ...claudeEnv,
            },
          },
        },
        disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill', 'AskUserQuestion'],
        envVars: claudeEnv,
      })) {
        console.log(`[Runner] Porygon msg: type=${msg.type}`, msg.type === 'error' ? msg.message : '')

        // Capture sessionId from any message
        if ('sessionId' in msg && msg.sessionId) {
          this.saveSession(userId, msg.sessionId as string, tools, lockInfo)
        }

        switch (msg.type) {
          case 'assistant':
            if (msg.text) textBuffer += msg.text
            break

          case 'tool_use':
            console.log(`[Runner] Tool called: ${msg.toolName}`)
            break

          case 'result':
            if ('sessionId' in msg && msg.sessionId) {
              this.saveSession(userId, msg.sessionId as string, tools, lockInfo)
            }
            console.log(`[Runner] Porygon result received`)
            break

          case 'error':
            console.error(`[Runner] Porygon error: ${msg.message}`)
            await adapter.sendMessage(
              { type: 'group', id: opts.groupId },
              { text: `⚠️ Agent 错误: ${msg.message}` }
            )
            return
        }
      }
      console.log(`[Runner] Porygon query completed, textBuffer length=${textBuffer.length}`)
    } catch (err) {
      console.error('[Runner] executeWithPorygon error:', err)
      this.clearSession(userId)
      await adapter.sendMessage(
        { type: 'group', id: opts.groupId },
        { text: `❌ 执行错误: ${String(err)}` }
      ).catch(e => console.error('[Runner] Failed to send error:', e))
      return
    }

    if (textBuffer.trim()) {
      await adapter.sendMessage(
        { type: 'group', id: opts.groupId },
        { text: textBuffer.trim() }
      )
    }

    // 释放 worktree
    if (worktree) {
      release(worktree)
      console.log(`[Runner] Worktree released: ${worktree.path}`)
    }
  }

  /**
   * 直接执行 capability（Agent 内部调用，不经 IM 流程）。
   * 用于 AgentCoordinator 触发分析/修复/Review。
   * 返回 Claude 的完整文本输出。
   */
  async executeCapabilityDirect(opts: {
    prompt: string
    systemPrompt: string
    context: TaskContext
    tools: AgentTool[]
    cwd?: string
    sessionKey?: string
  }): Promise<string> {
    const { prompt, systemPrompt, context, tools, cwd, sessionKey } = opts
    const mcpServerPath = join(__dirname, 'mcp-server.ts')
    const toolNames = tools.map(t => t.name)

    const existingSessionId = sessionKey ? this.getSessionId(sessionKey) : undefined

    let textBuffer = ''

    for await (const msg of this.porygon.query({
      prompt,
      appendSystemPrompt: systemPrompt,
      ...(existingSessionId ? { resume: existingSessionId } : {}),
      ...(cwd ? { cwd } : {}),
      mcpServers: {
        'chatops-tools': {
          command: 'node',
          args: ['--import', 'tsx/esm', mcpServerPath],
          env: {
            ...(process.env as Record<string, string>),
            CHATOPS_TASK_CONTEXT: JSON.stringify({ ...context, cwd }),
            DATABASE_URL: process.env.DATABASE_URL ?? '',
            ...buildClaudeAuthEnv(process.env.ANTHROPIC_API_KEY),
          },
        },
      },
      disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      envVars: buildClaudeAuthEnv(process.env.ANTHROPIC_API_KEY),
    })) {
      if ('sessionId' in msg && msg.sessionId && sessionKey) {
        this.saveSessionId(sessionKey, msg.sessionId as string)
      }
      if (msg.type === 'assistant' && 'content' in msg) {
        textBuffer += String(msg.content)
      } else if (msg.type === 'result' && 'text' in msg) {
        textBuffer += String(msg.text)
      }
    }

    return textBuffer
  }

  async dispose(): Promise<void> {
    await this.porygon.dispose()
  }
}
