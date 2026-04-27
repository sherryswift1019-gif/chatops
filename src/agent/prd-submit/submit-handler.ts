/**
 * prd_submit — IM @agent 入口 handler（handler-path，不走 default_pipeline_id）。
 *
 * 触发来自 claude-runner.ts：
 *   intent.capability === 'prd_submit' + HANDLER_CAPABILITIES 白名单命中
 *   → coordinator.triggerCapability(...) → 本 handler
 *
 * 职责（PRD §3.1）：
 *   1. 两级解析 IM 指令（正则 → Claude fallback）
 *   2. 解析 GitLab URL（projectPath + branch；跨 repo 断言）
 *   3. 校验 MR 文件路径（/^docs\/prds\/.+\.md$/）
 *   4. 校验钉钉账号已 sync（dingtalk_users 行存在即可）
 *   5. 生成 submissionId
 *   6. 落 prd_submit_requested 事件
 *   7. 显式调 runPipeline(1776868085, {}, imTrigger({...triggerParams}))
 *
 * 身份方案（v29 起）：
 *   pipeline 跨 stage 透传 `imUserId`（钉钉 userId），与 notify_bug 用
 *   `projects.owner_id` 直接发 DM 同模式。不再绕 dingtalk_users.email。
 *
 * 返回值约定：
 *   - 用户侧问题（格式错/跨 repo/路径错/账号未 sync）→ `{success:true, output:用户友好文案}`
 *     这样 claude-runner 把文案作为群回复发出去；不算内部失败
 *   - pipeline 启动成功 → `{success:true, output:'PRD MR 提交中...'}`
 *   - 系统异常 → `{success:false, error}`
 */
import { randomUUID } from 'crypto'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import { createEvent } from '../../db/repositories/prd-submit-events.js'
import { getDingTalkUserById } from '../../db/repositories/dingtalk-users.js'
import { assertSameProject } from './url-parser.js'
import { getClaudeExecutor } from '../claude-executor.js'

interface ParsedCommand {
  workUrl: string
  mrUrl: string
  mrFile: string
  title: string | null
}

/**
 * Level 1 — 正则快速路径（标题可选）。
 * 抽 4 个字段以**任意顺序**出现；`标题=` 支持 ASCII 双引号和中文全角弯引号。
 * 返回 null 表示 workUrl/mrUrl/mrFile 至少一个未命中。
 */
function parseCommand(raw: string): ParsedCommand | null {
  // 抽单个字段，值到下一个空白为止
  const workMatch = raw.match(/工作地址=(\S+)/)
  const mrMatch = raw.match(/MR地址=(\S+)/)
  const fileMatch = raw.match(/MR文件=(\S+)/)
  // 引号支持三类：ASCII `"` (U+0022)、左弯 `“`、右弯 `”`；
  // 字符类里去重 ASCII `"` 其实冗余但无害；关键是 Unicode 引号必须显式写
  const titleMatch = raw.match(/标题=["“]([^"“”]+)["”]/)

  if (!workMatch || !mrMatch || !fileMatch) return null

  return {
    workUrl: workMatch[1],
    mrUrl: mrMatch[1],
    mrFile: fileMatch[1],
    title: titleMatch ? titleMatch[1].trim() : null,
  }
}

/**
 * Level 2 — Claude fallback（当 Level 1 正则失败时）。
 *
 * 策略：对 Claude 下达**严格约束**：
 *   - 只返回裸 JSON，不含代码块围栏
 *   - 如果消息里找不到必填字段，不准凭空编造 URL，而是回 {"error":...}
 *   - 20s 超时（entry path 预算内）
 *
 * 失败路径：任何 parse/校验失败均返回 null，由调用方回 USAGE_HINT。
 * 不让 Claude 的错误直接冒泡给用户，保留"格式示例提示"作最终降级。
 */
async function claudeFallbackParse(raw: string): Promise<ParsedCommand | null> {
  const prompt = `你是一个 IM 指令解析器。用户刚发了一条消息，从中提取 4 个字段：

- workUrl: GitLab 工作分支的 tree URL（形如 http://<host>/<group>/<repo>/-/tree/<branch>）
- mrUrl: GitLab 目标分支的 tree URL（同格式）
- mrFile: 仓库内相对文件路径（形如 docs/prds/xxx.md）
- title: 可选 MR 标题（没写就返回 null）

**只返回一段裸 JSON**，不含代码块围栏（无 \`\`\`），不含前后文字，不含 markdown：
{"workUrl":"...","mrUrl":"...","mrFile":"...","title":"..."|null}

如果消息里找不到明确的 workUrl / mrUrl / mrFile（**不要凭空编造 URL**），返回：
{"error":"missing_field","missing":"具体哪些字段缺"}

---

用户消息：
${raw}`

  try {
    const out = await getClaudeExecutor().run({
      prompt,
      allowedTools: '', // 禁所有工具，这是纯 NLP 任务
      timeoutMs: 20_000,
    })
    const trimmed = out.trim()
    // 允许两种格式：整段 JSON，或 `{ ... }` 子串
    let obj: Record<string, unknown> | null = null
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      const first = trimmed.indexOf('{')
      const last = trimmed.lastIndexOf('}')
      if (first >= 0 && last > first) {
        try {
          obj = JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>
        } catch {
          // ignore
        }
      }
    }

    if (!obj) {
      console.warn('[prd_submit] Claude fallback 未返回 JSON; raw len:', trimmed.length)
      return null
    }
    if (obj.error) {
      console.log('[prd_submit] Claude fallback 明确标 error:', obj.error, obj.missing ?? '')
      return null
    }
    if (
      typeof obj.workUrl !== 'string' ||
      typeof obj.mrUrl !== 'string' ||
      typeof obj.mrFile !== 'string'
    ) {
      console.warn('[prd_submit] Claude fallback 字段类型错', Object.keys(obj))
      return null
    }

    return {
      workUrl: obj.workUrl,
      mrUrl: obj.mrUrl,
      mrFile: obj.mrFile,
      title: typeof obj.title === 'string' ? obj.title.trim() : null,
    }
  } catch (err) {
    console.warn('[prd_submit] Claude fallback 抛错:', err instanceof Error ? err.message : String(err))
    return null
  }
}

const MR_FILE_RE = /^docs\/prds\/.+\.md$/

const USAGE_HINT = `格式不符，示例：
@agent 提交PRD MR
  工作地址=http://<host>/<group>/<repo>/-/tree/<source-branch>
  MR地址=http://<host>/<group>/<repo>/-/tree/<target-branch>
  MR文件=docs/prds/<slug>.md
  [标题="可选标题"]`

async function ensureDingTalkUserSynced(userId: string): Promise<boolean> {
  const u = await getDingTalkUserById(userId)
  return u !== null
}

function makeSubmissionId(slug: string): string {
  const nonce = randomUUID().split('-')[0].slice(0, 6)
  return `prd-mr-${slug}-${Date.now()}-${nonce}`
}

export async function handlePrdSubmit(opts: TriggerOptions): Promise<TriggerResult> {
  const rawMessage = (opts.extraParams?.message as string | undefined) ?? ''
  const userId = opts.context.initiatorId

  // Step 1: 两级解析指令
  //   Level 1 — 正则
  //   Level 2 — Claude fallback (只当 Level 1 完全 miss 时触发)
  let parsed = parseCommand(rawMessage)
  let parseStrategy: 'regex' | 'claude' | null = parsed ? 'regex' : null
  if (!parsed) {
    console.log('[prd_submit] 正则解析 miss，尝试 Claude fallback')
    parsed = await claudeFallbackParse(rawMessage)
    if (parsed) parseStrategy = 'claude'
  }
  if (!parsed) {
    return { success: true, output: USAGE_HINT }
  }

  // Step 2: URL 解析 + 跨 repo 断言
  let projectPath: string
  let sourceBranch: string
  let targetBranch: string
  try {
    const r = assertSameProject(parsed.workUrl, parsed.mrUrl)
    projectPath = r.projectPath
    sourceBranch = r.sourceBranch
    targetBranch = r.targetBranch
  } catch (err) {
    return { success: true, output: `❌ ${err instanceof Error ? err.message : String(err)}` }
  }

  // Step 3: MR 文件路径校验
  if (!MR_FILE_RE.test(parsed.mrFile)) {
    return {
      success: true,
      output: `❌ MR 文件必须在 docs/prds/ 路径下，且以 .md 结尾；实际: ${parsed.mrFile}`,
    }
  }

  // Step 4: 校验钉钉账号已同步（行存在即可，不再要求 email 列）
  const synced = await ensureDingTalkUserSynced(userId)
  if (!synced) {
    return {
      success: true,
      output: `❌ 未识别到你的钉钉账号，请联系管理员同步通讯录（钉钉 userId=${userId}）`,
    }
  }

  // Step 5: slug + submissionId
  const slug = parsed.mrFile.replace(/^docs\/prds\//, '').replace(/\.md$/, '')
  const submissionId = makeSubmissionId(slug)

  // Step 6: 落入口事件
  await createEvent({
    submissionId,
    projectPath,
    code: 'prd_submit_requested',
    status: 'success',
    data: {
      imUserId: userId,
      imPlatform: opts.context.platform,
      imGroupId: opts.context.groupId,
      sourceBranch,
      targetBranch,
      mrFilePath: parsed.mrFile,
      titleOverride: parsed.title,
      parseStrategy, // 'regex' | 'claude'，便于观察 Claude fallback 触发频率
      rawCommand: rawMessage.slice(0, 500), // 防止超长消息塞爆 JSONB
    },
  })

  // Step 7: 显式启动 pipeline（不设 default_pipeline_id，handler 内部显式触发）
  try {
    const { runPipeline, imTrigger } = await import('../../pipeline/executor.js')
    const runId = await runPipeline(
      1776868085,
      {}, // 无服务器分配
      imTrigger({
        triggeredBy: userId,
        platform: opts.context.platform,
        groupId: opts.context.groupId,
        userId,
        params: {
          submissionId,
          projectPath,
          sourceBranch,
          targetBranch,
          mrFilePath: parsed.mrFile,
          title: parsed.title, // null → stage 1 从 commit log 派生
          imUserId: userId,
        },
      }),
    )
    console.log(`[prd_submit] pipeline run #${runId} started for ${submissionId}`)

    return {
      success: true,
      output: `✅ 收到 PRD MR 提交请求（submissionId=${submissionId}），结果将通过 DM 单聊发送给你`,
      data: { runId, submissionId },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[prd_submit] 启动 pipeline 失败:`, msg)
    // 这里是系统异常（DB 连不上、pipeline id 不存在等），落入口事件已完成但后续流程未跑
    return { success: false, error: `启动 pipeline 失败: ${msg}` }
  }
}

export function registerPrdSubmitHandler(): void {
  registerCapabilityHandler('prd_submit', handlePrdSubmit)
  console.log('[prd_submit] handler registered')
}
