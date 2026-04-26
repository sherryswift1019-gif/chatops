import { createPorygon, type Porygon } from '@snack-kit/porygon'
import type { IMAdapter } from '../adapters/im/types.js'
import { getTool, getAllTools, getPermittedTools } from './tools/index.js'
import type { AgentTool, TaskContext, Role } from './tools/types.js'
import { getRecentTasks } from '../db/repositories/tasks.js'
import { getCapabilityByKey, type Capability } from '../db/repositories/capabilities.js'
import { listIMTriggers, getIMTrigger } from '../db/repositories/im-triggers.js'
import { checkIMTriggerAccess, listProductLineIMTriggers } from '../db/repositories/product-line-im-triggers.js'
import { filterImTriggerableTriggers } from './runner-greet-filter.js'
import { getProductLineById } from '../db/repositories/product-lines.js'
import { listProjects } from '../db/repositories/projects-repo.js'
import { listTestServers } from '../db/repositories/test-servers.js'
import { listProductLineEnvs } from '../db/repositories/product-line-envs.js'
import { listEnvironments } from '../db/repositories/environments-repo.js'
import { buildClaudeEnv } from './claude-config.js'
import { getConfig } from '../db/repositories/system-config.js'
import { triggerCapability, maybeCompleteAnalyze } from './coordinator.js'
import { ApprovalRouter } from '../approval/router.js'
import { getApprovalRules } from '../db/repositories/approval-rules.js'
import { acquireLock, releaseLock } from './deploy-lock.js'
import { acquire, release, type Worktree } from './worktree/manager.js'
import { getByProductLineId } from '../db/repositories/product-knowledge-repos.js'
import { getPrdDocumentById } from '../db/repositories/prd-documents.js'
import { buildRejectSystemPromptAppendix } from './prd/reject-seed.js'
import { dirname, join, resolve as pathResolve, relative as pathRelative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 把 capability handler 返回的内部 error code（见 analyzer.classifyError / fix-runner /
 * approve-l3-handler 等）翻译成面向终端用户的中文友好提示。
 *
 * phase 2 起,im_trigger.failure_messages (JSONB) 是失败提示的唯一数据源——
 * key = error code, value = 用户可见文案。未配置 / 字典漏更新时回落到
 * "<DisplayName>未完成,请稍后重试",避免技术码泄露给用户。底层 error 仍
 * console.error 到日志,内部排查用。
 */
async function buildFailureReply(imTriggerKey: string, errorCode?: string): Promise<string> {
  const trigger = await getIMTrigger(imTriggerKey)
  const cap = trigger?.displayName ?? '处理'
  const detail = trigger?.failureMessages?.[errorCode ?? ''] ?? null
  return detail ? `${cap}未完成：${detail}` : `${cap}未完成，请稍后重试`
}

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
  userName?: string
  senderDingtalkId?: string
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

/**
 * 构造"当前 PRD 上下文"段，拼到 Web chat 的 systemPrompt 末尾。
 * 用户在 PRD 列表点「继续对话」进来时，session 绑定了 prdId；
 * 把当前 PRD 的 id / 标题 / 版本 / 状态透传给 Claude，
 * 避免它把"审查 / 修改 / 看一下"等指代解析为随便搜一个别的 PRD。
 */
async function buildPrdContext(prdId: number): Promise<string> {
  const prd = await getPrdDocumentById(prdId)
  if (!prd) return ''
  const lines: string[] = [
    '',
    '--- 当前 PRD 上下文 ---',
    `你正在继续一个已有 PRD 的对话。用户的"审查 / 改 / 读 / 看一下"等指代默认指向这份 PRD。`,
    `PRD ID: ${prd.id}`,
    `标题: ${prd.title}`,
    `版本: v${prd.version}`,
    `状态: ${prd.status}`,
    '',
    `需要读取完整内容时调 read_prd({ prdId: ${prd.id} })。`,
    `需要更新时调 save_prd({ prdId: ${prd.id}, title, contentMarkdown })——必须整份 markdown 回传，不要只回传 diff。`,
    `严禁用 Write / Edit / MultiEdit 去写 docs/prds/*.md；一切 PRD 正文写入只能走 save_prd，否则会产生重复/新建 PRD。`,
    `不要调 search_existing_prds 去找别的 PRD，也不要自行猜测别的 prdId。`,
  ]

  // drafting + 最近一次 review 是 reject → 把驳回原因/blockers 注入系统提示，
  // 让下一轮对话（无论是新建 session 还是 resume）都带上承接上下文。
  const appendix = buildRejectSystemPromptAppendix(prd)
  if (appendix) lines.push(appendix)

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

  /** 供外部（如 IM /new 命令）主动结束某用户的当前对话。返回是否实际清理了 session。 */
  endUserSession(userId: string): boolean {
    const existed = this.sessions.has(userId)
    if (existed) this.clearSession(userId)
    return existed
  }

  async run(opts: RunOptions): Promise<void> {
    const { prompt, context, adapter, executionMode = false, productLineId, senderDingtalkId } = opts
    const userId = context.initiatorId
    const atIds = senderDingtalkId ? [senderDingtalkId] : undefined

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

      // Step 0: 群内审批命令路径已下线（main 的 LangGraph 改造把 approval-manager.tryHandleCommand 移除）。
      //   现走钉钉互动卡片按钮 → TOPIC_CARD → server.ts onCardAction → handleCallback 链路。

      // Step 0b: 从消息文本提取 project 和 branch
      // 约定格式：[@机器人] 项目 分支 问题描述
      // 用 DB 里存的机器人名精确去除 @ mention
      let cleanedPrompt = prompt
      try {
        const robotCfg = await getConfig('dingtalk')
        const robotName = (robotCfg?.value as any)?.robotName
        if (robotName) {
          cleanedPrompt = cleanedPrompt.replace(new RegExp(`@${robotName}`, 'g'), '')
        }
      } catch {}
      cleanedPrompt = cleanedPrompt.trim()
      const words = cleanedPrompt.split(/\s+/)
      const parsedProject = words[0] || undefined
      const parsedBranch = words[1]?.replace(/分支$/, '') || undefined
      console.log('[Runner] Step 0b: cleaned=', cleanedPrompt.substring(0, 50), 'project=', parsedProject, 'branch=', parsedBranch)

      // Step 1: intent 检测（识别 capability 类型）
      console.log('[Runner] Step 1: detecting intent for:', prompt)
      const intent = await this.detectIntent(prompt)
      console.log('[Runner] Intent result:', JSON.stringify(intent))

      // Step 2: greet → 固定帮助（永不 resume）
      if (intent?.capability === 'greet') {
        await this.sendGreeting(adapter, opts.groupId, atIds, productLineId, context.initiatorRole ?? 'developer')
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
        await this.sendGreeting(adapter, opts.groupId, atIds, productLineId, context.initiatorRole ?? 'developer')
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

      // 4b: 已有产线的用户检查 IM 触发器权限
      // phase 2 起,IM 入口的允许角色 / trigger_sources 配置从 product_line_im_triggers 读取,
      // 不再走 product_line_capabilities。intent.capability 与 im_trigger.key 同名(数据迁移保证)。
      if (productLineId) {
        const envName = intent.env ?? '*'
        const access = await checkIMTriggerAccess(productLineId, intent.capability, envName, userRole, 'im')
        if (!access.allowed) {
          const imTrigger = await getIMTrigger(intent.capability)
          const triggerName = imTrigger?.displayName ?? capability.displayName
          const text = access.reason === 'source-blocked'
            ? `⛔ 能力「${triggerName}」在当前产线已禁止通过 IM 触发，请到管理后台执行。`
            : `⛔ 无法执行「${triggerName}」：${access.reason}`
          await adapter.sendMessage(
            { type: 'group', id: opts.groupId },
            { text }
          )
          return
        }
      }

      // 4c: 检查用户 role 是否有权使用该能力的核心工具
      // 跳过条件：capability.toolNames=[] —— 说明走 handler-path（如 prd_submit），
      // 该 capability 完全不依赖任何 tool，权限控制由 handler 内部处理（PRD §3.1
      // 的兜底：不合法指令/跨 repo/邮箱未同步/路径不符规范都在 handler 里拒绝）。
      // 若 toolNames 非空，按原逻辑检查角色是否有匹配的 tool。
      if (productLineId && capability.toolNames.length > 0) {
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

      // Step 5: analyze_bug 走通用对话路径（已验证能跑通），其他 Agent capability 走 handler
      const HANDLER_CAPABILITIES = new Set(['analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3', 'ai_review_mr', 'search_knowledge', 'prd_submit'])

      if (HANDLER_CAPABILITIES.has(intent.capability)) {
        console.log(`[Runner] Agent capability: ${intent.capability}, routing to handler`)
        await adapter.sendMessage({ type: 'group', id: opts.groupId }, { text: '收到，处理中...', atDingtalkIds: atIds } as any)

        // 用 userId 作为 sessionKey，让 executeCapabilityDirect 保存 session
        const sessionKey = userId

        const result = await triggerCapability({
          capabilityKey: intent.capability,
          context: {
            ...context,
            productLineId,
          },
          extraParams: {
            message: prompt,
            productLineId,
            version: parsedBranch || intent.env || undefined,
            project: parsedProject || intent.project,
            images: (opts as any).images,
          },
        })

        // 保存 session，让后续追问可以 resume
        const savedSession = this.sessions.get(sessionKey)
        if (savedSession) {
          // executeCapabilityDirect 已通过 sessionKey 保存了 sessionId
          // 确保 tools 也存上，追问时复用
          const capTools = capability.toolNames
            .map(name => getTool(name))
            .filter((t): t is AgentTool => t !== undefined)
          savedSession.tools = capTools
          savedSession.lastUsed = Date.now()
        }

        // 回复结果
        const replyText = result.success
          ? (result.output ?? '处理完成')
          : await buildFailureReply(intent.capability, result.error)
        await adapter.sendMessage({ type: 'group', id: opts.groupId }, { text: replyText, atDingtalkIds: atIds } as any)

        // analyze_bug 完成后：若 result 含 (reportId, level, classification)，触发 Pipeline（后台跑，不阻塞 IM 响应）
        if (intent.capability === 'analyze_bug') {
          void maybeCompleteAnalyze(result, userId).catch(err => {
            console.error('[Runner] maybeCompleteAnalyze error:', err)
          })
        }
        return
      }

      // Step 6: 通用 capability → 加载工具走对话模式
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

      // Step 6: 审批拦截 —— 完全由 approval_rules 决定:有匹配规则即走审批,无规则则自动通过
      if (!executionMode) {
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

      // 写操作加 deploy lock —— 是否需要由 capability.requiresDeployLock 决定（phase 1 起从 DB 读）
      const needsLock = capability.requiresDeployLock && intent.project && intent.env
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

  private async sendGreeting(
    adapter: IMAdapter,
    groupId: string,
    atDingtalkIds?: string[],
    productLineId?: number,
    userRole: string = 'developer',
  ): Promise<void> {
    let triggers = await listIMTriggers()
    if (productLineId) {
      const plTriggers = await listProductLineIMTriggers(productLineId)
      triggers = filterImTriggerableTriggers(triggers, plTriggers, userRole)
    } else {
      triggers = triggers.filter(t => t.enabled)
    }
    if (triggers.length === 0) {
      await adapter.sendMessage(
        { type: 'group', id: groupId },
        { text: '你当前在本产线下没有可通过 IM 触发的能力，请联系管理员或到管理后台查看。', atDingtalkIds } as any
      )
      return
    }
    const capsList = triggers.map(t => {
      const ex = t.examples?.[0]
      return ex
        ? `- **${t.displayName}** — ${t.description}\n  > 💬 \`${ex}\``
        : `- **${t.displayName}** — ${t.description}`
    }).join('\n')
    const text = [
      '## 你好！我是 ChatOps 助手',
      '**我目前支持以下能力：**',
      capsList,
      '直接用自然语言告诉我你想做什么即可。',
    ].join('\n\n')
    await adapter.sendMessage({ type: 'group', id: groupId }, { text, atDingtalkIds } as any)
  }

  private async detectIntent(prompt: string): Promise<DetectedIntent | null> {
    const triggers = await listIMTriggers()
    const capList = triggers
      .filter(t => t.enabled)
      .map(t => `- ${t.key}: ${t.displayName}${t.intentHints ? ` (${t.intentHints})` : ''}`)
      .join('\n')

    try {
      console.log('[Runner] Calling porygon.run for intent detection...')

      // 从 system_config 读取可配置的 intent 规则（fallback 到默认）
      const intentCfg = await getConfig('intent_rules').catch(() => null)
      const intentRules = (intentCfg?.value as Record<string, string>)?.rules ||
`1. 如果用户提到"执行"、"运行"、"触发"某个流水线名称，优先匹配 pipeline_ 开头的能力
2. 流水线名称可能是产品名、模块名等，如"执行Windows流水线"应匹配 pipeline_X 而非 view_deployments
3. 如果用户回复是简短的确认、否认或补充信息（如"好"、"是的"、"不"、"1"、"对"、"用 dev 分支"、"ssh-proxy"），说明是在回复之前的对话，返回 null（不要返回 JSON）
4. 仅当用户主动打招呼、问好、或询问系统功能时才返回 greet
5. 用户提到的分支名（如 test分支、dev分支、master分支、develop分支）应放在 env 字段，不是 project 字段。project 是项目/模块名（如 pas、osc、ssh-proxy）`

      const result = await this.porygon.run({
        prompt: `分析以下用户请求，识别意图。

可用能力:
${capList}

用户请求: ${prompt}

重要规则:
${intentRules}

返回 JSON（不要代码块）：
{"capability":"能力key","project":"模块名(如有)","env":"环境名(如有)","summary":"一句话总结"}

如果用户在打招呼、问好、询问功能，返回：
{"capability":"greet","summary":"打招呼"}

如果不属于任何已知能力，返回：
{"capability":"unknown","summary":"无法识别"}

如果是简短的确认/否认/补充信息，直接返回文本 null`,
        maxTurns: 1,
        disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill', 'AskUserQuestion', 'Agent'],
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
    const runStartedAt = new Date()

    const FALLBACK_PROMPT = '你是一个 DevOps 助手。用户通过群聊与你交互。只使用提供给你的 MCP 工具，不要使用 Bash 等内置工具。'
    const EXECUTION_PROMPT = '你是一个 DevOps 自动化 agent，正在执行已审批的操作。直接执行，无需再次确认。'

    // 从 system_config 读取可配置 prompt（fallback 到写死值）
    const promptsCfg = await getConfig('prompts').catch(() => null)
    const promptsValue = (promptsCfg?.value ?? {}) as Record<string, string>

    let systemPrompt: string
    if (executionMode) {
      systemPrompt = promptsValue.execution || EXECUTION_PROMPT
    } else {
      const effective = capability?.systemPrompt ?? capability?.defaultSystemPrompt ?? null
      if (effective) {
        systemPrompt = interpolatePrompt(effective, {
          initiatorRole: context.initiatorRole ?? 'developer',
        })
      } else {
        systemPrompt = FALLBACK_PROMPT
      }
    }

    // 注入项目上下文
    if (opts.productLineId) {
      try {
        systemPrompt += await buildProjectContext(opts.productLineId)
      } catch (err) {
        console.error('[Runner] Failed to build project context:', err)
      }
    }

    // 需要代码访问的 capability，自动创建 worktree（phase 1 起从 DB 读）
    let worktree: Worktree | null = null
    console.log(`[Runner] worktree check: capability=${capability?.key}, productLineId=${opts.productLineId}`)
    if (capability?.requiresWorktree && opts.productLineId) {
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
        // phase 1: 按 capability 覆盖 Porygon defaults，让单条 capability
        // 可以独立配置（如 analyze_bug 长 timeout / view_logs 短 maxTurns）
        ...(capability ? { maxTurns: capability.maxTurns, timeoutMs: capability.timeoutMs } : {}),
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
        disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill', 'AskUserQuestion', 'Agent'],
        envVars: claudeEnv,
      })) {
        console.log(`[Runner] Porygon msg: type=${msg.type}`, msg.type === 'error' ? msg.message : '')

        // Capture sessionId from any message
        if ('sessionId' in msg && msg.sessionId) {
          this.saveSession(userId, msg.sessionId as string, tools, lockInfo)
        }

        switch (msg.type) {
          case 'assistant':
            if (msg.text) {
              textBuffer += msg.text
              console.log(`[Runner] assistant msg (len=${msg.text.length}): ${msg.text.slice(0, 200).replace(/\n/g, ' ')}${msg.text.length > 200 ? '…' : ''}`)
            }
            break

          case 'tool_use':
            console.log(`[Runner] Tool called: ${msg.toolName}`, JSON.stringify(msg.input).slice(0, 200))
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

    // Post-run hooks: 扫描本次运行中被 save_prd 触达的 PRD，异步触发自审
    if (capability?.key === 'create_prd') {
      try {
        const { scanPendingReviewsByTaskId, triggerPrdReviewAsync } = await import('./prd/prd-agent.js')
        const prdIds = await scanPendingReviewsByTaskId(context.taskId, runStartedAt)
        for (const id of prdIds) {
          console.log(`[Runner] post-run: triggering PRD review for #${id}`)
          triggerPrdReviewAsync(id)
        }
      } catch (err) {
        console.error('[Runner] PRD post-run hook failed:', err)
      }
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
    freshSession?: boolean
    maxTurns?: number
    timeoutMs?: number
  }): Promise<string> {
    const { prompt, systemPrompt, context, tools, cwd, sessionKey, freshSession, maxTurns, timeoutMs } = opts
    const mcpServerPath = join(__dirname, 'mcp-server.ts')

    const existingSessionId = !freshSession && sessionKey ? this.getSessionId(sessionKey) : undefined
    const claudeEnv = await buildClaudeEnv()

    console.log(`[Runner] executeCapabilityDirect: cwd=${cwd}, tools=${tools.map(t=>t.name).join(',')}, resume=${!!existingSessionId}, maxTurns=${maxTurns ?? 200}, timeoutMs=${timeoutMs ?? 'none'}`)

    let textBuffer = ''

    const queryIter = this.porygon.query({
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
            CHATOPS_ALLOWED_TOOLS: tools.map(t => t.name).join(','),
            DATABASE_URL: process.env.DATABASE_URL ?? '',
            ...claudeEnv,
          },
        },
      },
      disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent'],
      envVars: claudeEnv,
      maxTurns: maxTurns ?? 200,
    })

    const consume = async (): Promise<void> => {
      for await (const msg of queryIter) {
        if ('sessionId' in msg && msg.sessionId && sessionKey) {
          this.saveSession(sessionKey, msg.sessionId as string, tools)
        }
        if (msg.type === 'tool_use') {
          const toolName = 'name' in msg ? msg.name : 'unknown'
          console.log(`[Runner] Tool called: ${toolName}`)
        }
        if (msg.type === 'assistant' && 'content' in msg) {
          textBuffer += String(msg.content)
        } else if (msg.type === 'result' && 'text' in msg) {
          textBuffer += String(msg.text)
        }
      }
    }

    if (timeoutMs && timeoutMs > 0) {
      let timer: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // porygon.query 是 AsyncGenerator，尝试 return() 中止迭代；catch 避免终止逻辑反过来抛
          queryIter.return?.(undefined).catch(() => {})
          reject(new Error(`executeCapabilityDirect timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })
      try {
        await Promise.race([consume(), timeoutPromise])
      } finally {
        if (timer) clearTimeout(timer)
      }
    } else {
      await consume()
    }

    console.log(`[Runner] executeCapabilityDirect completed, output length: ${textBuffer.length}`)
    return textBuffer
  }

  async dispose(): Promise<void> {
    await this.porygon.dispose()
  }

  /**
   * Web 端 PRD 对话流式入口（SSE 路由调用）。
   * 与 IM 路径区别：不调 adapter.sendMessage，全部事件 yield 给调用方；
   * sessionKey 作为命名空间写入 this.sessions，与 IM 的 userId 隔离。
   */
  async *streamWebChat(opts: {
    prompt: string
    context: TaskContext
    capabilityKey: string
    sessionKey: string
    resumeSessionId?: string
    productLineId: number
    prdId?: number
  }): AsyncGenerator<WebChatEvent> {
    const capability = await getCapabilityByKey(opts.capabilityKey)
    if (!capability) {
      yield { type: 'error', error: `能力 ${opts.capabilityKey} 不存在` }
      return
    }

    const tools = capability.toolNames
      .map((name) => getTool(name))
      .filter((t): t is AgentTool => t !== undefined)
    if (tools.length === 0) {
      yield { type: 'error', error: `能力「${capability.displayName}」无可用工具` }
      return
    }

    // systemPrompt: capability.systemPrompt（空则回落到 defaultSystemPrompt）+ 产线上下文
    const effectivePrompt = capability.systemPrompt ?? capability.defaultSystemPrompt ?? null
    let systemPrompt = effectivePrompt
      ? interpolatePrompt(effectivePrompt, {
          initiatorRole: opts.context.initiatorRole ?? 'admin',
        })
      : '你是一个 PRD 助手，与产品经理多轮对话共同产出 PRD。'

    try {
      systemPrompt += await buildProjectContext(opts.productLineId)
    } catch (err) {
      console.error('[Runner] streamWebChat buildProjectContext failed:', err)
    }

    if (opts.prdId) {
      try {
        systemPrompt += await buildPrdContext(opts.prdId)
      } catch (err) {
        console.error('[Runner] streamWebChat buildPrdContext failed:', err)
      }
    }

    const mcpServerPath = join(__dirname, 'mcp-server.ts')
    const toolNames = tools.map((t) => t.name)
    const runStartedAt = new Date()

    // resume 优先级：调用方传入（来自 DB） > 内存 session
    const memSessionId = this.getSessionId(opts.sessionKey)
    const resumeId = opts.resumeSessionId ?? memSessionId

    let capturedSessionId: string | undefined

    // 兜底：Write/Edit/MultiEdit 已加入 disallowedTools，Claude 正常情况应走 save_prd。
    // 保留这段 salvage 逻辑作为最后防线：万一将来 disallow 失效或某个 porygon/Claude 版本
    // 不尊重 disallowedTools，仍能把磁盘上的 PRD md 吸回 DB，避免 PRD 孤立。
    const prdsDirAbs = pathResolve(process.cwd(), 'docs/prds')
    const writtenPrdFiles = new Set<string>()
    const isPrdFilePath = (filePath: unknown): string | null => {
      if (typeof filePath !== 'string' || !filePath) return null
      const abs = pathResolve(filePath)
      if (!abs.endsWith('.md')) return null
      const rel = pathRelative(prdsDirAbs, abs)
      if (rel.startsWith('..') || rel.includes('/') || rel.includes('\\')) return null
      return abs
    }

    try {
      const claudeEnv = await buildClaudeEnv()
      for await (const msg of this.porygon.query({
        prompt: opts.prompt,
        appendSystemPrompt: systemPrompt,
        ...(resumeId ? { resume: resumeId } : {}),
        // 精准黑名单：禁 Claude Code 规划者/写代码类工具，避免 Agent 绕过 save_prd 写磁盘
        // 或用 TodoWrite/ExitPlanMode 退化成代码规划人格。保留 Read/WebFetch/WebSearch/Glob/Grep
        // 给 PRD Agent 澄清需求用（见 memory/feedback_disallowed_tools.md 的 Why）。
        disallowedTools: ['Bash', 'Write', 'Edit', 'MultiEdit', 'TodoWrite', 'ExitPlanMode'],
        mcpServers: {
          'chatops-tools': {
            command: 'node',
            args: ['--import', 'tsx/esm', mcpServerPath],
            env: {
              ...(process.env as Record<string, string>),
              CHATOPS_TASK_CONTEXT: JSON.stringify(opts.context),
              CHATOPS_ALLOWED_TOOLS: toolNames.join(','),
              DATABASE_URL: process.env.DATABASE_URL ?? '',
              ...claudeEnv,
            },
          },
        },
        envVars: claudeEnv,
      })) {
        if ('sessionId' in msg && msg.sessionId) {
          capturedSessionId = msg.sessionId as string
          this.saveSession(opts.sessionKey, capturedSessionId, tools)
        }

        switch (msg.type) {
          case 'stream_chunk': {
            // Claude 适配器在分块模式下会从两个源头发 stream_chunk：
            //   1. stream_event 的真实 delta（增量文本）
            //   2. assistant 消息里的 text block（整段重复一遍）
            // 只保留 (1)，否则前端会看到文本重复两次。
            const rawType = (msg.raw as { type?: string } | undefined)?.type
            if (rawType === 'assistant') break
            yield { type: 'stream_chunk', text: msg.text }
            break
          }
          case 'assistant':
            // turnComplete 时 text 与 stream_chunk 累加重复，跳过 text 以免重复
            yield { type: 'assistant', text: msg.turnComplete ? '' : msg.text, turnComplete: !!msg.turnComplete }
            break
          case 'tool_use':
            // 记录本轮 agent 是否用 Write/Edit/MultiEdit 写了 docs/prds/*.md，
            // 为后面绕过 save_prd 的兜底做准备。
            if (msg.toolName === 'Write' || msg.toolName === 'Edit' || msg.toolName === 'MultiEdit') {
              const filePath = (msg.input as Record<string, unknown> | undefined)?.file_path
              const abs = isPrdFilePath(filePath)
              if (abs) writtenPrdFiles.add(abs)
            }
            yield {
              type: 'tool_use',
              toolName: msg.toolName,
              input: msg.input,
              toolUseId: (msg.raw as { id?: string } | undefined)?.id,
            }
            if (msg.output !== undefined) {
              yield {
                type: 'tool_result',
                toolName: msg.toolName,
                output: msg.output,
                toolUseId: (msg.raw as { id?: string } | undefined)?.id,
              }
            }
            break
          case 'result':
            // 结束信号由外层 done 处理
            break
          case 'error':
            yield { type: 'error', error: msg.message }
            return
        }
      }
    } catch (err) {
      console.error('[Runner] streamWebChat error:', err)
      this.clearSession(opts.sessionKey)
      yield { type: 'error', error: String(err) }
      return
    }

    // 自审触发（Web 路径：同步 await + 实时 yield 进度事件；IM 路径保持 fire-and-forget）
    if (capability.key === 'create_prd') {
      try {
        const prdAgent = await import('./prd/prd-agent.js')
        const { scanPendingReviewsByTaskId, runPrdReview } = prdAgent
        type ReviewProgressEvent = import('./prd/prd-agent.js').ReviewProgressEvent
        const prdIds = await scanPendingReviewsByTaskId(opts.context.taskId, runStartedAt)

        // 兜底：agent 用 Write/Edit 写了 docs/prds/*.md 但没触发 save_prd → 自动入库。
        // 只在 save_prd 完全没产出新 PRD 时启动，避免 agent 正常走 save_prd 后又写一份
        // 副本造成重复。
        // 会话已绑定 prdId（"继续对话"流）时走「更新绑定 PRD」分支；否则新建。
        if (prdIds.length === 0 && writtenPrdFiles.size > 0) {
          const { readFile } = await import('fs/promises')
          const { basename } = await import('path')
          const { createPrdDocument, updatePrdContent } = await import(
            '../db/repositories/prd-documents.js'
          )

          if (opts.prdId != null) {
            // 绑定分支：只认最后一个被写入的文件作为内容源，更新到绑定 PRD。
            const files = Array.from(writtenPrdFiles)
            const abs = files[files.length - 1]
            try {
              const content = await readFile(abs, 'utf8')
              const h1 = content.match(/^#\s+(.+?)\s*$/m)
              const title = h1 ? h1[1].trim() : undefined
              const updated = await updatePrdContent(opts.prdId, {
                contentMarkdown: content,
                ...(title ? { title } : {}),
                agentSessionId: opts.context.taskId,
              })
              if (updated) {
                prdIds.push(opts.prdId)
                console.warn(
                  `[Runner] streamWebChat salvaged UPDATE from ${abs} → PRD #${opts.prdId} (agent bypassed save_prd)`
                )
                yield {
                  type: 'review_progress',
                  reviewStage: 'salvaged',
                  prdId: opts.prdId,
                  reviewData: {
                    stage: 'salvaged',
                    prdId: opts.prdId,
                    filePath: abs,
                    mode: 'update',
                  },
                }
              }
            } catch (err) {
              console.error(`[Runner] streamWebChat salvage update failed for ${abs}:`, err)
            }
          } else {
            for (const abs of writtenPrdFiles) {
              try {
                const content = await readFile(abs, 'utf8')
                const h1 = content.match(/^#\s+(.+?)\s*$/m)
                const title = h1 ? h1[1].trim() : basename(abs, '.md')
                const prd = await createPrdDocument({
                  productLineId: opts.productLineId,
                  title,
                  contentMarkdown: content,
                  createdBy: opts.context.initiatorId,
                  groupId: opts.context.groupId,
                  platform: opts.context.platform,
                  agentSessionId: opts.context.taskId,
                })
                prdIds.push(prd.id)
                console.warn(
                  `[Runner] streamWebChat salvaged CREATE from ${abs} → PRD #${prd.id} (agent bypassed save_prd)`
                )
                yield {
                  type: 'review_progress',
                  reviewStage: 'salvaged',
                  prdId: prd.id,
                  reviewData: {
                    stage: 'salvaged',
                    prdId: prd.id,
                    filePath: abs,
                    mode: 'create',
                  },
                }
              } catch (err) {
                console.error(`[Runner] streamWebChat salvage failed for ${abs}:`, err)
              }
            }
          }
        }

        for (const id of prdIds) {
          const queue: ReviewProgressEvent[] = []
          let finished = false
          let notify: (() => void) | null = null
          const waitNext = () => new Promise<void>((resolve) => { notify = resolve })

          const reviewPromise = runPrdReview(id, {
            onProgress: (ev) => {
              queue.push(ev)
              if (notify) { const r = notify; notify = null; r() }
            },
          }).catch((err) => {
            queue.push({
              stage: 'review_error',
              prdId: id,
              error: err instanceof Error ? err.message : String(err),
            })
          }).finally(() => {
            finished = true
            if (notify) { const r = notify; notify = null; r() }
          })

          while (!finished || queue.length > 0) {
            while (queue.length > 0) {
              const ev = queue.shift()!
              yield {
                type: 'review_progress',
                reviewStage: ev.stage,
                prdId: ev.prdId,
                reviewData: ev,
              }
            }
            if (!finished) await waitNext()
          }
          await reviewPromise
        }
      } catch (err) {
        console.error('[Runner] streamWebChat post-run hook failed:', err)
      }
    }

    yield { type: 'done', sessionId: capturedSessionId }
  }
}

export interface WebChatEvent {
  type: 'stream_chunk' | 'assistant' | 'tool_use' | 'tool_result' | 'done' | 'error' | 'review_progress'
  text?: string
  turnComplete?: boolean
  toolName?: string
  input?: unknown
  output?: string
  toolUseId?: string
  sessionId?: string
  error?: string
  // review_progress 专用
  reviewStage?: string
  prdId?: number
  reviewData?: unknown
}
