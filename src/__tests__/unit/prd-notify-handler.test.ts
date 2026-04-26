/**
 * Unit test: prd_notify handler 走 imUserId 直传 sendDirectMessage（不再反查 email），
 * 同时双发：DM + 群消息（imGroupId 来自入口事件 data.imGroupId）。
 *
 * 锁住 v29 + 群回复改造的核心契约：
 *   - capabilityParams.imUserId 必填，缺失返回 error
 *   - imUserId 直传 adapter.sendDirectMessage(imUserId, ...)，与 notify_bug 同模式
 *   - 入口事件有 imGroupId 时，同步调 adapter.sendMessage({type:'group',id}, ...)
 *   - 事件 data 写 imUserId / imGroupId / dm.ok / group.ok（不再写 authorEmail/userId）
 *   - 双通道任一成功即整体 success；都失败才 failed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TriggerOptions } from '../../agent/coordinator.js'

const hoisted = vi.hoisted(() => {
  const mkEvents = (entryData: Record<string, unknown>) => [
    {
      id: 1, submissionId: 'sub-1', projectPath: 'g/r', code: 'prd_submit_requested',
      status: 'success',
      data: { sourceBranch: 'feat', targetBranch: 'main', mrFilePath: 'docs/prds/x.md', ...entryData },
      createdAt: new Date(),
    },
    {
      id: 2, submissionId: 'sub-1', projectPath: 'g/r', code: 'prd_create_mr',
      status: 'success',
      data: { mrIid: 42, mrUrl: 'http://gl/r/-/mr/42' },
      createdAt: new Date(),
    },
    {
      id: 3, submissionId: 'sub-1', projectPath: 'g/r', code: 'prd_ai_review_mr',
      status: 'success',
      data: { decision: 'pass', findings: [], draftCleared: true },
      createdAt: new Date(),
    },
  ]
  return {
    mkEvents,
    mockCreateEvent: vi.fn(async (_input: unknown) => {}),
    mockFindBySubmission: vi.fn(async () => mkEvents({ imGroupId: 'group-abc' })),
    mockSendDM: vi.fn(async (_userId: string, _content: unknown) => {}),
    mockSendGroup: vi.fn(async (_target: unknown, _content: unknown) => {}),
    adaptersRef: {
      list: [] as Array<{
        sendDirectMessage: ReturnType<typeof vi.fn>
        sendMessage: ReturnType<typeof vi.fn>
      }>,
    },
  }
})

vi.mock('../../db/repositories/prd-submit-events.js', () => ({
  createEvent: hoisted.mockCreateEvent,
  findBySubmission: hoisted.mockFindBySubmission,
}))

vi.mock('../../pipeline/approval-manager.js', () => ({
  PipelineApprovalManager: {
    getInstance: () => ({
      get adapters() { return hoisted.adaptersRef.list },
    }),
  },
}))

vi.mock('../../agent/coordinator.js', () => ({
  registerCapabilityHandler: vi.fn(),
}))

import { handlePrdNotify } from '../../agent/prd-submit/notify-handler.js'

function makeOpts(extra: Record<string, unknown>): TriggerOptions {
  return {
    capabilityKey: 'prd_notify',
    context: {
      platform: 'dingtalk' as const,
      groupId: 'g-1',
      initiatorId: 'u-init',
      initiatorName: 'Init',
    },
    extraParams: extra,
  } as unknown as TriggerOptions
}

describe('prd_notify — imUserId 双发（DM + 群）', () => {
  beforeEach(() => {
    hoisted.mockCreateEvent.mockClear()
    hoisted.mockSendDM.mockClear()
    hoisted.mockSendGroup.mockClear()
    hoisted.adaptersRef.list = [{
      sendDirectMessage: hoisted.mockSendDM,
      sendMessage: hoisted.mockSendGroup,
    }]
    // 默认 fixture：入口事件带 imGroupId='group-abc'
    hoisted.mockFindBySubmission.mockImplementation(async () => hoisted.mkEvents({ imGroupId: 'group-abc' }))
  })

  it('happy: imGroupId 存在 → DM + 群双发，event data 含 imUserId/imGroupId/dm/group', async () => {
    const result = await handlePrdNotify(makeOpts({
      submissionId: 'sub-1',
      imUserId: '01254547121324350816',
    }))

    expect(result.success).toBe(true)
    expect(result.output).toMatch(/DM \+ group/)
    expect(result.output).toMatch(/imUserId=01254547121324350816/)

    // DM 第一参数 = imUserId
    expect(hoisted.mockSendDM).toHaveBeenCalledTimes(1)
    expect(hoisted.mockSendDM.mock.calls[0][0]).toBe('01254547121324350816')

    // 群发 target = { type: 'group', id: 'group-abc' }
    expect(hoisted.mockSendGroup).toHaveBeenCalledTimes(1)
    expect(hoisted.mockSendGroup.mock.calls[0][0]).toEqual({ type: 'group', id: 'group-abc' })

    const successCall = hoisted.mockCreateEvent.mock.calls.find(
      (c) => (c[0] as { status?: string }).status === 'success',
    )
    expect(successCall).toBeDefined()
    const data = (successCall![0] as { data: Record<string, unknown> }).data
    expect(data).toMatchObject({
      imUserId: '01254547121324350816',
      imGroupId: 'group-abc',
      messageKind: 'prd_submit_passed',
      dm: { ok: true },
      group: { ok: true },
    })
    expect(data).not.toHaveProperty('authorEmail')
  })

  it('入口事件无 imGroupId（admin 手动触发场景）→ 只发 DM，群跳过仍 success', async () => {
    hoisted.mockFindBySubmission.mockImplementationOnce(async () => hoisted.mkEvents({})) // 无 imGroupId

    const result = await handlePrdNotify(makeOpts({
      submissionId: 'sub-1',
      imUserId: 'u-z',
    }))

    expect(result.success).toBe(true)
    expect(result.output).toMatch(/DM/)
    expect(result.output).not.toMatch(/group/)
    expect(hoisted.mockSendDM).toHaveBeenCalledTimes(1)
    expect(hoisted.mockSendGroup).not.toHaveBeenCalled()

    const successCall = hoisted.mockCreateEvent.mock.calls.find(
      (c) => (c[0] as { status?: string }).status === 'success',
    )
    const data = (successCall![0] as { data: Record<string, unknown> }).data
    expect(data.imGroupId).toBeNull()
    expect(data.dm).toMatchObject({ ok: true })
    expect(data.group).toMatchObject({ ok: false, skipped: true })
  })

  it('DM 失败但群成功 → 整体 success（best-effort 双通道）', async () => {
    hoisted.mockSendDM.mockRejectedValueOnce(new Error('DM API down'))

    const result = await handlePrdNotify(makeOpts({
      submissionId: 'sub-1',
      imUserId: 'u-a',
    }))

    expect(result.success).toBe(true)
    expect(result.output).toMatch(/group/) // 群发出
    expect(result.output).not.toMatch(/DM \+ group/) // DM 没算进去

    const successCall = hoisted.mockCreateEvent.mock.calls.find(
      (c) => (c[0] as { status?: string }).status === 'success',
    )
    const data = (successCall![0] as { data: Record<string, unknown> }).data
    expect(data.dm).toMatchObject({ ok: false, error: expect.stringContaining('DM API down') })
    expect(data.group).toMatchObject({ ok: true })
  })

  it('DM + 群同时失败 → 整体 failed，事件落 dm.error + group.error', async () => {
    hoisted.mockSendDM.mockRejectedValueOnce(new Error('DM down'))
    hoisted.mockSendGroup.mockRejectedValueOnce(new Error('group webhook 500'))

    const result = await handlePrdNotify(makeOpts({
      submissionId: 'sub-1',
      imUserId: 'u-b',
    }))

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/DM down/)
    expect(result.error).toMatch(/group webhook 500/)

    const failCall = hoisted.mockCreateEvent.mock.calls.find(
      (c) => (c[0] as { status?: string }).status === 'failed',
    )
    const data = (failCall![0] as { data: Record<string, unknown> }).data
    expect(data.dm).toMatchObject({ ok: false, error: expect.stringContaining('DM down') })
    expect(data.group).toMatchObject({ ok: false, error: expect.stringContaining('group webhook') })
  })

  it('参数缺 imUserId → error，不发 DM 也不发群', async () => {
    const result = await handlePrdNotify(makeOpts({ submissionId: 'sub-1' }))

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/imUserId/)
    expect(hoisted.mockSendDM).not.toHaveBeenCalled()
    expect(hoisted.mockSendGroup).not.toHaveBeenCalled()
  })

  it('无 IM adapter（list 为空）→ failed 事件 data 写 imUserId', async () => {
    hoisted.adaptersRef.list = []

    const result = await handlePrdNotify(makeOpts({
      submissionId: 'sub-1',
      imUserId: 'u-c',
    }))

    expect(result.success).toBe(false)
    expect(result.error).toBe('no_adapter')

    const failCall = hoisted.mockCreateEvent.mock.calls.find(
      (c) => (c[0] as { status?: string }).status === 'failed',
    )
    const data = (failCall![0] as { data: Record<string, unknown> }).data
    expect(data.imUserId).toBe('u-c')
    expect(data.reason).toBe('no_adapter')
  })
})
