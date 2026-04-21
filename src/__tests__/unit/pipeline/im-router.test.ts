import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerImWaiter,
  unregisterImWaiter,
  findRunExpectingInput,
  isGroupBusy,
  listWaiters,
} from '../../../pipeline/im-router.js'

describe('im-router', () => {
  beforeEach(() => {
    for (const w of listWaiters()) {
      unregisterImWaiter({ runId: w.runId, stageIndex: w.stageIndex })
    }
  })

  it('registers and finds a waiter by (platform, groupId)', () => {
    registerImWaiter({ runId: 1, stageIndex: 0, platform: 'dingtalk', groupId: 'g1' })
    expect(findRunExpectingInput('dingtalk', 'g1')).toEqual({ runId: 1, stageIndex: 0 })
    expect(findRunExpectingInput('dingtalk', 'g-other')).toBeNull()
    expect(findRunExpectingInput('feishu', 'g1')).toBeNull()
  })

  it('isGroupBusy returns true while a waiter is registered', () => {
    expect(isGroupBusy('dingtalk', 'g2')).toBe(false)
    registerImWaiter({ runId: 2, stageIndex: 0, platform: 'dingtalk', groupId: 'g2' })
    expect(isGroupBusy('dingtalk', 'g2')).toBe(true)
    unregisterImWaiter({ runId: 2, stageIndex: 0 })
    expect(isGroupBusy('dingtalk', 'g2')).toBe(false)
  })

  it('unregister removes only the matching waiter', () => {
    registerImWaiter({ runId: 1, stageIndex: 0, platform: 'dingtalk', groupId: 'g1' })
    registerImWaiter({ runId: 2, stageIndex: 0, platform: 'dingtalk', groupId: 'g2' })
    unregisterImWaiter({ runId: 1, stageIndex: 0 })
    expect(findRunExpectingInput('dingtalk', 'g1')).toBeNull()
    expect(findRunExpectingInput('dingtalk', 'g2')).toEqual({ runId: 2, stageIndex: 0 })
  })

  it('re-registering a group replaces the previous waiter', () => {
    registerImWaiter({ runId: 10, stageIndex: 0, platform: 'dingtalk', groupId: 'g3' })
    registerImWaiter({ runId: 20, stageIndex: 0, platform: 'dingtalk', groupId: 'g3' })
    expect(findRunExpectingInput('dingtalk', 'g3')).toEqual({ runId: 20, stageIndex: 0 })
    // 前一个 run 的 key 应当也被清掉，否则会留下孤儿映射
    expect(listWaiters().filter(w => w.runId === 10)).toEqual([])
  })

  it('same run can register different stage indices over time', () => {
    registerImWaiter({ runId: 5, stageIndex: 0, platform: 'feishu', groupId: 'g4' })
    unregisterImWaiter({ runId: 5, stageIndex: 0 })
    registerImWaiter({ runId: 5, stageIndex: 2, platform: 'feishu', groupId: 'g4' })
    expect(findRunExpectingInput('feishu', 'g4')).toEqual({ runId: 5, stageIndex: 2 })
  })
})
