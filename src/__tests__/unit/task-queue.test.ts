import { describe, it, expect, beforeEach } from 'vitest'
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
    // First task blocks
    const first = queue.submit({ initiatorId: 'u1', intent: 'task1' }, async () => {
      started.push('task1')
      await blocker
    })
    // Small yield to let first task start
    await new Promise(r => setTimeout(r, 10))

    let secondStarted = false
    const second = queue.submit({ initiatorId: 'u1', intent: 'task2' }, async () => {
      secondStarted = true
    })

    // Second hasn't started yet
    expect(secondStarted).toBe(false)

    // Unblock first
    release()
    await Promise.all([first, second])
    expect(secondStarted).toBe(true)
  })

  it('does NOT block new tasks when one is pending_approval', async () => {
    const queue = new TaskQueue('g1', 'dingtalk')
    const started: string[] = []

    // Submit task that goes to pending_approval immediately
    await queue.submit({ initiatorId: 'u1', intent: 'deploy prod' }, async (task) => {
      await queue.setPendingApproval(task.id)
      // Task is now pending_approval — executor returns
    })

    // New task should execute immediately
    await queue.submit({ initiatorId: 'u2', intent: 'list logs' }, async () => {
      started.push('task2')
    })
    expect(started).toContain('task2')
  })

  it('resumes approved task after current executing task finishes', async () => {
    const queue = new TaskQueue('g1', 'dingtalk')
    const order: string[] = []

    let release!: () => void
    const blocker = new Promise<void>(r => { release = r })

    // Task 1 executes and blocks
    const t1 = queue.submit({ initiatorId: 'u1', intent: 't1' }, async () => {
      order.push('t1-start')
      await blocker
      order.push('t1-end')
    })
    await new Promise(r => setTimeout(r, 10))

    // Task 2 goes to pending_approval immediately
    let task2Id!: string
    await queue.submit({ initiatorId: 'u1', intent: 't2' }, async (task) => {
      task2Id = task.id
      await queue.setPendingApproval(task.id)
    })
    await new Promise(r => setTimeout(r, 10))

    // Approve task 2 — should queue after task 1
    await queue.approve(task2Id, 'approver1')

    release()
    await t1

    // Wait for task 2 to execute
    await new Promise(r => setTimeout(r, 50))
    expect(order).toContain('t1-end')
  })
})
