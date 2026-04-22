import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver, Command } from '@langchain/langgraph'
import {
  buildGraphFromStages,
  type StageHooks,
  type BuildGraphInput,
} from '../../../pipeline/graph-builder.js'
import type {
  StageDefinition,
  StageExecutionResult,
  StageContext,
  ServerInfo,
} from '../../../pipeline/types.js'

function makeStage(
  partial: Partial<StageDefinition> & Pick<StageDefinition, 'name' | 'stageType'>,
): StageDefinition {
  return {
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    ...partial,
  }
}

function baseCtx(overrides: Partial<Omit<StageContext, 'stageIndex'>> = {}) {
  return {
    runId: 1,
    servers: {} as Record<string, ServerInfo[]>,
    logDir: '/tmp/chatops-runtime-vars-test',
    triggerPlatform: 'test',
    triggerGroupId: 'g1',
    ...overrides,
  }
}

function compile(input: BuildGraphInput) {
  const g = buildGraphFromStages(input)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (g as any).compile({ checkpointer: new MemorySaver() })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

describe('im_input → capability: runtimeVars 打通', () => {
  it('im_input 采集的 branch 通过 {{vars.branch}} 传到 capability hook', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 'collect',
        stageType: 'im_input',
        imInputConfig: {
          prompt: '请提供 branch',
          paramSchema: {
            type: 'object',
            required: ['branch'],
            properties: { branch: { type: 'string' } },
          },
          timeoutSeconds: 60,
        },
      }),
      makeStage({
        name: 'deploy',
        stageType: 'capability',
        capabilityKey: 'build',
        capabilityParams: { ref: '{{vars.branch}}' },
      }),
    ]

    const capturedParams: Array<Record<string, unknown> | undefined> = []
    const hooks: StageHooks = {
      async runScript() { return { status: 'success', output: '' } },
      async runCapability(_stage, _ctx, _trigger, runtimeVars) {
        const resolved = { ref: (runtimeVars as { branch?: string } | undefined)?.branch }
        capturedParams.push(resolved)
        return { status: 'success', output: JSON.stringify(resolved) }
      },
    }

    const graph = compile({ stages, stageContext: baseCtx(), hooks })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await graph.stream({ runId: 1 }, config))
    // resume im_input with user message providing branch=main
    await drain(await graph.stream(new Command({ resume: 'branch=main' }), config))

    const snap = await graph.getState(config)
    expect(snap.values.runtimeVars.branch).toBe('main')
    expect(snap.values.stageResults.at(-1).status).toBe('success')
  })
})
