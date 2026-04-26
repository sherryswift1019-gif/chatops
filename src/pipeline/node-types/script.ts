import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { sshExec } from '../ssh.js'
import { resolveVariables, type VariableContext } from '../variables.js'

/**
 * Phase 3 script executor — 单 server 单次执行的标准 NodeExecutor。
 *
 * 执行模型：
 *   - 入参 params.script（或 params.commands）：要执行的命令字符串，支持 {{vars.xxx}} / {{server.xxx}} 等变量模板
 *   - ctx.server：目标服务器（host/port/username/password）—— 调度方负责 fan-out 多 role/parallel；本 executor 一次只跑一台
 *   - 不做 retry：retry 由 graph-runner 顶层 retry_when 表达式控制（spec §4.7）
 *
 * 与 graph-builder.ts:649 'script' switch case（buildScriptNode + executor-hooks.runScript）的关系：
 *   现有生产路径仍走 switch + hooks（多 server / parallel / retryCount 闭环；StageContext 富信息）。
 *   本 executor 是 fan_out 子运行 / 未来标准化 dispatch 的"标准单点入口"，
 *   待 T8 真正切换 dispatch 时与 switch 二选一。
 *
 * 返回 output 是结构化对象（exitCode / stdout / stderr），方便下游 steps 引用：
 *   `{{ steps.deploy.output.exitCode }}`。失败时 status='failed' 且 error 携带摘要。
 */
registerNodeType({
  key: 'script',
  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const rawScript = (params.script ?? params.commands) as string | undefined
    if (!rawScript || !rawScript.trim()) {
      return { status: 'success', output: { exitCode: 0, stdout: '', stderr: '', skipped: 'no script' } }
    }
    if (!ctx.server) {
      return {
        status: 'failed',
        output: { reason: 'no target server' },
        error: 'script executor requires ctx.server (host/username/password)',
      }
    }
    if (!ctx.server.password) {
      return {
        status: 'failed',
        output: { reason: 'missing credential' },
        error: 'script executor requires ctx.server.password (SSH credential)',
      }
    }

    // 变量解析：把 {{server.host}} / {{vars.x}} 展开。VariableContext 比 ExecutionContext
    // 信息略多（productLine / pipeline / run / stage），缺失字段以 ExecutionContext 现有
    // 数据兜底——standalone 调用方（如 fan_out 子图）无 stage 概念，传空串占位即可。
    const varCtx: VariableContext = {
      productLine: { name: '', displayName: '' },
      pipeline: { id: ctx.pipelineId, name: '' },
      run: { id: ctx.runId, triggeredBy: '', triggerType: '' },
      stage: { name: ctx.nodeId, index: 0 },
      server: {
        host: ctx.server.host,
        port: ctx.server.port,
        username: ctx.server.username,
        name: '',
        role: '',
      },
      vars: (ctx.vars ?? {}) as Record<string, string>,
    }
    const command = resolveVariables(rawScript, varCtx)

    try {
      const result = await sshExec(
        {
          host: ctx.server.host,
          port: ctx.server.port,
          username: ctx.server.username,
          password: ctx.server.password,
        },
        command,
      )
      const success = result.code === 0
      return {
        status: success ? 'success' : 'failed',
        output: { exitCode: result.code, stdout: result.stdout, stderr: result.stderr },
        ...(success ? {} : { error: `exit code ${result.code} on ${ctx.server.host}` }),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'failed',
        output: { exitCode: -1, stdout: '', stderr: msg },
        error: msg,
      }
    }
  },
})
