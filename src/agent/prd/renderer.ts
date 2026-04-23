/**
 * PRD Agent V2.0 — 结构化 → Markdown 模板渲染。
 *
 * 对应迭代文档 docs/prds/prd-agent-v2-iteration.md §5.4。
 *
 * 设计原则：
 *   - 输出的 9 章节顺序、编号、标题与 V1 模板严格一致（下游消费零改动）
 *   - 纯函数，确定性：同一输入 → 完全相同输出
 *   - 缺失数据不抛错，按"合理 stub"渲染（机械校验已保证必填字段存在）
 *   - 不做任何自由发挥：渲染器只拼装，绝不虚构内容
 *
 * 范围外（V2.0 MVP）：
 *   - 第 4 章非功能需求 / 第 5 章集成 / 第 6.3 回归测试
 *     这些数据 V2.0 StructuredPrd 未显式建模。渲染策略如下：
 *       · 第 4 章：stub（待 V2.1 扩展 StructuredPrd 时补）
 *       · 第 5 章：从 impacts 中 type='行为复用' 的条目派生
 *       · 第 6.3 章：从 impacts 中 type ∈ {行为变更, 接口变更} 的条目派生
 */

import type {
  PrdAction,
  PrdBreakingChange,
  PrdFunctionalRequirement,
  PrdImpactItem,
  StructuredPrd,
} from './structured-types.js'

// =============================================================================
// 渲染选项（来自 DB prd_documents 记录的元数据，不在 StructuredPrd 里）
// =============================================================================

export interface PrdRenderMeta {
  author?: string
  date?: string
  version?: string
  status?: string
}

const DEFAULT_META: Required<PrdRenderMeta> = {
  author: '—',
  date: '—',
  version: 'v1.0',
  status: 'draft',
}

// =============================================================================
// 工具：表格单元转义 / 空值 stub
// =============================================================================

function cell(s: string | number | undefined | null): string {
  if (s === undefined || s === null) return '—'
  const str = String(s)
  if (!str.trim()) return '—'
  return str.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function joinLines(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string')
    .join('\n')
}

function section(title: string, body: string): string {
  return `${title}\n\n${body}`.trimEnd()
}

// =============================================================================
// 章节 1. 愿景与目标
// =============================================================================

function renderChapter1(prd: StructuredPrd): string {
  const ch11 = section(
    '### 1.1 产品愿景',
    joinLines([
      prd.goals?.oneLineStatement ? `**一句话定位：** ${prd.goals.oneLineStatement}` : null,
      prd.goals?.vision ? `\n${prd.goals.vision}` : null,
    ])
  )

  const objectives = prd.goals?.objectives ?? []
  const ch12 = section(
    '### 1.2 项目目标',
    objectives.length > 0 ? objectives.map((o) => `- ${o}`).join('\n') : '（待补充）'
  )

  const metrics = prd.goals?.successMetrics ?? []
  const ch13 = section(
    '### 1.3 成功指标',
    metrics.length > 0
      ? joinLines([
          '| 指标 | 目标值 | 度量方式 |',
          '|------|--------|----------|',
          ...metrics.map((m) => `| ${cell(m.metric)} | ${cell(m.target)} | ${cell(m.measurement)} |`),
        ])
      : '（待补充）'
  )

  return section('## 1. 愿景与目标', joinLines([ch11, '', ch12, '', ch13]))
}

// =============================================================================
// 章节 2. 用户与场景
// =============================================================================

function renderChapter2(prd: StructuredPrd): string {
  const ch21 = section(
    '### 2.1 目标用户',
    joinLines([
      '| 角色 | 描述 | 核心诉求 |',
      '|------|------|----------|',
      `| ${cell(prd.users?.primarySegment)} | ${cell(prd.users?.narrative)} | — |`,
    ])
  )

  const journeys = prd.users?.journeys ?? []
  const ch22 = section(
    '### 2.2 用户旅程',
    journeys.length > 0
      ? journeys
          .map((j) =>
            joinLines([
              `**旅程 ${j.id}: ${j.name}**（角色：${j.persona}）`,
              ...j.steps
                .slice()
                .sort((a, b) => a.order - b.order)
                .map((s) => `${s.order}. ${s.action}`),
            ])
          )
          .join('\n\n')
      : '（无用户旅程记录）'
  )

  return section('## 2. 用户与场景', joinLines([ch21, '', ch22]))
}

// =============================================================================
// 章节 3. 功能需求
// =============================================================================

function renderAction(action: PrdAction): string {
  return joinLines([
    `  - **动作：${action.verb}**`,
    `    - 触发：${action.trigger}`,
    `    - 状态变化：${action.stateChange}`,
    `    - 通知：${action.notify}`,
    `    - 后续：${action.nextActor}`,
    `    - 终态：${action.terminalState}`,
  ])
}

function renderFunctionalRequirement(req: PrdFunctionalRequirement): string {
  const criteria = req.acceptanceCriteria ?? []
  const actions = req.actions ?? []
  const sourceLine = req.source
    ? `**来源：** Phase ${req.source.phase} — "${req.source.quote}"（${req.source.type}）`
    : '**来源：** —'

  const parts: string[] = []
  parts.push(`### ${req.id} ${req.name} [${req.priority}]`)
  parts.push('')
  parts.push(`**描述：** ${req.description || '（待补充）'}`)
  parts.push('')
  parts.push('**验收标准：**')
  parts.push(
    criteria.length > 0
      ? criteria.map((c) => `- [ ] ${c.text}`).join('\n')
      : '- [ ] （待补充）'
  )
  if (actions.length > 0) {
    parts.push('')
    parts.push('**闭环动作：**')
    parts.push(actions.map(renderAction).join('\n'))
  }
  parts.push('')
  parts.push(sourceLine)
  return parts.join('\n')
}

function renderChapter3(prd: StructuredPrd): string {
  const reqs = prd.functionalRequirements ?? []
  const body =
    reqs.length > 0
      ? reqs.map(renderFunctionalRequirement).join('\n\n')
      : '（无功能需求）'
  return section('## 3. 功能需求', body)
}

// =============================================================================
// 章节 4. 非功能需求（V2.0 MVP stub）
// =============================================================================

function renderChapter4(_prd: StructuredPrd): string {
  return section(
    '## 4. 非功能需求',
    '（本期非功能要求在各功能需求的验收标准中体现；V2.1 将单独建模）'
  )
}

// =============================================================================
// 章节 5. 与现有系统集成（从 impacts 的"行为复用"派生）
// =============================================================================

function renderChapter5(prd: StructuredPrd): string {
  const reuseItems = (prd.impacts ?? []).filter((i) => i.type === '行为复用')
  const body =
    reuseItems.length > 0
      ? reuseItems.map((i) => `- **${i.module}**：${i.description}`).join('\n')
      : '（本期无新增系统集成，详见第 6 章受影响清单）'
  return section('## 5. 与现有系统集成', body)
}

// =============================================================================
// 章节 6. 对现有功能的影响
// =============================================================================

function renderImpactRow(imp: PrdImpactItem): string {
  return `| ${cell(imp.module)} | ${cell(imp.type)} | ${cell(imp.description)} | ${cell(
    imp.compatibility
  )} | ${cell(imp.source)} |`
}

function renderBreakingChange(bc: PrdBreakingChange): string {
  const module = bc.module ? `**模块：${bc.module}**` : '**模块：—**'
  return joinLines([
    module,
    '',
    `- **现状：** ${bc.current}`,
    `- **变更后：** ${bc.after}`,
    `- **影响方：** ${bc.affectedParties.join('、')}`,
    `- **迁移步骤：** ${bc.migrationSteps}`,
    `- **回滚策略：** ${bc.rollbackStrategy}`,
  ])
}

function renderChapter6(prd: StructuredPrd): string {
  const impacts = prd.impacts ?? []
  const ch61 = section(
    '### 6.1 受影响清单',
    impacts.length > 0
      ? joinLines([
          '| 现有模块/功能 | 影响类型 | 描述 | 兼容性 | 来源 |',
          '|--------------|---------|------|--------|------|',
          ...impacts.map(renderImpactRow),
        ])
      : '（无受影响条目）'
  )

  const breakingChanges = prd.breakingChanges ?? []
  const ch62 = section(
    '### 6.2 破坏性变更详述',
    breakingChanges.length > 0
      ? breakingChanges.map(renderBreakingChange).join('\n\n')
      : '无'
  )

  const regressionItems = impacts.filter(
    (i) => i.type === '行为变更' || i.type === '接口变更'
  )
  const ch63 = section(
    '### 6.3 回归测试建议',
    regressionItems.length > 0
      ? regressionItems
          .map((i) => `- [ ] ${i.module} — ${i.type}：${i.description}`)
          .join('\n')
      : '（无需额外回归：本期变更均属"行为复用"或"无直接影响"）'
  )

  return section('## 6. 对现有功能的影响', joinLines([ch61, '', ch62, '', ch63]))
}

// =============================================================================
// 章节 7. 范围边界
// =============================================================================

function renderChapter7(prd: StructuredPrd): string {
  const inScope = prd.scope?.inScope ?? []
  const outOfScope = prd.scope?.outOfScope ?? []
  const body = joinLines([
    '### 在范围内（一期）',
    inScope.length > 0 ? inScope.map((s) => `- ${s}`).join('\n') : '（待补充）',
    '',
    '### 明确排除',
    outOfScope.length > 0
      ? outOfScope.map((o) => `- ${o.item}（原因：${o.reason}）`).join('\n')
      : '（无）',
  ])
  return section('## 7. 范围边界', body)
}

// =============================================================================
// 章节 8. 待定事项
// =============================================================================

function renderChapter8(prd: StructuredPrd): string {
  const tbd = prd.scope?.tbd ?? []
  const body =
    tbd.length > 0
      ? tbd
          .map((t) =>
            t.needsInput ? `- [ ] ${t.item}（待：${t.needsInput}）` : `- [ ] ${t.item}`
          )
          .join('\n')
      : '（无待定事项）'
  return section('## 8. 待定事项', body)
}

// =============================================================================
// 章节 9. 决策日志
// =============================================================================

function renderChapter9(prd: StructuredPrd): string {
  const decisions = prd.decisionLog ?? []
  const body =
    decisions.length > 0
      ? joinLines([
          '| 决策 | 依据 | 时间 |',
          '|------|------|------|',
          ...decisions.map(
            (d) => `| ${cell(d.decision)} | ${cell(d.rationale)} | ${cell(d.decidedAt)} |`
          ),
        ])
      : '（无决策记录）'
  return section('## 9. 决策日志', body)
}

// =============================================================================
// 顶部标题与元信息
// =============================================================================

function renderHeader(prd: StructuredPrd, meta: Required<PrdRenderMeta>): string {
  return joinLines([
    `# ${prd.meta?.title ?? '（未命名 PRD）'} — 产品需求文档`,
    '',
    `**作者：** ${meta.author}  |  **日期：** ${meta.date}  |  **版本：** ${meta.version}  |  **状态：** ${meta.status}`,
    '',
    '---',
  ])
}

function renderTrailingNarrative(prd: StructuredPrd): string {
  if (!prd.narrative || !prd.narrative.trim()) return ''
  return section('## 附：作者补充说明', prd.narrative.trim())
}

// =============================================================================
// 入口
// =============================================================================

/**
 * 把结构化 PRD 渲染为 V1 模板格式的 Markdown。
 *
 * 输出稳定性：同一 `prd` + `meta` 调用两次，返回字符串完全一致（测试覆盖）。
 *
 * @param prd 机械校验通过的结构化 PRD（调用方应先 mechanicalValidate）
 * @param meta 来自 prd_documents 记录的元信息（作者/日期/版本/状态）；缺省用 DEFAULT_META
 */
export function renderPrdMarkdown(
  prd: StructuredPrd,
  meta: PrdRenderMeta = {}
): string {
  const m: Required<PrdRenderMeta> = { ...DEFAULT_META, ...meta }
  const parts = [
    renderHeader(prd, m),
    renderChapter1(prd),
    renderChapter2(prd),
    renderChapter3(prd),
    renderChapter4(prd),
    renderChapter5(prd),
    renderChapter6(prd),
    renderChapter7(prd),
    renderChapter8(prd),
    renderChapter9(prd),
    renderTrailingNarrative(prd),
  ].filter((s) => s.length > 0)
  return parts.join('\n\n') + '\n'
}
