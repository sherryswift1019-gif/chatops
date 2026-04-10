import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { GitLabWebhookReceiver } from '../../adapters/gitlab/webhook-receiver.js'
import { getFreshImages } from '../../db/repositories/image-cache.js'

beforeEach(async () => { await resetTestDb() })

describe('GitLabWebhookReceiver', () => {
  const receiver = new GitLabWebhookReceiver('test-secret')

  it('stores image cache on successful pipeline event', async () => {
    await receiver.handle({
      object_kind: 'pipeline',
      object_attributes: { status: 'success', id: 999 },
      project: { name: 'payment-service', path_with_namespace: 'myorg/payment-service' },
      builds: [{
        name: 'build',
        status: 'success',
        runner: {},
      }],
      commit: {
        id: 'abc123def',
        message: 'fix: payment timeout bug',
        timestamp: '2026-04-11T10:00:00Z',
      },
      variables: [{ key: 'IMAGE_TAG', value: 'v1.2.3' }],
    }, { 'x-gitlab-token': 'test-secret' })

    const images = await getFreshImages('payment-service', 5)
    expect(images.length).toBeGreaterThan(0)
    expect(images[0].commitSha).toBe('abc123def')
  })

  it('rejects requests with wrong token', async () => {
    await expect(
      receiver.handle({}, { 'x-gitlab-token': 'wrong' })
    ).rejects.toThrow('Invalid token')
  })
})
