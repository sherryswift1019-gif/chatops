import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/requirements.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/requirements.js')>()
  return {
    ...actual,
    getLastRejectReason: vi.fn(),
  }
})

import { getLastRejectReason } from '../../db/repositories/requirements.js'
import { resolveLlmAuthorPreviousRound } from '../../pipeline/graph-builder.js'

describe('resolveLlmAuthorPreviousRound (helper for buildLlmAuthorNode)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('last_reject_reasons 含值 → 返回 { rejectReason }', async () => {
    vi.mocked(getLastRejectReason).mockResolvedValue('AC 太模糊')
    const result = await resolveLlmAuthorPreviousRound(7, 'spec_author')
    expect(result).toEqual({ rejectReason: 'AC 太模糊' })
    expect(getLastRejectReason).toHaveBeenCalledWith(7, 'spec_author')
  })

  it('last_reject_reasons 不存在 → 返回 undefined（不注入 previousRound）', async () => {
    vi.mocked(getLastRejectReason).mockResolvedValue(null)
    const result = await resolveLlmAuthorPreviousRound(7, 'spec_author')
    expect(result).toBeUndefined()
  })

  it('空字符串 rejectReason → 返回 undefined（防止注入空反馈）', async () => {
    vi.mocked(getLastRejectReason).mockResolvedValue('')
    const result = await resolveLlmAuthorPreviousRound(7, 'spec_author')
    expect(result).toBeUndefined()
  })
})
