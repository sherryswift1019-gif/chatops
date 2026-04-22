import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerImSender,
  notifyImGroup,
  hasImSender,
  __clearImSendersForTest,
} from '../../../pipeline/im-notifier.js'

describe('im-notifier', () => {
  beforeEach(() => {
    __clearImSendersForTest()
  })

  it('delivers the text via the registered sender', async () => {
    const calls: Array<{ groupId: string; text: string }> = []
    registerImSender('test', async (groupId, text) => { calls.push({ groupId, text }) })
    await notifyImGroup('test', 'g1', 'hello')
    expect(calls).toEqual([{ groupId: 'g1', text: 'hello' }])
  })

  it('silently warns when no sender is registered', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ })
    await notifyImGroup('unknown', 'g1', 'hi')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('swallows sender errors (never throws to caller)', async () => {
    registerImSender('crash', async () => { throw new Error('boom') })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => { /* swallow */ })
    await expect(notifyImGroup('crash', 'g1', 'x')).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('hasImSender reflects registration state', () => {
    expect(hasImSender('x')).toBe(false)
    registerImSender('x', async () => { /* noop */ })
    expect(hasImSender('x')).toBe(true)
  })
})
