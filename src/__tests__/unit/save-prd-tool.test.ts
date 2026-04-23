import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/prd-documents.js', () => ({
  createPrdDocument: vi.fn(),
  getPrdDocumentById: vi.fn(),
  updatePrdContent: vi.fn(),
  mergePrdMetrics: vi.fn(),
}))

import {
  createPrdDocument,
  getPrdDocumentById,
  updatePrdContent,
  mergePrdMetrics,
} from '../../db/repositories/prd-documents.js'
import { savePrdTool } from '../../agent/tools/save-prd.js'
import { RULES_VERSION } from '../../agent/prd/rules.js'
import type { TaskContext } from '../../agent/tools/types.js'
import type { StructuredPrd } from '../../agent/prd/structured-types.js'

const mockCreate = vi.mocked(createPrdDocument)
const mockGet = vi.mocked(getPrdDocumentById)
const mockUpdate = vi.mocked(updatePrdContent)
const mockMergeMetrics = vi.mocked(mergePrdMetrics)

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: 'task-1',
    groupId: 'g1',
    platform: 'dingtalk',
    initiatorId: 'user-1',
    initiatorRole: 'developer',
    productLineId: 100,
    ...overrides,
  } as TaskContext
}

function minimalValidPrd(): StructuredPrd {
  return {
    meta: { title: '订单极简下单', productLineId: 100 },
    goals: {
      vision: '让 C 端下单更快。',
      oneLineStatement: '订单极简下单',
      objectives: ['提升转化率'],
      successMetrics: [{ metric: '下单转化', target: '≥ 85%', measurement: '周度看板' }],
    },
    users: { primarySegment: '零售 C 端用户' },
    functionalRequirements: [
      {
        id: '3.1',
        name: '一键下单',
        priority: 'P0',
        description: '已登录用户在商品页点击后即下单。',
        source: { phase: 2, quote: '就要那种一键的', type: 'user_said' },
        acceptanceCriteria: [
          { text: '耗时 P99 < 500ms' },
          { text: '成功率 ≥ 99.9%' },
        ],
      },
    ],
    impacts: [
      {
        module: 'auth',
        type: '行为复用',
        compatibility: '完全兼容',
        description: '复用 verifyToken',
        source: 'Phase 2',
      },
    ],
    breakingChanges: [],
    scope: {
      inScope: ['一键下单'],
      outOfScope: [{ item: '货到付款', reason: '一期不做' }],
      tbd: [],
    },
  }
}

function mockCreatedRow(over: Partial<{ id: number; version: number; title: string }> = {}) {
  return {
    id: over.id ?? 42,
    productLineId: 100,
    title: over.title ?? '订单极简下单',
    version: over.version ?? 1,
    status: 'drafting' as const,
    contentMarkdown: '',
    contentJson: {},
    reviewResult: null,
    reviewHistory: [],
    createdBy: 'user-1',
    groupId: 'g1',
    platform: 'dingtalk',
    agentSessionId: 'task-1',
    tags: [],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

beforeEach(() => {
  mockCreate.mockReset()
  mockGet.mockReset()
  mockUpdate.mockReset()
  mockMergeMetrics.mockReset()
  mockMergeMetrics.mockResolvedValue(undefined)
})

// =============================================================================
// V2 结构化路径：happy path
// =============================================================================

describe('save_prd V2 结构化路径', () => {
  it('合法 structured 入参 → 机械校验通过 + renderer 产出 + 入库', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow())
    const res = await savePrdTool.execute({ structured: minimalValidPrd() }, ctx())

    expect(res.success).toBe(true)
    expect(res.output).toContain('PRD #42')
    expect(res.output).toContain('v1')
    expect(res.output).toContain(RULES_VERSION)

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const arg = mockCreate.mock.calls[0][0]
    // renderer 产出的 markdown 应至少包含结构化数据中的关键字
    expect(arg.contentMarkdown).toContain('# 订单极简下单')
    expect(arg.contentMarkdown).toContain('3.1 一键下单')
    expect(arg.contentMarkdown).toContain('耗时 P99 < 500ms')
    // contentJson 含 structuredPrd + rulesVersion
    expect(arg.contentJson).toBeDefined()
    expect((arg.contentJson as Record<string, unknown>).structuredPrd).toBeDefined()
    expect((arg.contentJson as Record<string, unknown>).rulesVersion).toBe(RULES_VERSION)
    // data.mode 标记
    expect((res.data as { mode: string }).mode).toBe('structured')
  })

  it('structured 路径 title 来源优先级：显式 title > structured.meta.title', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow({ title: 'CUSTOM' }))
    await savePrdTool.execute(
      { structured: minimalValidPrd(), title: 'CUSTOM' },
      ctx()
    )
    expect(mockCreate.mock.calls[0][0].title).toBe('CUSTOM')
  })

  it('structured 路径未传 title → 取 structured.meta.title', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow())
    await savePrdTool.execute({ structured: minimalValidPrd() }, ctx())
    expect(mockCreate.mock.calls[0][0].title).toBe('订单极简下单')
  })

  it('structured 路径更新已存在 PRD → 合并 contentJson，不丢失旧字段', async () => {
    const existing = mockCreatedRow({ id: 7, version: 2 })
    existing.contentJson = { phase: 3, dialogueRounds: 5, existingField: 'keep' }
    mockGet.mockResolvedValue(existing)
    mockUpdate.mockResolvedValue({ ...existing, version: 3 })

    const res = await savePrdTool.execute(
      { prdId: 7, structured: minimalValidPrd() },
      ctx()
    )

    expect(res.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    const updateArg = mockUpdate.mock.calls[0][1]
    const cj = updateArg.contentJson as Record<string, unknown>
    expect(cj.phase).toBe(3) // 保留
    expect(cj.dialogueRounds).toBe(5) // 保留
    expect(cj.existingField).toBe('keep') // 保留
    expect(cj.structuredPrd).toBeDefined() // 新写
    expect(cj.rulesVersion).toBe(RULES_VERSION) // 新写
  })
})

// =============================================================================
// V2 结构化路径：机械校验拦截（iteration doc §10 #2/#3/#4）
// =============================================================================

describe('save_prd V2 机械校验拦截', () => {
  it('#2 source 缺失 → 拒绝保存，errors 返回', async () => {
    const prd = minimalValidPrd()
    // @ts-expect-error 故意构造错误数据
    delete prd.functionalRequirements[0].source
    const res = await savePrdTool.execute({ structured: prd }, ctx())

    expect(res.success).toBe(false)
    expect(res.output).toContain('机械校验未通过')
    expect(res.output).toContain('source_traceable')
    expect(mockCreate).not.toHaveBeenCalled()
    const errors = (res.data as { mechanicalErrors: Array<{ ruleId: string }> }).mechanicalErrors
    expect(errors.some((e) => e.ruleId === 'source_traceable')).toBe(true)
  })

  it('#3 impacts.type 不在枚举 → 拒绝保存', async () => {
    const prd = minimalValidPrd()
    // @ts-expect-error 故意注入非法枚举值
    prd.impacts[0].type = '可能变化'
    const res = await savePrdTool.execute({ structured: prd }, ctx())

    expect(res.success).toBe(false)
    expect(res.output).toContain('impact_enum')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('#4 action 5W 不全 → 拒绝保存（closed_loop）', async () => {
    const prd = minimalValidPrd()
    prd.functionalRequirements[0].actions = [
      {
        verb: '提交订单',
        trigger: '用户点击按钮',
        stateChange: 'draft → pending',
        notify: '',
        nextActor: '',
        terminalState: '',
      },
    ]
    const res = await savePrdTool.execute({ structured: prd }, ctx())

    expect(res.success).toBe(false)
    expect(res.output).toContain('closed_loop')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('破坏性变更无迁移 → breaking_change_detail 拦截', async () => {
    const prd = minimalValidPrd()
    prd.impacts.push({
      module: 'order-api',
      type: '接口变更',
      compatibility: '破坏性变更',
      description: '新增字段',
      source: 'Phase 3',
    })
    // 故意不加 breakingChanges
    const res = await savePrdTool.execute({ structured: prd }, ctx())

    expect(res.success).toBe(false)
    expect(res.output).toContain('breaking_change_detail')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('聚合多个 rule 的错误一并返回', async () => {
    const prd = minimalValidPrd()
    // @ts-expect-error
    delete prd.functionalRequirements[0].source // source_traceable
    // @ts-expect-error
    prd.impacts[0].type = '可能变化' // impact_enum
    const res = await savePrdTool.execute({ structured: prd }, ctx())

    expect(res.success).toBe(false)
    const errors = (res.data as { mechanicalErrors: Array<{ ruleId: string }> }).mechanicalErrors
    const ids = new Set(errors.map((e) => e.ruleId))
    expect(ids.has('source_traceable')).toBe(true)
    expect(ids.has('impact_enum')).toBe(true)
  })
})

// =============================================================================
// V1 markdown 路径（iteration doc §10 #6 兼容写）
// =============================================================================

describe('save_prd V1 markdown 兼容路径', () => {
  it('#6 传 contentMarkdown → 直接入库，不跑机械校验', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow({ title: 'V1 PRD' }))
    const md = '# V1 PRD\n\n## 1. 目标\n...'
    const res = await savePrdTool.execute({ contentMarkdown: md, title: 'V1 PRD' }, ctx())

    expect(res.success).toBe(true)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const arg = mockCreate.mock.calls[0][0]
    expect(arg.contentMarkdown).toBe(md)
    // V1 path: contentJson 不含 structuredPrd
    expect(arg.contentJson).toBeUndefined()
    // data.mode 标记
    expect((res.data as { mode: string }).mode).toBe('markdown')
    // 输出不含 rules version 标签
    expect(res.output).not.toContain(RULES_VERSION)
  })

  it('V1 传参别名 `content` / `markdown` 仍走 V1 路径', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow({ title: 'Alias PRD' }))
    const res = await savePrdTool.execute(
      { content: '# Alias PRD\n\n正文', title: 'Alias PRD' },
      ctx()
    )
    expect(res.success).toBe(true)
    expect(mockCreate.mock.calls[0][0].contentMarkdown).toContain('Alias PRD')
  })

  it('V1 路径未传 title 则从 H1 提取', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow({ title: 'From H1' }))
    await savePrdTool.execute({ contentMarkdown: '# From H1\n\n正文' }, ctx())
    expect(mockCreate.mock.calls[0][0].title).toBe('From H1')
  })

  it('structured 与 contentMarkdown 同时传 → structured 胜出（走 V2 路径）', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow())
    const res = await savePrdTool.execute(
      {
        structured: minimalValidPrd(),
        contentMarkdown: '# 这个 markdown 会被忽略',
      },
      ctx()
    )
    expect(res.success).toBe(true)
    expect((res.data as { mode: string }).mode).toBe('structured')
    // renderer 产出覆盖，而不是原始 markdown
    expect(mockCreate.mock.calls[0][0].contentMarkdown).not.toContain('这个 markdown 会被忽略')
  })
})

// =============================================================================
// 错误分支
// =============================================================================

describe('save_prd 错误分支', () => {
  it('空入参 → 友好提示', async () => {
    const res = await savePrdTool.execute({}, ctx())
    expect(res.success).toBe(false)
    expect(res.output).toContain('PRD 正文')
  })

  it('无 productLineId 且 prdId 为空 → 拒绝', async () => {
    const res = await savePrdTool.execute(
      { structured: minimalValidPrd() },
      ctx({ productLineId: undefined })
    )
    expect(res.success).toBe(false)
    expect(res.output).toContain('产品线')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('prdId 不存在 → 拒绝', async () => {
    mockGet.mockResolvedValue(null)
    const res = await savePrdTool.execute(
      { prdId: 999, structured: minimalValidPrd() },
      ctx()
    )
    expect(res.success).toBe(false)
    expect(res.output).toContain('999')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('DB 抛异常 → 捕获并友好返回', async () => {
    mockCreate.mockRejectedValue(new Error('连接断开'))
    const res = await savePrdTool.execute({ structured: minimalValidPrd() }, ctx())
    expect(res.success).toBe(false)
    expect(res.output).toContain('连接断开')
  })

  it('updatePrdContent 返回 null → 拒绝', async () => {
    mockGet.mockResolvedValue(mockCreatedRow({ id: 5 }))
    mockUpdate.mockResolvedValue(null)
    const res = await savePrdTool.execute(
      { prdId: 5, structured: minimalValidPrd() },
      ctx()
    )
    expect(res.success).toBe(false)
    expect(res.output).toContain('更新失败')
  })
})

// =============================================================================
// 幂等 / 稳定性
// =============================================================================

describe('save_prd 幂等与稳定性', () => {
  it('同一 structured 输入，renderer 输出确定性（两次调用 markdown 全等）', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow())
    await savePrdTool.execute({ structured: minimalValidPrd() }, ctx())
    const md1 = mockCreate.mock.calls[0][0].contentMarkdown

    mockCreate.mockReset()
    mockCreate.mockResolvedValue(mockCreatedRow())
    await savePrdTool.execute({ structured: minimalValidPrd() }, ctx())
    const md2 = mockCreate.mock.calls[0][0].contentMarkdown

    expect(md1).toBe(md2)
  })
})

// =============================================================================
// V2.0 baseline 埋点写回（schema-v18 metrics JSONB）
// =============================================================================

describe('save_prd 埋点写回', () => {
  it('structured 路径：创建成功 → mergePrdMetrics({ create: 1, rulesVersion })', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow({ id: 42 }))
    await savePrdTool.execute({ structured: minimalValidPrd() }, ctx())

    expect(mockMergeMetrics).toHaveBeenCalledTimes(1)
    expect(mockMergeMetrics).toHaveBeenCalledWith(42, {
      llmCallsDelta: { create: 1 },
      rulesVersion: RULES_VERSION,
    })
  })

  it('structured 路径：更新成功 → 同样 +1 次 create（每次对话轮 = 1 次 LLM 调用）', async () => {
    mockGet.mockResolvedValue(mockCreatedRow({ id: 5 }))
    mockUpdate.mockResolvedValue(mockCreatedRow({ id: 5, version: 2 }))
    await savePrdTool.execute(
      { prdId: 5, structured: minimalValidPrd() },
      ctx()
    )

    expect(mockMergeMetrics).toHaveBeenCalledWith(5, {
      llmCallsDelta: { create: 1 },
      rulesVersion: RULES_VERSION,
    })
  })

  it('V1 兼容路径（contentMarkdown）：不写 rulesVersion（仅 create delta）', async () => {
    mockCreate.mockResolvedValue(mockCreatedRow({ id: 99 }))
    await savePrdTool.execute(
      { contentMarkdown: '# X\n正文正文正文正文正文' },
      ctx()
    )
    expect(mockMergeMetrics).toHaveBeenCalledWith(99, {
      llmCallsDelta: { create: 1 },
      rulesVersion: undefined,
    })
  })

  it('机械校验失败 → 不入库也不写埋点', async () => {
    const bad = minimalValidPrd()
    ;(bad.functionalRequirements[0] as { source: unknown }).source = {
      phase: 2,
      type: 'user_said',
    } // 缺 quote，触发机械拦截
    const res = await savePrdTool.execute({ structured: bad }, ctx())
    expect(res.success).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockMergeMetrics).not.toHaveBeenCalled()
  })

  it('创建失败（createPrdDocument 抛错）→ 不写埋点', async () => {
    mockCreate.mockRejectedValue(new Error('db down'))
    const res = await savePrdTool.execute(
      { structured: minimalValidPrd() },
      ctx()
    )
    expect(res.success).toBe(false)
    expect(mockMergeMetrics).not.toHaveBeenCalled()
  })
})
