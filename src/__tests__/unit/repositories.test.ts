import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { createTask, updateTaskStatus, getExecutingTask, getQueuedTasks } from '../../db/repositories/tasks.js'
import { upsertRole, getUserRole } from '../../db/repositories/roles.js'

beforeEach(async () => { await resetTestDb() })

describe('tasks repository', () => {
  it('creates task with queued status', async () => {
    const task = await createTask({
      groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1',
      intent: 'deploy payment-service'
    })
    expect(task.status).toBe('queued')
    expect(task.id).toBeTruthy()
  })

  it('updates task status to executing', async () => {
    const task = await createTask({
      groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', intent: 'test'
    })
    await updateTaskStatus(task.id, 'executing')
    const executing = await getExecutingTask('g1')
    expect(executing?.id).toBe(task.id)
  })

  it('returns null executing task when none active', async () => {
    const result = await getExecutingTask('no-such-group')
    expect(result).toBeNull()
  })
})

describe('roles repository', () => {
  it('upserts and retrieves user role', async () => {
    await upsertRole({
      platform: 'dingtalk', userId: 'u1', userName: '张三',
      role: 'ops', groupId: 'g1', createdBy: 'admin'
    })
    const role = await getUserRole('dingtalk', 'u1', 'g1')
    expect(role).toBe('ops')
  })

  it('returns null for unknown user', async () => {
    const role = await getUserRole('dingtalk', 'unknown', 'g1')
    expect(role).toBeNull()
  })
})
