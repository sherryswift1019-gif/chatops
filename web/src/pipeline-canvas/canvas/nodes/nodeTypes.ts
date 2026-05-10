import { createElement } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { ScriptNode } from './ScriptNode'
import { ApprovalNode } from './ApprovalNode'
import { CapabilityNode } from './CapabilityNode'
import { WebhookNode } from './WebhookNode'
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
  switch: SwitchNode,
  // Phase 3 NodeExecutor-backed 节点类型（共享 StageNodeCard 视觉）
  http: makeSimpleNode('#13c2c2', 'HTTP 调用', d => (d.params as { url?: string })?.url ?? '未配置 url'),
  dm: makeSimpleNode('#eb2f96', 'IM 私聊', d => (d.params as { target?: string })?.target ?? '未配置 target'),
  db_update: makeSimpleNode('#2f54eb', 'DB 写入', d => (d.params as { sqlTemplate?: string })?.sqlTemplate ? 'SQL ✓' : '未配置 sqlTemplate'),
  sql_query: makeSimpleNode('#2f54eb', 'DB 查询', d => (d.params as { sqlTemplate?: string })?.sqlTemplate ? 'SQL ✓' : '未配置 sqlTemplate'),
  file_read: makeSimpleNode('#52c41a', '文件读取', d => (d.params as { path?: string })?.path ?? '未配置 path'),
  template_render: makeSimpleNode('#fa8c16', '模板渲染', d => (d.params as { template?: string })?.template ? '模板 ✓' : '未配置 template'),
  fan_out: makeSimpleNode('#f5222d', '数组扇出', d => (d.params as { items?: string })?.items ?? '未配置 items'),
  // Quick-Impl 专属节点类型
  init_qi_branch: makeSimpleNode('#722ed1', '初始化分支'),
  skill_with_approval: makeSimpleNode('#d4380d', '生成 + 审批'),
  skill_with_review: makeSimpleNode('#096dd9', '生成 + 评审'),
  skill_node: makeSimpleNode('#389e0d', 'Skill 调用'),
  e2e_stub: makeSimpleNode('#7cb305', 'E2E Stub'),
  qi_e2e_runner: makeSimpleNode('#7cb305', 'E2E 测试'),
  im_input: makeSimpleNode('#531dab', 'IM 人工介入'),
  mr_create: makeSimpleNode('#c41d7f', '创建 MR'),
}
