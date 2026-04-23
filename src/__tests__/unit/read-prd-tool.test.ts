import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/prd-documents.js', () => ({
  getPrdDocumentById: vi.fn(),
}))

import { getPrdDocumentById } from '../../db/repositories/prd-documents.js'
import { readPrdTool } from '../../agent/tools/read-prd.js'
import { RULES_VERSION } from '../../agent/prd/rules.js'
import type { TaskContext } from '../../agent/tools/types.js'
import type {
  PrdDocument,
  PrdReviewResult,
} from '../../db/repositories/prd-documents.js'
import type { StructuredPrd } from '../../agent/prd/structured-types.js'

const mockGet = vi.mocked(getPrdDocumentById)

interface ReadPrdData {
  prdId: number
  version: number
  status: string
  title: string
  contentMarkdown: string
  contentJson: Record<string, unknown>
  structuredPrd: StructuredPrd | null
  rulesVersion: string | null
  reviewResult: PrdReviewResult | null
  tags: string[]
}

const asData = (d: unknown): ReadPrdData => d as ReadPrdData

function ctx(): TaskContext {
  return {
    taskId: 't1',
    groupId: 'g1',
    platform: 'dingtalk',
    initiatorId: 'u1',
    initiatorRole: 'developer',
    productLineId: 100,
  } as TaskContext
}

function fakePrd(overrides: Partial<PrdDocument> = {}): PrdDocument {
  return {
    id: 42,
    productLineId: 100,
    title: '测试 PRD',
    version: 3,
    status: 'draft',
    contentMarkdown: '# 正文\n\n章节内容',
    contentJson: {},
    reviewResult: null,
    reviewHistory: [],
    createdBy: 'u1',
    groupId: 'g1',
    platform: 'dingtalk',
    agentSessionId: 'sess-1',
    tags: ['alpha'],
    metadata: {},
    createdAt: new Date('2026-04-20T00:00:00Z'),
    updatedAt: new Date('2026-04-22T12:00:00Z'),
    ...overrides,
  }
}

describe('readPrdTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('V1 PRD（无 structuredPrd）', () => {
    it('data.structuredPrd 与 rulesVersion 均为 null', async () => {
      mockGet.mockResolvedValue(fakePrd({ contentJson: {} }))
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(res.success).toBe(true)
      expect(asData(res.data).structuredPrd).toBeNull()
      expect(asData(res.data).rulesVersion).toBeNull()
    })

    it('output 包含 "PRD 版本标识: V1"', async () => {
      mockGet.mockResolvedValue(fakePrd({ contentJson: {} }))
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(res.output).toContain('PRD 版本标识: V1')
      expect(res.output).not.toContain('PRD 版本标识: V2')
    })

    it('contentJson 里存别的键但没有 structuredPrd → 仍为 V1', async () => {
      mockGet.mockResolvedValue(
        fakePrd({ contentJson: { phase: 'features', dialogueRounds: 3 } })
      )
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(asData(res.data).structuredPrd).toBeNull()
      expect(res.output).toContain('PRD 版本标识: V1')
    })
  })

  describe('V2 PRD（有 structuredPrd）', () => {
    const structured = {
      meta: { title: '测试', productLineId: 100 },
      goals: {
        vision: 'v',
        oneLineStatement: '一句话',
        objectives: [],
        successMetrics: [],
      },
      users: { primarySegment: 'u' },
      functionalRequirements: [],
      impacts: [],
      breakingChanges: [],
      scope: { inScope: [], outOfScope: [], tbd: [] },
    }

    it('data.structuredPrd 与 rulesVersion 回传', async () => {
      mockGet.mockResolvedValue(
        fakePrd({
          contentJson: {
            structuredPrd: structured,
            rulesVersion: RULES_VERSION,
          },
        })
      )
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(asData(res.data).structuredPrd).toEqual(structured)
      expect(asData(res.data).rulesVersion).toBe(RULES_VERSION)
    })

    it('output 包含 "PRD 版本标识: V2 (rules-v1)"', async () => {
      mockGet.mockResolvedValue(
        fakePrd({
          contentJson: {
            structuredPrd: structured,
            rulesVersion: RULES_VERSION,
          },
        })
      )
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(res.output).toContain(`PRD 版本标识: V2 (${RULES_VERSION})`)
    })

    it('rulesVersion 缺失也不崩，降级为纯 V2 标记', async () => {
      mockGet.mockResolvedValue(
        fakePrd({ contentJson: { structuredPrd: structured } })
      )
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(asData(res.data).rulesVersion).toBeNull()
      expect(res.output).toContain('PRD 版本标识: V2')
      expect(res.output).not.toMatch(/PRD 版本标识: V2 \(/)
    })

    it('structuredPrd 非 object（错配）时当作无结构化，走 V1 标识', async () => {
      mockGet.mockResolvedValue(
        fakePrd({ contentJson: { structuredPrd: 'not an object' } })
      )
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(asData(res.data).structuredPrd).toBeNull()
      expect(res.output).toContain('PRD 版本标识: V1')
    })
  })

  describe('review 结果 & 基本字段仍然正常', () => {
    it('reviewResult 存在时 output 追加自审报告段落', async () => {
      const review: PrdReviewResult = {
        status: 'passed',
        round: 2,
        findings: [],
        reviewedAt: '2026-04-22T00:00:00.000Z',
      }
      mockGet.mockResolvedValue(fakePrd({ reviewResult: review }))
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(res.output).toContain('最近一次自审结果')
      expect(res.output).toContain('"status": "passed"')
      expect(asData(res.data).reviewResult).toEqual(review)
    })

    it('标题 / version / status / 标签 正常回传', async () => {
      mockGet.mockResolvedValue(fakePrd())
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(asData(res.data).title).toBe('测试 PRD')
      expect(asData(res.data).version).toBe(3)
      expect(asData(res.data).status).toBe('draft')
      expect(asData(res.data).tags).toEqual(['alpha'])
      expect(res.output).toContain('# PRD #42「测试 PRD」')
      expect(res.output).toContain('- 版本: v3')
    })

    it('空 tags 渲染为「（无）」', async () => {
      mockGet.mockResolvedValue(fakePrd({ tags: [] }))
      const res = await readPrdTool.execute({ prdId: 42 }, ctx())
      expect(res.output).toContain('- 标签: （无）')
    })
  })

  describe('异常路径', () => {
    it('PRD 不存在 → success=false 且含友好提示', async () => {
      mockGet.mockResolvedValue(null)
      const res = await readPrdTool.execute({ prdId: 999 }, ctx())
      expect(res.success).toBe(false)
      expect(res.output).toContain('PRD #999 不存在')
    })

    it('repo 抛异常 → success=false 带原因', async () => {
      mockGet.mockRejectedValue(new Error('DB down'))
      const res = await readPrdTool.execute({ prdId: 1 }, ctx())
      expect(res.success).toBe(false)
      expect(res.output).toContain('读取 PRD 失败')
      expect(res.output).toContain('DB down')
    })
  })
})
