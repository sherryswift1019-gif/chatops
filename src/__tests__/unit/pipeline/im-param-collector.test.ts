import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findParamCollectWaiter } from '../../../pipeline/im-router.js'

vi.mock('../../../pipeline/im-notifier.js', () => ({
  notifyImGroup: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../pipeline/im-input-agent.js', () => ({
  consultImInputAgent: vi.fn(),
}))

import { collectImParams } from '../../../pipeline/im-param-collector.js'
import { notifyImGroup } from '../../../pipeline/im-notifier.js'
import { consultImInputAgent } from '../../../pipeline/im-input-agent.js'

const schema = {
  properties: { env: { title: '环境', enum: ['dev', 'prod'] } },
  required: ['env'],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('collectImParams', () => {
  it('单轮即收齐参数', async () => {
    vi.mocked(consultImInputAgent).mockResolvedValueOnce({ done: true, params: { env: 'prod' } })

    const promise = collectImParams('dingtalk', 'g1', schema)

    // waiter is registered before notifyImGroup is called
    const waiter = findParamCollectWaiter('dingtalk', 'g1')
    expect(waiter).not.toBeNull()
    waiter!.resolve('env=prod')

    const result = await promise
    expect(result).toEqual({ env: 'prod' })
    expect(notifyImGroup).toHaveBeenCalledOnce()
  })

  it('多轮采集：首次缺字段，第二轮补全', async () => {
    vi.mocked(consultImInputAgent)
      .mockResolvedValueOnce({ done: false, params: {}, nextPrompt: '请提供环境' })
      .mockResolvedValueOnce({ done: true, params: { env: 'dev' } })

    const promise = collectImParams('dingtalk', 'g1', schema)

    // first round
    const w1 = findParamCollectWaiter('dingtalk', 'g1')!
    w1.resolve('hello')

    // wait for async to advance to second round
    await new Promise(r => setTimeout(r, 0))

    // second round
    const w2 = findParamCollectWaiter('dingtalk', 'g1')!
    w2.resolve('env=dev')

    const result = await promise
    expect(result).toEqual({ env: 'dev' })
    expect(notifyImGroup).toHaveBeenCalledTimes(2)
  })

  it('用户取消时 reject', async () => {
    vi.mocked(consultImInputAgent).mockResolvedValueOnce({ done: false, aborted: true, params: {} })

    const promise = collectImParams('dingtalk', 'g1', schema)
    const waiter = findParamCollectWaiter('dingtalk', 'g1')!
    waiter.resolve('取消')

    await expect(promise).rejects.toThrow('用户取消')
  })

  it('超时时 reject', async () => {
    vi.useFakeTimers()
    try {
      const promise = collectImParams('dingtalk', 'g1', schema)
      // attach rejection handler immediately to avoid unhandledRejection warning
      const rejection = expect(promise).rejects.toThrow('超时')
      // don't resolve, let the timer fire
      await vi.advanceTimersByTimeAsync(300_001)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('使用自定义 imPrompt', async () => {
    vi.mocked(consultImInputAgent).mockResolvedValueOnce({ done: true, params: { env: 'prod' } })
    const promise = collectImParams('dingtalk', 'g1', schema, '请输入部署环境')
    findParamCollectWaiter('dingtalk', 'g1')!.resolve('prod')
    await promise
    expect(notifyImGroup).toHaveBeenCalledWith('dingtalk', 'g1', '请输入部署环境')
  })
})
