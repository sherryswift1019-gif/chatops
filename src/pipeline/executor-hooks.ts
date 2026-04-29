/**
 * executor-hooks — shared StageHooks factory used by executor.ts (initial
 * start) and graph-runner.ts (resume after restart or timeout).
 *
 * Keeping this in its own module avoids a circular import between executor
 * and graph-runner, and guarantees that both paths construct semantically
 * identical hooks.
 */

import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createPorygon } from '@snack-kit/porygon'
import { buildClaudeEnv } from '../agent/claude-config.js'
import { sshExec } from './ssh.js'
import { resolveVariables, resolvePath, type VariableContext } from './variables.js'
import { triggerCapability } from '../agent/coordinator.js'
import { DockerExecutor } from './executors/docker.js'
import type { StageHooks } from './graph-builder.js'
import type {
  StageDefinition,
  StageContext,
  StageExecutionResult,
  ServerInfo,
  ServerExecutionDetail,
} from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve capability param templates to real values.
 *
 * 整值替换（whole-string 匹配 `^{{...}}$`）：保留原类型。
 *   - 旧路径（保留向后兼容、单段 key）：
 *     - {{triggerParams.xxx}} → triggerParams[xxx]
 *     - {{vars.xxx}}          → runtimeVars[xxx]
 *   - 新路径（嵌套 / steps / scopes）：fallback 到 resolvePath，复用 script
 *     节点 resolveVariables 的 namespace 优先级（scopes > steps > vars >
 *     triggerParams）。例：{{steps.load.output.id}} / {{vars.config.host}}
 *     / {{triggerParams.user.name}}。
 *
 * 嵌入式模板（非整值匹配）、未匹配的模板：保留字面字符串。
 *
 * 双签名 overload（exported for unit testing + back-compat）：
 *   1. (params, triggerParams, runtimeVars) — 旧三参形态。内部合成最小
 *      VariableContext（仅 triggerParams + vars），不知道 steps/scopes，所以
 *      只能解析单段 key——这正是历史调用方期望的语义。
 *   2. (params, varCtx) — 新两参形态。让 buildCapabilityNode 把完整 ctx
 *      （含 steps/scopes/runtimeVars）一次性丢进来，支持 nested path。
 *
 * Idempotency: 已 resolve 过的结果再喂一遍仍是同一个值——展开后的字符串/数字/
 * 对象不再含 `{{...}}`，三段式都不命中，原样返回。
 */
export function resolveCapabilityParams(
  params: Record<string, unknown> | undefined,
  triggerParams: Record<string, unknown> | undefined,
  runtimeVars: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined
export function resolveCapabilityParams(
  params: Record<string, unknown> | undefined,
  varCtx: VariableContext,
): Record<string, unknown> | undefined
export function resolveCapabilityParams(
  params: Record<string, unknown> | undefined,
  arg2: Record<string, unknown> | VariableContext | undefined,
  runtimeVars?: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return params

  // 区分 overload：VariableContext 一定带 stage / pipeline / vars 这些固定 key，
  // 旧三参形态的 triggerParams 是松散 Record<string, unknown>。这里用 'stage' 做
  // 哨兵——同名 key 的概率几乎为零；即便撞名，旧 caller 历史上从未传带 stage
  // 字段的 triggerParams 给 resolveCapabilityParams（zero-callsite-grep）。
  const isVarCtx =
    arguments.length === 2 &&
    arg2 !== undefined &&
    typeof arg2 === 'object' &&
    'stage' in (arg2 as Record<string, unknown>) &&
    'vars' in (arg2 as Record<string, unknown>)

  let triggerParamsLocal: Record<string, unknown> | undefined
  let runtimeVarsLocal: Record<string, unknown> | undefined
  let varCtxForPath: Record<string, unknown>

  if (isVarCtx) {
    const ctx = arg2 as VariableContext
    triggerParamsLocal = ctx.triggerParams as Record<string, unknown> | undefined
    runtimeVarsLocal = ctx.vars as unknown as Record<string, unknown> | undefined
    varCtxForPath = ctx as unknown as Record<string, unknown>
  } else {
    triggerParamsLocal = arg2 as Record<string, unknown> | undefined
    runtimeVarsLocal = runtimeVars
    // 合成最小 ctx 给 resolvePath fallback 用——只有 triggerParams + vars 这两
    // 个 namespace 可见。steps/scopes 留空映射符合旧 caller 的承诺：旧三参
    // 形态本来就没法引用 steps。
    varCtxForPath = {
      triggerParams: triggerParamsLocal ?? {},
      vars: runtimeVarsLocal ?? {},
      steps: {},
      scopes: {},
    }
  }

  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') {
      resolved[key] = value
      continue
    }

    // 第一段：旧 fast path——单段 `^{{triggerParams.key}}$`（无 . / 无 [）。
    // 保留 triggerParams > vars 的旧排序（同名时仍优先 triggerParams），符合
    // 历史测试 `triggerParams takes precedence over vars`。
    const triggerMatch = value.match(/^\{\{triggerParams\.(\w+)\}\}$/)
    if (triggerMatch) {
      resolved[key] =
        triggerParamsLocal && triggerMatch[1] in triggerParamsLocal
          ? triggerParamsLocal[triggerMatch[1]]
          : value
      continue
    }
    const varsMatch = value.match(/^\{\{vars\.(\w+)\}\}$/)
    if (varsMatch) {
      resolved[key] =
        runtimeVarsLocal && varsMatch[1] in runtimeVarsLocal
          ? runtimeVarsLocal[varsMatch[1]]
          : value
      continue
    }

    // 第二段：fallback 到 resolvePath——支持 `^{{<nested.path[0]>}}$` 整值匹配。
    // 对应嵌套 key（如 {{steps.load.output.id}} / {{vars.config.host}}）。
    const wholeTemplateMatch = value.match(/^\{\{\s*([^}|]+?)\s*\}\}$/)
    if (wholeTemplateMatch) {
      const v = resolvePath(varCtxForPath, wholeTemplateMatch[1].trim())
      // 解析失败：保留 literal `{{...}}`，跟旧 fast path / resolveVariables 的
      // "未匹配保留字面"语义一致，方便排查模板配置错误。
      resolved[key] = v === undefined ? value : v
      continue
    }

    // 第三段：嵌入式模板——对 string 值走 resolveVariables 做嵌入式替换，
    // 与 script 节点（runScriptOnServers 中 resolveVariables(script, varCtx)）
    // 行为对齐。生产场景：capabilityParams 里 `cd /tmp && PAM_ADDRESS={{triggerParams.x}} ./run.sh`
    // 这种嵌入式必须能被替换，否则 LLM 收到的还是字面 `{{...}}`。
    //
    // 类型保留约束不破：integer/object/array 字面量在 line 106-109 已被透传，
    // 整值匹配的 `{{...}}` 在第一/二段保留原类型——只有"嵌入式 string"会到第三段，
    // resolveVariables 输出仍是 string。
    //
    // 未匹配模板由 resolveVariables 自身保留字面（variables.ts:91-102），与
    // 旧 fast path 的"未匹配保留 `{{...}}`"语义一致。
    resolved[key] = resolveVariables(value, varCtxForPath as unknown as VariableContext)
  }
  return resolved
}

/** Execute the script on one server, returning a StageExecutionResult. */
async function runScriptOnServers(
  stage: StageDefinition,
  ctx: StageContext,
  servers: ServerInfo[],
  logDir: string,
): Promise<StageExecutionResult> {
  const script = stage.script ?? ''
  if (!script.trim()) return { status: 'success', output: 'No script to execute' }

  const logFile = join(logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-script.log`)
  const allLogs: string[] = []
  const details: ServerExecutionDetail[] = []
  let failed = false
  let failError = ''

  for (const server of servers) {
    const varCtx: VariableContext = {
      productLine: ctx.productLine ?? { name: '', displayName: '' },
      pipeline: ctx.pipeline ?? { id: 0, name: '' },
      run: ctx.run ?? { id: ctx.runId, triggeredBy: '', triggerType: '' },
      stage: { name: stage.name, index: ctx.stageIndex },
      server: {
        host: server.host,
        port: server.port,
        username: server.username,
        name: '',
        role: server.role,
      },
      vars: ctx.variables ?? {},
      steps: ctx.stepOutputs ?? {},
      triggerParams: ctx.triggerParams ?? {},
    }
    const resolved = resolveVariables(script, varCtx)
    const sshCfg = {
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    }
    allLogs.push(`=== ${server.host} ===`)
    try {
      const result = await sshExec(sshCfg, resolved)
      if (result.stdout) allLogs.push(`[stdout]\n${result.stdout.trimEnd()}`)
      if (result.stderr) allLogs.push(`[stderr]\n${result.stderr.trimEnd()}`)
      allLogs.push(`[exit code] ${result.code}`)
      const success = result.code === 0
      details.push({
        host: server.host,
        port: server.port,
        role: server.role,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
        success,
      })
      if (!success) {
        failed = true
        failError = `exit code ${result.code} on ${server.host}`
      }
    } catch (err) {
      const errStr = String(err)
      allLogs.push(`[error] ${errStr}`)
      // SSH 抛错（timeout / connect refused / auth）时进程从未真的退出，
      // exitCode = -1 作为"未正常退出"哨兵，让下游用统一的 `exitCode !== 0`
      // 判定逻辑兜住。error 字段保留原始字符串供诊断。
      details.push({
        host: server.host,
        port: server.port,
        role: server.role,
        stdout: '',
        stderr: '',
        exitCode: -1,
        success: false,
        error: errStr,
      })
      failed = true
      failError = errStr
    }
  }

  await mkdir(dirname(logFile), { recursive: true }).catch(() => {})
  await writeFile(logFile, allLogs.join('\n') + '\n').catch(() => {})

  const output = allLogs.join('\n')
  if (failed) return { status: 'failed', output, error: failError, servers: details }
  return { status: 'success', output, servers: details }
}

/** Build the default runScript/runCapability hooks used by the real executor. */
export function buildDefaultHooks(logDir: string): StageHooks {
  return {
    async runScript(stage, ctx, targetServers): Promise<StageExecutionResult> {
      // Parallel: fan out one-server sub-calls and collapse results.
      if (stage.parallel && targetServers.length > 1) {
        const perServer = await Promise.all(
          targetServers.map((server) =>
            runScriptOnServers(stage, ctx, [server], logDir),
          ),
        )
        const mergedServers = perServer.flatMap((r) => r.servers ?? [])
        const failed = perServer.find((r) => r.status === 'failed')
        if (failed) {
          // Preserve the first-failed sub-call's status/output/error for
          // back-compat (string log + 'failed') but stitch the full per-server
          // detail array so downstream stepOutput sees every parallel branch.
          return { ...failed, servers: mergedServers }
        }
        return {
          status: 'success',
          output: perServer.map((r) => r.output).join('\n'),
          artifacts: perServer.flatMap((r) => r.artifacts ?? []),
          servers: mergedServers,
        }
      }

      // Sequential path with retry.
      let last: StageExecutionResult = { status: 'failed', output: 'Not executed' }
      for (let attempt = 0; attempt <= stage.retryCount; attempt++) {
        last = await runScriptOnServers(stage, ctx, targetServers, logDir)
        if (last.status === 'success') return last
      }
      return last
    },

    async runCapability(stage, ctx, triggerParams, runtimeVars): Promise<StageExecutionResult> {
      const capabilityKey = stage.capabilityKey
      if (!capabilityKey) {
        return { status: 'failed', output: '未配置 capabilityKey', error: 'no capabilityKey' }
      }
      const timeoutMs = (stage.timeoutSeconds ?? 1200) * 1000
      const resolvedParams = resolveCapabilityParams(
        stage.capabilityParams,
        triggerParams,
        runtimeVars,
      )

      const ctxBase = ctx as StageContext & { pipelineContainerImage?: string }
      const effectiveImage =
        stage.containerImage?.trim() || ctxBase.pipelineContainerImage?.trim()
      let dockerExecutor: DockerExecutor | undefined
      let dockerContainerName: string | undefined
      if (effectiveImage) {
        dockerContainerName = `chatops-cap-${ctx.runId}-${ctx.stageIndex}`
        dockerExecutor = new DockerExecutor(effectiveImage)
        const hostDataDir = process.env.HOST_TEST_DATA_DIR
        await dockerExecutor.setup(
          dockerContainerName,
          hostDataDir ? { dataDirMount: { hostPath: hostDataDir } } : {},
        )
      }

      try {
        const capabilityPromise = triggerCapability({
          capabilityKey,
          context: {
            taskId: `pipeline-${ctx.runId}-stage-${ctx.stageIndex}`,
            groupId: 'pipeline',
            platform: 'pipeline',
            initiatorId: 'pipeline-executor',
            initiatorRole: 'admin',
            ...(dockerContainerName ? { dockerContainerName } : {}),
          },
          extraParams: resolvedParams,
          // pipeline 内嵌 capability 节点：外层 test_runs 已记录，跳过 capability_invocations
          _suppressInvocationLog: true,
        })
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('capability 执行超时')), timeoutMs),
        )
        const result = await Promise.race([capabilityPromise, timeoutPromise])
        return {
          status: result.success ? 'success' : 'failed',
          output: result.output ?? '',
          error: result.error,
        }
      } catch (err) {
        return {
          status: 'failed',
          output: `capability 执行失败: ${String(err)}`,
          error: String(err),
        }
      } finally {
        if (dockerExecutor) {
          await dockerExecutor.teardown().catch((e) =>
            console.warn('[executor-hooks] runCapability container teardown failed:', e),
          )
        }
      }
    },

    async runCustomAgent(
      stage: StageDefinition,
      ctx: StageContext,
      triggerParams: Record<string, unknown> = {},
      runtimeVars: Record<string, unknown> = {},
    ): Promise<StageExecutionResult> {
      const rawPrompt = stage.customPrompt ?? ''
      if (!rawPrompt.trim()) {
        return { status: 'failed', output: '', error: 'customPrompt is empty' }
      }

      // 用 resolveVariables 展开嵌入式模板（如 {{triggerParams.branch}}）
      const coercedVars: Record<string, string> = {}
      for (const [k, v] of Object.entries(runtimeVars)) {
        coercedVars[k] = typeof v === 'string' ? v : JSON.stringify(v)
      }
      const varCtx: VariableContext = {
        productLine: ctx.productLine ?? { name: '', displayName: '' },
        pipeline: ctx.pipeline ?? { id: 0, name: '' },
        run: ctx.run ?? { id: ctx.runId, triggeredBy: '', triggerType: '' },
        stage: { name: stage.name, index: ctx.stageIndex },
        server: { host: '', port: 0, username: '', name: '', role: '' },
        vars: { ...(ctx.variables ?? {}), ...coercedVars },
        triggerParams,
      }
      const prompt = resolveVariables(rawPrompt, varCtx)

      // 容器生命周期
      const ctxBase = ctx as StageContext & { pipelineContainerImage?: string }
      const effectiveImage =
        stage.containerImage?.trim() || ctxBase.pipelineContainerImage?.trim()
      let dockerExecutor: DockerExecutor | undefined
      let dockerContainerName: string | undefined
      if (effectiveImage) {
        dockerContainerName = `chatops-cust-${ctx.runId}-${ctx.stageIndex}`
        dockerExecutor = new DockerExecutor(effectiveImage)
        const hostDataDir = process.env.HOST_TEST_DATA_DIR
        await dockerExecutor.setup(
          dockerContainerName,
          hostDataDir ? { dataDirMount: { hostPath: hostDataDir } } : {},
        )
      }

      // custom 模式：onlyTools 即使为空数组也比裸 disallowedTools 更严格——空白名单 = 禁所有工具
      // 包括 Bash/Read/Edit；这是 spec §2.3 的语义。
      const allowedTools =
        Array.isArray(stage.allowedTools) && stage.allowedTools.length > 0
          ? stage.allowedTools
          : []
      const timeoutMs = (stage.timeoutSeconds ?? 120) * 1000

      // 始终接入 chatops MCP server
      const mcpServerPath = join(__dirname, '..', 'agent', 'mcp-server.ts')
      const taskContext = {
        taskId: `pipeline-cust-${ctx.runId}-${ctx.stageIndex}`,
        groupId: 'pipeline',
        platform: 'pipeline',
        initiatorId: 'pipeline-executor',
        initiatorRole: 'admin' as const,
        cwd: ctx.logDir,
        ...(dockerContainerName ? { dockerContainerName } : {}),
      }

      const porygon = createPorygon({
        defaultBackend: 'claude',
        backends: {
          claude: {
            model: 'sonnet',
            interactive: false,
            cliPath: join(__dirname, '..', '..', 'node_modules', '.bin', 'claude'),
          },
        },
        defaults: { maxTurns: 10 },
      })

      const claudeEnv = await buildClaudeEnv()
      try {
        // porygon timeoutMs 是 idle timeout（无输出则超时），非 wall-clock 总时长
        const result = await porygon.run({
          prompt,
          timeoutMs,
          onlyTools: allowedTools,
          mcpServers: {
            chatops: {
              command: 'node',
              args: ['--import', 'tsx/esm', mcpServerPath],
              env: {
                ...(process.env as Record<string, string>),
                CHATOPS_TASK_CONTEXT: JSON.stringify(taskContext),
                DATABASE_URL: process.env.DATABASE_URL ?? '',
                ...claudeEnv,
              },
            },
          },
          envVars: {
            ...claudeEnv,
            CHATOPS_TASK_CONTEXT: JSON.stringify(taskContext),
          },
        })
        return { status: 'success', output: String(result).trim() }
      } catch (err) {
        return {
          status: 'failed',
          output: `custom agent 执行失败 [${stage.name}]: ${String(err)}`,
          error: String(err),
        }
      } finally {
        if (dockerExecutor) {
          await dockerExecutor.teardown().catch((e) =>
            console.warn('[executor-hooks] runCustomAgent container teardown failed:', e),
          )
        }
      }
    },
  }
}
