// src/e2e/pipeline-a/runner.ts
import { buildPipelineAGraph } from './graph.js'
import type { PipelineAStateType } from './types.js'

export interface PipelineAInput {
  targetProjectId: string
  specPaths?: string[]
  baseBranch?: string
}

export async function runPipelineA(input: PipelineAInput): Promise<void> {
  const graph = buildPipelineAGraph()
  const initialState: Partial<PipelineAStateType> = {
    targetProjectId: input.targetProjectId,
    specPaths: input.specPaths ?? [],
    baseBranch: input.baseBranch ?? 'main',
  }

  console.log(`[PipelineA] Starting for project=${input.targetProjectId}, specs=${input.specPaths?.length ?? 'all'}`)

  for await (const chunk of await graph.stream(initialState, { recursionLimit: 200 })) {
    const [nodeName] = Object.entries(chunk)[0]
    console.log(`[PipelineA] ${nodeName} completed`)
  }

  console.log('[PipelineA] Done')
}
