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

  // phase 4 T3: extraMeta 透传 + 模板解析（fan_out 内调用 dm 时下游 db_update 节点用）
  it('phase4 T3: extraMeta 字段在 success output 中原样透传', async () => {
    registerImDmSender('dingtalk', async () => ({ messageId: 'm-99' }))
    const exec = loadDmExecutor()
    const result = await exec.execute(
      {
        platform: 'dingtalk',
        userId: 'u-owner',
        text: 'hello',
        extraMeta: {
          ownerId: 'u-owner',
          messageKind: 'fix_success',
          mrIids: [42, 43],
        },
      },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    const output = result.output as Record<string, unknown>
    expect(output.extraMeta).toEqual({
      ownerId: 'u-owner',
      messageKind: 'fix_success',
      mrIids: [42, 43],
    })
  })

  it('phase4 T3: 默认不带 extraMeta 时 output 不含该字段', async () => {
    registerImDmSender('dingtalk', async () => ({ messageId: 'm-1' }))
    const exec = loadDmExecutor()
    const result = await exec.execute(
      { platform: 'dingtalk', userId: 'u', text: 'hi' },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).extraMeta).toBeUndefined()
  })

  it('phase4 T3: dm 内部按 ctx.scopes 解析 {{owner.x}} 模板（fan_out body 用例）', async () => {
    const calls: Array<{ userId: string; text: string }> = []
    registerImDmSender('dingtalk', async (userId, text) => {
      calls.push({ userId, text })
      return { messageId: 'm-7' }
    })
    const exec = loadDmExecutor()
    const result = await exec.execute(
      {
        platform: 'dingtalk',
        userId: '{{owner.owner_id}}',
        text: '{{owner.message_text}}',
        extraMeta: {
          ownerId: '{{owner.owner_id}}',
          messageKind: '{{owner.scenario_kind}}',
        },
      },
      makeCtx({
        scopes: {
          owner: {
            owner_id: 'u-bob',
            message_text: '✅ MR ready',
            scenario_kind: 'fix_success',
          },
        },
      }),
    )
    expect(result.status).toBe('success')
    expect(calls).toEqual([{ userId: 'u-bob', text: '✅ MR ready' }])
    const output = result.output as Record<string, unknown>
    expect(output.extraMeta).toEqual({
      ownerId: 'u-bob',
      messageKind: 'fix_success',
    })
  })
})
