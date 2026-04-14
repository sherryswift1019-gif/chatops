import { registerTool } from './index.js'
import { listTestPipelines, getTestPipelineById } from '../../db/repositories/test-pipelines.js'
import { listTestServers } from '../../db/repositories/test-servers.js'
import { getTestRunById } from '../../db/repositories/test-runs.js'
import { runPipeline } from '../../pipeline/executor.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

const autotestTool: AgentTool = {
  name: 'autotest',
  description: '自动化测试：查看流水线、触发执行、查看执行状态和测试报告。支持完整的环境部署+测试+报告流程。',
  riskLevel: 'high',
  requiredRole: 'tester',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '操作类型: list_pipelines(查看流水线) | list_servers(查看服务器) | trigger_run(触发执行) | get_status(查看状态) | get_report(获取报告链接)',
        enum: ['list_pipelines', 'list_servers', 'trigger_run', 'get_status', 'get_report'],
      },
      pipelineId: { type: 'number', description: '流水线ID (trigger_run 必填)' },
      productLineId: { type: 'number', description: '产线ID (list_pipelines/list_servers 可选)' },
      servers: {
        type: 'object',
        description: '服务器角色分配 (trigger_run 必填)，格式: {"db": ["192.168.1.10"], "app": ["192.168.1.11"]}',
      },
      runId: { type: 'number', description: '执行记录ID (get_status/get_report 必填)' },
    },
    required: ['action'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { action, pipelineId, productLineId, servers, runId } = params as {
      action: string; pipelineId?: number; productLineId?: number
      servers?: Record<string, string[]>; runId?: number
    }

    switch (action) {
      case 'list_pipelines': {
        const pipelines = await listTestPipelines(productLineId)
        if (pipelines.length === 0) return { success: true, output: '当前没有配置流水线。' }
        const list = pipelines.map(p =>
          `- [${p.id}] ${p.name}${p.description ? ` — ${p.description}` : ''}${p.schedule ? ` (定时: ${p.schedule})` : ''}${p.enabled ? '' : ' [已禁用]'}`
        ).join('\n')
        return { success: true, output: `流水线列表:\n${list}` }
      }

      case 'list_servers': {
        const svrs = await listTestServers(productLineId)
        if (svrs.length === 0) return { success: true, output: '当前没有配置服务器。' }
        const list = svrs.map(s =>
          `- [${s.id}] ${s.name} (${s.host}:${s.port}) 角色:${s.role} 状态:${s.status}`
        ).join('\n')
        return { success: true, output: `服务器列表:\n${list}` }
      }

      case 'trigger_run': {
        if (!pipelineId) return { success: false, output: '请指定 pipelineId' }
        try {
          // Auto-assign servers if not provided
          let serverMap = servers ?? {}
          if (Object.keys(serverMap).length === 0) {
            const pipeline = await getTestPipelineById(pipelineId)
            if (!pipeline) return { success: false, output: `流水线 ${pipelineId} 不存在` }
            const allServers = await listTestServers(pipeline.productLineId)
            for (const role of Object.keys(pipeline.serverRoles ?? {})) {
              const roleServers = allServers.filter(s => s.role === role && s.status === 'idle')
              if (roleServers.length > 0) {
                serverMap[role] = roleServers.map(s => s.host)
              }
            }
            if (Object.keys(serverMap).length === 0) {
              return { success: false, output: '没有可用的空闲服务器，无法自动分配' }
            }
          }
          const id = await runPipeline(pipelineId, serverMap, 'manual', ctx.initiatorId, (result) => {
            // Store completion result for later query - onComplete is fire-and-forget
            console.log(`[autotest] Pipeline ${pipelineId} run #${result.runId} completed: ${result.status} in ${result.durationMs}ms`)
          })
          const assignInfo = Object.entries(serverMap).map(([role, hosts]) => `  ${role}: ${(hosts as string[]).join(', ')}`).join('\n')
          return { success: true, output: `流水线已启动，执行ID: ${id}\n服务器分配:\n${assignInfo}\n\n流水线在后台执行中，使用 get_status 查看进度。` }
        } catch (err) {
          return { success: false, output: `启动失败: ${String(err)}` }
        }
      }

      case 'get_status': {
        if (!runId) return { success: false, output: '请指定 runId' }
        const run = await getTestRunById(runId)
        if (!run) return { success: false, output: `执行记录 ${runId} 不存在` }
        const stages = run.stageResults.map((s, i) => {
          const dur = s.durationMs ? ` (${s.durationMs < 1000 ? s.durationMs + 'ms' : (s.durationMs / 1000).toFixed(1) + 's'})` : ''
          const icon = s.status === 'success' ? 'OK' : s.status === 'failed' ? 'FAIL' : s.status === 'running' ? '...' : '-'
          return `  ${i + 1}. [${icon}] ${s.name}${dur}${s.error ? ' — ' + s.error : ''}`
        }).join('\n')
        return {
          success: true,
          output: `执行 #${run.id} 状态: ${run.status}\n阶段进度:\n${stages}${run.errorMessage ? `\n错误: ${run.errorMessage}` : ''}`,
        }
      }

      case 'get_report': {
        if (!runId) return { success: false, output: '请指定 runId' }
        const run = await getTestRunById(runId)
        if (!run) return { success: false, output: `执行记录 ${runId} 不存在` }
        if (run.status === 'running' || run.status === 'pending') {
          return { success: true, output: `执行 #${runId} 仍在进行中，报告尚未生成。` }
        }
        return { success: true, output: `测试报告:\n在线查看: /api/test-runs/${runId}/report\n下载数据包: /api/test-runs/${runId}/report/download` }
      }

      default:
        return { success: false, output: `未知操作: ${action}` }
    }
  },
}

registerTool(autotestTool)
export { autotestTool }
