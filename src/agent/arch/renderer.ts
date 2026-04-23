/**
 * 将 StructuredArch 渲染为 13 章节 Markdown 文档。
 */

import type {
  StructuredArch,
  TechStackItem,
  DataModelEntity,
  ComponentItem,
  WorkflowItem,
  ApiEndpoint,
  NfrItem,
  AdrItem,
} from './structured-types.js'

function fmtDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function techStackTable(items: TechStackItem[]): string {
  const header = '| 层次 | 选型 | 替代方案 | 选择理由 | 批准来源 |'
  const divider = '|------|------|----------|----------|----------|'
  const rows = items.map(
    i => `| ${i.layer} | ${i.choice} | ${i.alternatives.join(' / ') || '—'} | ${i.rationale} | ${i.approvedBy} |`
  )
  return [header, divider, ...rows].join('\n')
}

function dataModelSection(entities: DataModelEntity[]): string {
  return entities.map(e => {
    const fieldRows = e.fields
      .map(f => `| ${f.name} | ${f.type} | ${f.nullable ? 'NULL' : 'NOT NULL'} | ${f.description ?? ''} |`)
      .join('\n')
    const fieldTable = [
      '| 字段 | 类型 | 可空 | 描述 |',
      '|------|------|------|------|',
      fieldRows,
    ].join('\n')

    const erPart = e.erDiagram
      ? `\n\n\`\`\`mermaid\n${e.erDiagram}\n\`\`\``
      : ''
    const indexPart = e.indexes?.length
      ? `\n\n**索引**\n${e.indexes.map(x => `- ${x}`).join('\n')}`
      : ''

    return `### ${e.name}\n\n${e.description}\n\n${fieldTable}${erPart}${indexPart}`
  }).join('\n\n')
}

function componentTable(items: ComponentItem[]): string {
  const header = '| 组件 | 职责 | 关键接口 | 技术选型 |'
  const divider = '|------|------|----------|----------|'
  const rows = items.map(
    i =>
      `| ${i.name} | ${i.responsibility} | ${i.keyInterfaces.join('<br>') || '—'} | ${i.techChoice ?? '—'} |`
  )
  return [header, divider, ...rows].join('\n')
}

function workflowSection(items: WorkflowItem[]): string {
  return items.map(w => {
    const diagram = w.sequenceDiagram?.trim()
      ? `\n\n\`\`\`mermaid\n${w.sequenceDiagram}\n\`\`\``
      : ''
    const desc = w.description ? `\n\n${w.description}` : ''
    return `### ${w.id} ${w.name} [${w.priority}]${diagram}${desc}`
  }).join('\n\n')
}

function apiSection(endpoints: ApiEndpoint[]): string {
  return endpoints.map(e => {
    const req = e.requestBody ? `\n\n**Request:** ${e.requestBody}` : ''
    const res = e.responseBody ? `\n\n**Response:** ${e.responseBody}` : ''
    return `#### \`${e.method} ${e.path}\`\n\n${e.description}${req}${res}`
  }).join('\n\n')
}

function nfrTable(items: NfrItem[]): string {
  const header = '| 类别 | 需求 | 目标值 |'
  const divider = '|------|------|--------|'
  const rows = items.map(i => `| ${i.category} | ${i.requirement} | ${i.target ?? '—'} |`)
  return [header, divider, ...rows].join('\n')
}

function adrSection(items: AdrItem[]): string {
  return items.map(adr => {
    const opts = adr.options.map(o => `- ${o}`).join('\n')
    const consequences = adr.consequences ? `\n\n**后果:** ${adr.consequences}` : ''
    return [
      `### ${adr.id} — ${adr.title}`,
      `**状态:** ${adr.status}  |  **来源:** ${adr.source}`,
      `**背景:** ${adr.context}`,
      `**选项:**\n${opts}`,
      `**决策:** ${adr.decision}${consequences}`,
    ].join('\n\n')
  }).join('\n\n---\n\n')
}

function readinessSection(items: string[]): string {
  return items.map(item => `- [ ] ${item}`).join('\n')
}

export function renderArchDocument(arch: StructuredArch): string {
  const { meta, overview, techStack, dataModels, components, coreWorkflows } = arch
  const prdRef = meta.sourcePrdId ? ` | **关联 PRD:** #${meta.sourcePrdId}` : ''

  const sections: string[] = [
    `# ${meta.title} — 架构设计文档`,
    `**作者:** ${meta.architectName ?? '—'}  |  **日期:** ${fmtDate()}  |  **版本:** ${meta.version ?? '1.0'}${prdRef}  |  **状态:** drafting`,
    '',
    '---',
    '',

    // 1. 概述
    '## 1. 概述与目标',
    `**架构定位:** ${overview.positioning}`,
    '',
    `**架构风格:** ${overview.style}`,
    '',
    '**核心设计原则:**',
    overview.principles.map(p => `- ${p}`).join('\n'),
    '',

    // 2. 高层架构
    '## 2. 高层架构',
    '```mermaid',
    overview.componentDiagram,
    '```',
    '',

    // 3. 技术选型
    '## 3. 技术选型',
    techStackTable(techStack),
    '',

    // 4. 数据模型
    '## 4. 数据模型与 DB Schema',
    dataModels.length ? dataModelSection(dataModels) : '_待补充_',
    '',

    // 5. 组件设计
    '## 5. 组件设计',
    components.length ? componentTable(components) : '_待补充_',
    '',

    // 6. 核心工作流
    '## 6. 核心工作流',
    coreWorkflows.length ? workflowSection(coreWorkflows) : '_待补充_',
    '',

    // 7. API 规范
    '## 7. API 规范',
    arch.apiSpec?.length ? apiSection(arch.apiSpec) : '_待补充_',
    '',

    // 8. 基础设施与部署
    '## 8. 基础设施与部署',
    arch.infrastructure?.trim() || '_待补充_',
    '',

    // 9. 安全架构
    '## 9. 安全架构',
    arch.security?.trim() || '_待补充_',
    '',

    // 10. 错误处理与容错
    '## 10. 错误处理与容错',
    arch.errorHandling?.trim() || '_待补充_',
    '',

    // 11. 非功能需求
    '## 11. 非功能需求',
    arch.nfrs?.length ? nfrTable(arch.nfrs) : '_待补充_',
    '',

    // 12. ADR
    '## 12. 架构决策记录（ADR）',
    arch.adrs.length ? adrSection(arch.adrs) : '_待补充_',
    '',

    // 13. 实现就绪检查表
    '## 13. 实现就绪检查表',
    arch.readinessChecklist.length ? readinessSection(arch.readinessChecklist) : '_待补充_',
    '',

    // 范围边界
    '---',
    '',
    '## 范围边界',
    '',
    '**一期包含:**',
    arch.scope.inScope.map(s => `- ${s}`).join('\n') || '—',
    '',
    '**明确排除:**',
    arch.scope.outOfScope.map(s => `- ${s}`).join('\n') || '—',
    '',
    '**待定:**',
    arch.scope.tbd.map(s => `- ${s}`).join('\n') || '—',
  ]

  return sections.join('\n')
}
