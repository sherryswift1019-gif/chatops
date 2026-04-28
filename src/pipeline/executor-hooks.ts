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
import { sshExec } from './ssh.js'
import { resolveVariables, type VariableContext } from './variables.js'
import { triggerCapability } from '../agent/coordinator.js'
import type { StageHooks } from './graph-builder.js'
import type {
  StageDefinition,
  StageContext,
  StageExecutionResult,
  ServerInfo,
} from './types.js'

/**
 * Resolve capability param templates to real values.
 *
 * 整值替换（whole-string 匹配）：保留原类型。
 *   - {{triggerParams.xxx}} → triggerParams[xxx]
 *   - {{vars.xxx}}          → runtimeVars[xxx]
 *
 * 嵌入式模板（非整值匹配）、未匹配的模板：保留字面字符串。
 *
 * Exported for unit testing.
 */
export function resolveCapabilityParams(
  params: Record<string, unknown> | undefined,
  triggerParams: Record<string, unknown> | undefined,
  runtimeVars: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return params
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      const triggerMatch = value.match(/^\{\{triggerParams\.(\w+)\}\}$/)
      if (triggerMatch) {
        resolved[key] =
          triggerParams && triggerMatch[1] in triggerParams
            ? triggerParams[triggerMatch[1]]
            : value
        continue
      }
      const varsMatch = value.match(/^\{\{vars\.(\w+)\}\}$/)
      if (varsMatch) {
        resolved[key] =
          runtimeVars && varsMatch[1] in runtimeVars
            ? runtimeVars[varsMatch[1]]
            : value
        continue
      }
      resolved[key] = value
    } else {
      resolved[key] = value
    }
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
      if (result.code !== 0) {
        failed = true
        failError = `exit code ${result.code} on ${server.host}`
      }
    } catch (err) {
      allLogs.push(`[error] ${String(err)}`)
      failed = true
      failError = String(err)
    }
  }

  await mkdir(dirname(logFile), { recursive: true }).catch(() => {})
  await writeFile(logFile, allLogs.join('\n') + '\n').catch(() => {})

  const output = allLogs.join('\n')
  if (failed) return { status: 'failed', output, error: failError }
  return { status: 'success', output }
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
        const failed = perServer.find((r) => r.status === 'failed')
        if (failed) return failed
        return {
          status: 'success',
          output: perServer.map((r) => r.output).join('\n'),
          artifacts: perServer.flatMap((r) => r.artifacts ?? []),
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
      try {
        const capabilityPromise = triggerCapability({
          capabilityKey,
          context: {
            taskId: `pipeline-${ctx.runId}-stage-${ctx.stageIndex}`,
            groupId: 'pipeline',
            platform: 'pipeline',
            initiatorId: 'pipeline-executor',
            initiatorRole: 'admin',
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
      }
    },
  }
}
