import { registerTool } from './index.js'
import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'
import type { ArtifactInput } from '../../pipeline/types.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

export const getPipelineArtifactInputsTool: AgentTool = {
  name: 'get_pipeline_artifact_inputs',
  description: '读取 pipeline 在触发前需要用户/调用方提供的制品输入需求。触发流水线前必须先调用，根据返回项引导用户选择。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: { pipelineId: { type: 'integer', description: '流水线 ID' } },
    required: ['pipelineId'],
  },

  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const p = (params ?? {}) as { pipelineId?: number }
    if (!p.pipelineId) return { success: false, output: '缺少必要参数 pipelineId' }

    const pipeline = await getTestPipelineById(p.pipelineId)
    if (!pipeline) return { success: false, output: `流水线 ${p.pipelineId} 不存在` }

    const inputs = (pipeline.artifactInputs ?? []) as ArtifactInput[]
    if (inputs.length === 0) {
      return { success: true, output: '该流水线无需制品输入，可直接触发。', data: { inputs: [] } }
    }

    const lines = inputs.map((i, idx) =>
      `${idx + 1}. **${i.name}** → var \`${i.outputVar}\`  glob: \`${i.glob}\`  仓库: \`${i.listUrl}\``,
    )
    return {
      success: true,
      output: `触发该流水线前需选择：\n\n${lines.join('\n')}\n\n对每项调用 \`list_artifacts(listUrl, glob)\` 列出候选，然后请用户选择。`,
      data: { inputs },
    }
  },
}

registerTool(getPipelineArtifactInputsTool)
