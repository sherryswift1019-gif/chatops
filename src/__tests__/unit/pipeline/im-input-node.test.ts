import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver, Command } from '@langchain/langgraph'
import {
  buildGraphFromStages,
  IM_INPUT_TIMEOUT_SENTINEL,
  IM_INPUT_CANCEL_SENTINEL,
  type StageHooks,
  type BuildGraphInput,
} from '../../../pipeline/graph-builder.js'
import type {
  StageDefinition,
  StageExecutionResult,
  ServerInfo,
  StageContext,
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
    runId: 42,
    servers: {} as Record<string, ServerInfo[]>,
    logDir: '/tmp/chatops-test',
    triggerPlatform: 'test',
    triggerGroupId: 'g-im-input',
    ...overrides,
  }
}

const noopHooks: StageHooks = {
  async runScript(): Promise<StageExecutionResult> {
    return { status: 'success', output: '' }
  },
  async runCapability(): Promise<StageExecutionResult> {
    return { status: 'success', output: '' }
  },
}

function compile(input: BuildGraphInput) {
  const g = buildGraphFromStages(input)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (g as any).compile({ checkpointer: new MemorySaver() })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

const paramSchema = {
  type: 'object',
  required: ['project', 'env', 'branch'],
  properties: {
    project: { type: 'string', title: '模块' },
    env:     { type: 'string', title: '环境', enum: ['dev', 'staging', 'prod'] },
    branch:  { type: 'string', title: '分支' },
  },
}

describe('buildImInputNode — single-turn completion', () => {
  it('single IM message with all params → stage success + params in runtimeVars', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 'collect',
        stageType: 'im_input',
        imInputConfig: {
          prompt: '请告诉我 project / env / branch',
          paramSchema,
          timeoutSeconds: 60,
        },
      }),
    ]
    const graph = compile({ stages, stageContext: baseCtx(), hooks: noopHooks })
    const config = { configurable: { thread_id: randomUUID() } }

    // 首次 invoke 进入 interrupt
    await drain(await graph.stream({ runId: 42 }, config))
    // resume 一条完整参数
    await drain(await graph.stream(
      new Command({ resume: 'project=demo env=dev branch=main' }),
      config,
    ))

    const snap = await graph.getState(config)
    const r = snap.values.stageResults[0] as { status: string; output: string }
    expect(r.status).toBe('success')
    expect(JSON.parse(r.output)).toEqual({ project: 'demo', env: 'dev', branch: 'main' })
    expect(snap.values.runtimeVars.project).toBe('demo')
    expect(snap.values.runtimeVars.env).toBe('dev')
    expect(snap.values.runtimeVars.branch).toBe('main')
  })
})

describe('buildImInputNode — multi-turn clarification', () => {
  it('incomplete messages loop through interrupt until all params arrive', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 'collect',
        stageType: 'im_input',
        imInputConfig: {
          prompt: '请告诉我 project / env / branch',
          paramSchema,
          timeoutSeconds: 60,
        },
      }),
    ]
    const graph = compile({ stages, stageContext: baseCtx(), hooks: noopHooks })
    const config = { configurable: { thread_id: randomUUID() } }

    await drain(await graph.stream({ runId: 42 }, config))
    // 第一轮：只给了 project
    await drain(await graph.stream(new Command({ resume: 'project=demo' }), config))
    // 仍在 interrupt（stage 未完成）
    let snap = await graph.getState(config)
    expect(snap.values.stageResults).toEqual([])

    // 第二轮：env 错
    await drain(await graph.stream(new Command({ resume: 'env=production' }), config))
    snap = await graph.getState(config)
    expect(snap.values.stageResults).toEqual([])

    // 第三轮：env 正确
    await drain(await graph.stream(new Command({ resume: 'env=dev' }), config))
    snap = await graph.getState(config)
    expect(snap.values.stageResults).toEqual([])

    // 第四轮：补 branch（单字段模式）
    await drain(await graph.stream(new Command({ resume: 'main' }), config))

    snap = await graph.getState(config)
    const r = snap.values.stageResults[0] as { status: string; output: string }
    expect(r.status).toBe('success')
    expect(JSON.parse(r.output)).toEqual({ project: 'demo', env: 'dev', branch: 'main' })
  })
})

describe('buildImInputNode — cancel and timeout', () => {
  it('user types "取消" → stage failed with user_cancelled', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 'collect',
        stageType: 'im_input',
        imInputConfig: { prompt: '参数？', paramSchema, timeoutSeconds: 60 },
      }),
    ]
    const graph = compile({ stages, stageContext: baseCtx(), hooks: noopHooks })
    const config = { configurable: { thread_id: randomUUID() } }

    await drain(await graph.stream({ runId: 42 }, config))
    await drain(await graph.stream(new Command({ resume: '取消' }), config))

    const snap = await graph.getState(config)
    const r = snap.values.stageResults[0] as { status: string; error?: string }
    expect(r.status).toBe('failed')
    expect(r.error).toBe('user_cancelled')
  })

  it('timeout sentinel → stage failed with im_input_timeout', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 'collect',
        stageType: 'im_input',
        imInputConfig: { prompt: '参数？', paramSchema, timeoutSeconds: 60 },
      }),
    ]
    const graph = compile({ stages, stageContext: baseCtx(), hooks: noopHooks })
    const config = { configurable: { thread_id: randomUUID() } }

    await drain(await graph.stream({ runId: 42 }, config))
    await drain(await graph.stream(
      new Command({ resume: IM_INPUT_TIMEOUT_SENTINEL }),
      config,
    ))

    const snap = await graph.getState(config)
    const r = snap.values.stageResults[0] as { status: string; error?: string }
    expect(r.status).toBe('failed')
    expect(r.error).toBe('im_input_timeout')
  })

  it('cancel sentinel → stage failed with im_input_cancelled', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 'collect',
        stageType: 'im_input',
        imInputConfig: { prompt: '参数？', paramSchema, timeoutSeconds: 60 },
      }),
    ]
    const graph = compile({ stages, stageContext: baseCtx(), hooks: noopHooks })
    const config = { configurable: { thread_id: randomUUID() } }

    await drain(await graph.stream({ runId: 42 }, config))
    await drain(await graph.stream(
      new Command({ resume: IM_INPUT_CANCEL_SENTINEL }),
      config,
    ))

    const snap = await graph.getState(config)
    const r = snap.values.stageResults[0] as { status: string; error?: string }
    expect(r.status).toBe('failed')
    expect(r.error).toBe('im_input_cancelled')
  })
})

describe('buildImInputNode — missing config', () => {
  it('stage without imInputConfig → failed immediately', async () => {
    const stages: StageDefinition[] = [
      makeStage({ name: 'bad', stageType: 'im_input' }),
    ]
    const graph = compile({ stages, stageContext: baseCtx(), hooks: noopHooks })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await graph.stream({ runId: 42 }, config))
    const snap = await graph.getState(config)
    const r = snap.values.stageResults[0] as { status: string; error?: string }
    expect(r.status).toBe('failed')
    expect(r.error).toBe('imInputConfig missing')
  })
})
