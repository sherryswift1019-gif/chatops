import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { TaskQueue } from '../../agent/task-queue.js'

beforeEach(async () => { await resetTestDb() })

describe('TaskQueue', () => {
  it('executes task immediately when queue is empty', async () => {
    const executed: string[] = []
    const queue = new TaskQueue('g1', 'dingtalk')
    await queue.submit({ initiatorId: 'u1', intent: 'list images' }, async (task) => {
      executed.push(task.id)
    })
    expect(executed).toHaveLength(1)
  })

  it('queues second task while first is executing', async () => {
    const queue = new TaskQueue('g1', 'dingtalk')
    let release!: () => void
    const blocker = new Promise<void>(r => { release = r })

    const started: string[] = []
    const first = queue.submit({ initiatorId: 'u1', intent: 'task1' }, async () => {
      started.push('task1')
      await blocker
    })

    await vi.waitFor(() => {
      expect(started).toContain('task1')
    }, { timeout: 2000 })

    let secondStarted = false
    const second = queue.submit({ initiatorId: 'u1', intent: 'task2' }, async () => {
      secondStarted = true
    })

    expect(secondStarted).toBe(false)

    release()
    await Promise.all([first, second])
    expect(secondStarted).toBe(true)
  })

  it('does NOT block new tasks when one is pending_approval', async () => {
    const queue = new TaskQueue('g1', 'dingtalk')
    const started: string[] = []

    await queue.submit({ initiatorId: 'u1', intent: 'deploy prod' }, async (task) => {
      await queue.setPendingApproval(task.id)
    })

    await queue.submit({ initiatorId: 'u2', intent: 'list logs' }, async () => {
      started.push('task2')
    })
    expect(started).toContain('task2')
  })

  it('resumes approved task after current executing task finishes', async () => {
    const queue = new TaskQueue('g1', 'dingtalk')
    const order: string[] = []

    // Task that goes to pending_approval immediately
    let task1Id!: string
    await queue.submit({ initiatorId: 'u1', intent: 't1' }, async (task) => {
      task1Id = task.id
      order.push('t1-pending')
      await queue.setPendingApproval(task.id)
    })

    // Task1 is now pending_approval, queue is free
    // Submit and execute task2 normally
    await queue.submit({ initiatorId: 'u1', intent: 't2' }, async () => {
      order.push('t2-done')
    })

    expect(order).toContain('t1-pending')
    expect(order).toContain('t2-done')
    expect(task1Id).toBeTruthy()
  })
})
