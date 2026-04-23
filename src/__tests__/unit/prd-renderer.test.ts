import { describe, it, expect } from 'vitest'
import { renderPrdMarkdown } from '../../agent/prd/renderer.js'
import type { StructuredPrd } from '../../agent/prd/structured-types.js'

// =============================================================================
// 测试夹具
// =============================================================================

function minimalPrd(): StructuredPrd {
  return {
    meta: { title: '订单极简下单', productLineId: 1 },
    goals: {
      vision: '让零售 C 端下单更快。',
      oneLineStatement: '订单极简下单',
      objectives: ['提升转化率', '降低客诉率'],
      successMetrics: [
        { metric: '下单转化', target: '≥ 85%', measurement: '周度看板' },
      ],
    },
    users: {
      primarySegment: '零售 C 端用户',
      narrative: '高频、手机端为主、不耐烦等待',
    },
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
        description: '复用现有 verifyToken',
        source: 'Phase 2 对话',
      },
    ],
    breakingChanges: [],
    scope: {
      inScope: ['一键下单'],
      outOfScope: [{ item: '货到付款', reason: '一期不做' }],
      tbd: [{ item: '分期付款', needsInput: '待财务确认' }],
    },
  }
}

function richPrd(): StructuredPrd {
  const prd = minimalPrd()
  prd.users.journeys = [
    {
      id: 'j1',
      name: '首单用户下单',
      persona: '新用户',
      steps: [
        { order: 2, action: '选择地址' },
        { order: 1, action: '进入商品页' },
        { order: 3, action: '确认支付' },
      ],
    },
  ]
  prd.functionalRequirements[0].actions = [
    {
      verb: '提交订单',
      trigger: '用户点击"立即下单"按钮',
      stateChange: 'order.status: draft → pending_pay',
      notify: '支付网关下发支付单',
      nextActor: '用户完成支付',
      terminalState: 'order.status = paid 或 cancelled',
    },
  ]
  prd.impacts = [
    {
      module: 'auth',
      type: '行为复用',
      compatibility: '完全兼容',
      description: '复用现有 verifyToken',
      source: 'Phase 2 对话',
    },
    {
      module: 'order-api',
      type: '接口变更',
      compatibility: '破坏性变更',
      description: '新增 priority 字段',
      source: 'Phase 3 对话',
    },
  ]
  prd.breakingChanges = [
    {
      module: 'order-api',
      current: 'GET /order 返回 {id, status}',
      after: 'GET /order 返回 {id, status, priority}',
      affectedParties: ['前端订单页', '运营后台'],
      migrationSteps: '前端同步升级；后端灰度再全量',
      rollbackStrategy: '环境变量切回旧字段集',
    },
  ]
  prd.decisionLog = [
    {
      decision: '一键下单不支持货到付款',
      rationale: '成本回收难，一期放弃',
      decidedAt: '2026-04-22',
    },
  ]
  prd.narrative = 'PM 补充：本项目锚定双 11 之前完成。'
  return prd
}

// =============================================================================
// 确定性 & 基础结构
// =============================================================================

describe('renderPrdMarkdown 确定性', () => {
  it('同一输入两次渲染完全一致', () => {
    const prd = minimalPrd()
    const a = renderPrdMarkdown(prd)
    const b = renderPrdMarkdown(prd)
    expect(a).toBe(b)
  })

  it('同一输入 + 同一 meta 渲染一致', () => {
    const prd = richPrd()
    const meta = { author: '张三', date: '2026-04-22', version: 'v1.2', status: 'draft' }
    expect(renderPrdMarkdown(prd, meta)).toBe(renderPrdMarkdown(prd, meta))
  })
})

describe('renderPrdMarkdown 章节结构', () => {
  it('包含全部 9 个章节标题且顺序正确', () => {
    const out = renderPrdMarkdown(minimalPrd())
    const indices = [
      out.indexOf('## 1. 愿景与目标'),
      out.indexOf('## 2. 用户与场景'),
      out.indexOf('## 3. 功能需求'),
      out.indexOf('## 4. 非功能需求'),
      out.indexOf('## 5. 与现有系统集成'),
      out.indexOf('## 6. 对现有功能的影响'),
      out.indexOf('## 7. 范围边界'),
      out.indexOf('## 8. 待定事项'),
      out.indexOf('## 9. 决策日志'),
    ]
    for (const idx of indices) expect(idx).toBeGreaterThan(-1)
    // 严格升序
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1])
    }
  })

  it('章节 6 含 6.1 / 6.2 / 6.3 三个子章节', () => {
    const out = renderPrdMarkdown(minimalPrd())
    expect(out).toContain('### 6.1 受影响清单')
    expect(out).toContain('### 6.2 破坏性变更详述')
    expect(out).toContain('### 6.3 回归测试建议')
  })

  it('一级标题含 PRD 名称', () => {
    const out = renderPrdMarkdown(minimalPrd())
    expect(out.split('\n')[0]).toBe('# 订单极简下单 — 产品需求文档')
  })

  it('末尾以换行结尾（下游拼接安全）', () => {
    expect(renderPrdMarkdown(minimalPrd()).endsWith('\n')).toBe(true)
  })
})

describe('renderPrdMarkdown 字段渲染', () => {
  it('oneLineStatement 作为 1.1 的一句话定位', () => {
    const out = renderPrdMarkdown(minimalPrd())
    expect(out).toContain('**一句话定位：** 订单极简下单')
  })

  it('功能需求 id + 名称 + 优先级正确', () => {
    const out = renderPrdMarkdown(minimalPrd())
    expect(out).toContain('### 3.1 一键下单 [P0]')
  })

  it('来源字段包含 phase 和 quote', () => {
    const out = renderPrdMarkdown(minimalPrd())
    expect(out).toContain('**来源：** Phase 2 — "就要那种一键的"')
  })

  it('破坏性变更为空时 6.2 显示"无"', () => {
    const out = renderPrdMarkdown(minimalPrd())
    expect(out).toMatch(/### 6\.2 破坏性变更详述\s*\n\s*\n\s*无/)
  })

  it('有破坏性变更时 6.2 渲染 5 个字段', () => {
    const out = renderPrdMarkdown(richPrd())
    expect(out).toContain('**现状：** GET /order 返回 {id, status}')
    expect(out).toContain('**变更后：** GET /order 返回 {id, status, priority}')
    expect(out).toContain('**影响方：** 前端订单页、运营后台')
    expect(out).toContain('**迁移步骤：** 前端同步升级；后端灰度再全量')
    expect(out).toContain('**回滚策略：** 环境变量切回旧字段集')
  })

  it('6.3 从 impacts 派生：行为变更/接口变更 条目才入回归列表', () => {
    const out = renderPrdMarkdown(richPrd())
    // 行为复用的 auth 不应出现在 6.3
    const ch63 = out.substring(
      out.indexOf('### 6.3 回归测试建议'),
      out.indexOf('## 7.')
    )
    expect(ch63).not.toContain('auth')
    expect(ch63).toContain('order-api — 接口变更')
  })

  it('第 5 章从 impacts 的行为复用派生', () => {
    const out = renderPrdMarkdown(richPrd())
    const ch5 = out.substring(
      out.indexOf('## 5. 与现有系统集成'),
      out.indexOf('## 6.')
    )
    expect(ch5).toContain('**auth**：复用现有 verifyToken')
    expect(ch5).not.toContain('order-api') // 不是行为复用，不该进第 5 章
  })

  it('journeys 步骤按 order 升序（输入乱序也能还原）', () => {
    const out = renderPrdMarkdown(richPrd())
    const ch22 = out.substring(
      out.indexOf('### 2.2 用户旅程'),
      out.indexOf('## 3.')
    )
    const step1 = ch22.indexOf('1. 进入商品页')
    const step2 = ch22.indexOf('2. 选择地址')
    const step3 = ch22.indexOf('3. 确认支付')
    expect(step1).toBeGreaterThan(-1)
    expect(step2).toBeGreaterThan(step1)
    expect(step3).toBeGreaterThan(step2)
  })

  it('actions 5W 完整渲染', () => {
    const out = renderPrdMarkdown(richPrd())
    expect(out).toContain('**动作：提交订单**')
    expect(out).toContain('触发：用户点击"立即下单"按钮')
    expect(out).toContain('终态：order.status = paid 或 cancelled')
  })

  it('narrative 作为"附：作者补充说明"渲染在最后', () => {
    const out = renderPrdMarkdown(richPrd())
    const idx = out.indexOf('## 附：作者补充说明')
    expect(idx).toBeGreaterThan(-1)
    expect(out.indexOf('## 9. 决策日志')).toBeLessThan(idx)
  })

  it('无 narrative 时不渲染附加章节', () => {
    expect(renderPrdMarkdown(minimalPrd())).not.toContain('附：作者补充说明')
  })

  it('meta 元信息行使用 defaults', () => {
    const out = renderPrdMarkdown(minimalPrd())
    expect(out).toContain('**作者：** —')
    expect(out).toContain('**版本：** v1.0')
    expect(out).toContain('**状态：** draft')
  })

  it('meta 可被覆盖', () => {
    const out = renderPrdMarkdown(minimalPrd(), {
      author: '张三',
      date: '2026-04-22',
      version: 'v1.3',
      status: 'reviewing',
    })
    expect(out).toContain(
      '**作者：** 张三  |  **日期：** 2026-04-22  |  **版本：** v1.3  |  **状态：** reviewing'
    )
  })
})

describe('renderPrdMarkdown 表格单元转义', () => {
  it('包含 | 的字段值被转义', () => {
    const prd = minimalPrd()
    prd.goals.successMetrics = [
      { metric: 'a|b', target: '≥ 80%', measurement: '看板' },
    ]
    const out = renderPrdMarkdown(prd)
    expect(out).toContain('| a\\|b | ≥ 80% | 看板 |')
  })

  it('含换行的字段值被折叠成单行', () => {
    const prd = minimalPrd()
    prd.impacts = [
      {
        module: 'auth',
        type: '行为复用',
        compatibility: '完全兼容',
        description: '第一行\n第二行',
        source: 'Phase 2',
      },
    ]
    const out = renderPrdMarkdown(prd)
    expect(out).toContain('| auth | 行为复用 | 第一行 第二行 | 完全兼容 | Phase 2 |')
  })
})

describe('renderPrdMarkdown 空数据 stub', () => {
  it('无旅程时 2.2 显示 stub', () => {
    const out = renderPrdMarkdown(minimalPrd())
    expect(out).toContain('（无用户旅程记录）')
  })

  it('tbd 为空时 8 章显示 stub', () => {
    const prd = minimalPrd()
    prd.scope.tbd = []
    expect(renderPrdMarkdown(prd)).toContain('（无待定事项）')
  })

  it('decisionLog 为空时 9 章显示 stub', () => {
    const out = renderPrdMarkdown(minimalPrd())
    expect(out).toContain('（无决策记录）')
  })
})

// =============================================================================
// 完整 snapshot
// =============================================================================

describe('renderPrdMarkdown snapshot', () => {
  it('minimalPrd 渲染产物稳定', () => {
    const out = renderPrdMarkdown(minimalPrd(), {
      author: '张三',
      date: '2026-04-22',
      version: 'v1.0',
      status: 'draft',
    })
    expect(out).toMatchInlineSnapshot(`
      "# 订单极简下单 — 产品需求文档

      **作者：** 张三  |  **日期：** 2026-04-22  |  **版本：** v1.0  |  **状态：** draft

      ---

      ## 1. 愿景与目标

      ### 1.1 产品愿景

      **一句话定位：** 订单极简下单

      让零售 C 端下单更快。

      ### 1.2 项目目标

      - 提升转化率
      - 降低客诉率

      ### 1.3 成功指标

      | 指标 | 目标值 | 度量方式 |
      |------|--------|----------|
      | 下单转化 | ≥ 85% | 周度看板 |

      ## 2. 用户与场景

      ### 2.1 目标用户

      | 角色 | 描述 | 核心诉求 |
      |------|------|----------|
      | 零售 C 端用户 | 高频、手机端为主、不耐烦等待 | — |

      ### 2.2 用户旅程

      （无用户旅程记录）

      ## 3. 功能需求

      ### 3.1 一键下单 [P0]

      **描述：** 已登录用户在商品页点击后即下单。

      **验收标准：**
      - [ ] 耗时 P99 < 500ms
      - [ ] 成功率 ≥ 99.9%

      **来源：** Phase 2 — "就要那种一键的"（user_said）

      ## 4. 非功能需求

      （本期非功能要求在各功能需求的验收标准中体现；V2.1 将单独建模）

      ## 5. 与现有系统集成

      - **auth**：复用现有 verifyToken

      ## 6. 对现有功能的影响

      ### 6.1 受影响清单

      | 现有模块/功能 | 影响类型 | 描述 | 兼容性 | 来源 |
      |--------------|---------|------|--------|------|
      | auth | 行为复用 | 复用现有 verifyToken | 完全兼容 | Phase 2 对话 |

      ### 6.2 破坏性变更详述

      无

      ### 6.3 回归测试建议

      （无需额外回归：本期变更均属"行为复用"或"无直接影响"）

      ## 7. 范围边界

      ### 在范围内（一期）
      - 一键下单

      ### 明确排除
      - 货到付款（原因：一期不做）

      ## 8. 待定事项

      - [ ] 分期付款（待：待财务确认）

      ## 9. 决策日志

      （无决策记录）
      "
    `)
  })
})
