import { createElement } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { ScriptNode } from './ScriptNode'
import { ApprovalNode } from './ApprovalNode'
import { CapabilityNode } from './CapabilityNode'
import { WebhookNode } from './WebhookNode'
import { ImInputNode } from './ImInputNode'
import { SwitchNode } from './SwitchNode'
import { StageNodeCard } from './StageNodeCard'

function makeSimpleNode(color: string, typeLabel: string, footerFn?: (d: StageNode['data']) => string) {
  return function SimpleNode({ data }: NodeProps<StageNode>) {
    return createElement(StageNodeCard, {
      color,
      typeLabel,
      title: data.name,
      footer: footerFn ? footerFn(data) : undefined,
      onRunHere: (data as any).__onRunHere,
      dryRunPhase: (data as any).__dryRunPhase,
    })
  }
}

export const nodeTypes = {
  script: ScriptNode,
  approval: ApprovalNode,
  llm_agent: CapabilityNode,
  wait_webhook: WebhookNode,
  im_input: ImInputNode,
  switch: SwitchNode,
  // Phase 3 NodeExecutor-backed 节点类型（共享 StageNodeCard 视觉）
  http: makeSimpleNode('#13c2c2', 'HTTP 调用', d => (d.params as { url?: string })?.url ?? '未配置 url'),
  dm: makeSimpleNode('#eb2f96', 'IM 私聊', d => (d.params as { target?: string })?.target ?? '未配置 target'),
  db_update: makeSimpleNode('#2f54eb', 'DB 写入', d => (d.params as { sqlTemplate?: string })?.sqlTemplate ? 'SQL ✓' : '未配置 sqlTemplate'),
  sql_query: makeSimpleNode('#2f54eb', 'DB 查询', d => (d.params as { sqlTemplate?: string })?.sqlTemplate ? 'SQL ✓' : '未配置 sqlTemplate'),
  file_read: makeSimpleNode('#52c41a', '文件读取', d => (d.params as { path?: string })?.path ?? '未配置 path'),
  template_render: makeSimpleNode('#fa8c16', '模板渲染', d => (d.params as { template?: string })?.template ? '模板 ✓' : '未配置 template'),
  fan_out: makeSimpleNode('#f5222d', '数组扇出', d => (d.params as { items?: string })?.items ?? '未配置 items'),
}
