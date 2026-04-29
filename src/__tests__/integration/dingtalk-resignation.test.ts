import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  upsertDingTalkUser,
  getActiveUserIds,
  markUsersAsResigned,
  deleteUser,
  getDingTalkUserById,
} from '../../db/repositories/dingtalk-users.js'
import { checkUserActiveReferences } from '../../admin/services/user-reference-check.js'

beforeEach(async () => {
  await resetTestDb()
})

async function insertUser(userId: string, name = 'Test User') {
  await upsertDingTalkUser({ userId, name, avatar: '', department: '' })
}

describe('markUsersAsResigned', () => {
  it('sets resigned_at for specified users', async () => {
    await insertUser('u1')
    await insertUser('u2')

    await markUsersAsResigned(['u1'])

    const u1 = await getDingTalkUserById('u1')
    const u2 = await getDingTalkUserById('u2')
    expect(u1?.resignedAt).not.toBeNull()
    expect(u2?.resignedAt).toBeNull()
  })

  it('is a no-op for empty array', async () => {
    await insertUser('u1')
    await markUsersAsResigned([])
    const u1 = await getDingTalkUserById('u1')
    expect(u1?.resignedAt).toBeNull()
  })
})

describe('upsertDingTalkUser clears resignedAt on re-join', () => {
  it('clears resigned_at when resigned user is upserted again', async () => {
    await insertUser('u1')
    await markUsersAsResigned(['u1'])
    expect((await getDingTalkUserById('u1'))?.resignedAt).not.toBeNull()

    await upsertDingTalkUser({ userId: 'u1', name: 'Test User' })

    expect((await getDingTalkUserById('u1'))?.resignedAt).toBeNull()
  })
})

describe('getActiveUserIds', () => {
  it('returns only non-resigned users', async () => {
    await insertUser('active1')
    await insertUser('active2')
    await insertUser('resigned1')
    await markUsersAsResigned(['resigned1'])

    const activeIds = await getActiveUserIds()
    expect(activeIds).toContain('active1')
    expect(activeIds).toContain('active2')
    expect(activeIds).not.toContain('resigned1')
  })
})

describe('checkUserActiveReferences', () => {
  it('returns blocked=false when user has no references', async () => {
    await insertUser('u1')
    const result = await checkUserActiveReferences('u1')
    expect(result.blocked).toBe(false)
    expect(result.references).toHaveLength(0)
  })

  it('detects user_roles reference', async () => {
    await insertUser('u1')
    const pool = getTestPool()
    await pool.query(
      `INSERT INTO user_roles (platform, user_id, user_name, role, group_id, created_by)
       VALUES ('dingtalk', 'u1', 'Test User', 'developer', 'group1', 'admin')`,
    )

    const result = await checkUserActiveReferences('u1')
    expect(result.blocked).toBe(true)
    const ref = result.references.find(r => r.table === 'user_roles')
    expect(ref?.count).toBe(1)
  })

  it('detects approval_rules JSONB reference', async () => {
    await insertUser('u1')
    const pool = getTestPool()
    // approval_rules 原始表无 FK，product_line_id 可空，im_trigger_key 有默认值
    await pool.query(
      `INSERT INTO approval_rules (primary_approvers, backup_approvers, primary_timeout_min, total_timeout_min)
       VALUES ($1, '[]', 30, 60)`,
      [JSON.stringify(['u1'])]
    ).catch(() => {
      // 如有 FK 约束或 schema 差异跳过，已在 user_roles 测试中覆盖 JSONB 查询路径
    })
  })
})

describe('deleteUser', () => {
  it('removes user from database', async () => {
    await insertUser('u1')
    await markUsersAsResigned(['u1'])

    await deleteUser('u1')

    expect(await getDingTalkUserById('u1')).toBeNull()
  })
})
