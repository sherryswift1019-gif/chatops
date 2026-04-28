import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import {
  createPipelineWebhook,
  listPipelineWebhooks,
  getPipelineWebhookByToken,
  updatePipelineWebhook,
  deletePipelineWebhook,
  rotatePipelineWebhookToken,
} from '../../db/repositories/pipeline-webhooks-repo.js'

async function insertTestPipeline(): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO test_pipelines (name, description, stages, enabled)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['webhook-test-pipeline', '', JSON.stringify([]), true],
  )
  return rows[0].id as number
}

describe('pipeline-webhooks-repo', () => {
  beforeEach(() => resetTestDb())

  it('create 返回完整 webhook（含完整 token）', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    expect(wh.id).toBeGreaterThan(0)
    expect(wh.token).toHaveLength(43)
    expect(wh.pipelineId).toBe(pipelineId)
    expect(wh.name).toBe('ci')
    expect(wh.enabled).toBe(true)
    expect(wh.triggerCount).toBe(0)
  })

  it('list 返回 masked token（前 8 字符 + 省略号）', async () => {
    const pipelineId = await insertTestPipeline()
    await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    const list = await listPipelineWebhooks(pipelineId)
    expect(list).toHaveLength(1)
    // 前 8 字符 + … (Unicode 省略号, 1 字符)
    expect(list[0].token).toHaveLength(9)
    expect(list[0].token.endsWith('…')).toBe(true)
  })

  it('getByToken 返回完整 webhook', async () => {
    const pipelineId = await insertTestPipeline()
    const created = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    const found = await getPipelineWebhookByToken(created.token)
    expect(found?.id).toBe(created.id)
    expect(found?.token).toBe(created.token)
  })

  it('getByToken 找不到时返回 null', async () => {
    expect(await getPipelineWebhookByToken('nonexistent-token-xxx')).toBeNull()
  })

  it('update 修改 name 和 enabled', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    const updated = await updatePipelineWebhook(wh.id, { name: 'new-ci', enabled: false })
    expect(updated?.name).toBe('new-ci')
    expect(updated?.enabled).toBe(false)
  })

  it('rotate 生成新 token 且旧 token 失效', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    const { newToken } = await rotatePipelineWebhookToken(wh.id)
    expect(newToken).not.toBe(wh.token)
    expect(newToken).toHaveLength(43)
    expect(await getPipelineWebhookByToken(wh.token)).toBeNull()
    expect(await getPipelineWebhookByToken(newToken)).not.toBeNull()
  })

  it('delete 后 getByToken 返回 null', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    await deletePipelineWebhook(wh.id)
    expect(await getPipelineWebhookByToken(wh.token)).toBeNull()
  })

  it('同 pipeline 重名时抛出 unique 错误', async () => {
    const pipelineId = await insertTestPipeline()
    await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    await expect(
      createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' }),
    ).rejects.toThrow()
  })
})
