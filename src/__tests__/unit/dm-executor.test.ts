import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ExecutionContext } from '../../pipeline/node-types/types.js'

import '../../pipeline/node-types/dm.js'
import { getExecutor } from '../../pipeline/node-types/registry.js'
import {
  registerImDmSender,
  __clearImSendersForTest,
} from '../../pipeline/im-notifier.js'

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: 1,
    pipelineId: 100,
    nodeId: 'd1',
    triggerParams: {},
    vars: {},
    steps: {},
    ...overrides,
  }
}

function loadDmExecutor() {
  const exec = getExecutor('dm')
  if (!exec) throw new Error('dm executor not registered')
  return exec
}

describe('dm node executor (phase 3 T10)', () => {
  beforeEach(() => __clearImSendersForTest())
  afterEach(() => __clearImSendersForTest())

  it('happy: sends DM via registered platform sender', async () => {
    const calls: Array<{ userId: string; text: string }> = []
    registerImDmSender('dingtalk', async (userId, text) => {
      calls.push({ userId, text })
      return { messageId: 'm-42' }
    })
    const exec = loadDmExecutor()

    const result = await exec.execute(
      { platform: 'dingtalk', userId: 'u-1', text: 'hello' },
      makeCtx(),
    )

    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).messageId).toBe('m-42')
    expect(typeof (result.output as Record<string, unknown>).deliveredAt).toBe('string')
    expect(calls).toEqual([{ userId: 'u-1', text: 'hello' }])
  })

  it('failed when platform sender not registered', async () => {
    const exec = loadDmExecutor()
    const result = await exec.execute(
      { platform: 'feishu', userId: 'u-1', text: 'hi' },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/no DM sender/)
  })

  it('failed when adapter throws', async () => {
    registerImDmSender('dingtalk', async () => {
      throw new Error('feishu webhook 401')
    })
    const exec = loadDmExecutor()

    const result = await exec.execute(
      { platform: 'dingtalk', userId: 'u-1', text: 'hi' },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toBe('feishu webhook 401')
  })

  it('failed when params.platform missing', async () => {
    const exec = loadDmExecutor()
    const result = await exec.execute({ userId: 'u-1', text: 'x' }, makeCtx())
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/platform/)
  })

  it('failed when params.userId missing', async () => {
    const exec = loadDmExecutor()
    const result = await exec.execute(
      { platform: 'dingtalk', text: 'x' },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/userId/)
  })

  it('failed when params.text missing', async () => {
    registerImDmSender('dingtalk', async () => ({ messageId: 'x' }))
    const exec = loadDmExecutor()
    const result = await exec.execute(
      { platform: 'dingtalk', userId: 'u-1' },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/text/)
  })

  it('rejects card-only payload (v1 not supported)', async () => {
    registerImDmSender('dingtalk', async () => ({ messageId: 'x' }))
    const exec = loadDmExecutor()
    const result = await exec.execute(
      { platform: 'dingtalk', userId: 'u-1', card: { title: 't', body: 'b' } },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/card/)
  })
})
