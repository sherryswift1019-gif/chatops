import type { StageFields } from './types'

export function firstGraphIssue(nodes: ReadonlyArray<{ id: string; data: StageFields }>):
  | { nodeId: string; message: string }
  | null {
  for (const n of nodes) {
    const d = n.data
    if (!d.name?.trim()) return { nodeId: n.id, message: '节点缺少名称' }
    if (d.stageType === 'llm_agent' && d.agentMode !== 'custom' && !d.capabilityKey?.trim()) {
      return { nodeId: n.id, message: `节点 ${d.name}: 未选择 Capability` }
    }
    if (d.stageType === 'wait_webhook' && !d.webhookTag?.trim()) {
      return { nodeId: n.id, message: `节点 ${d.name}: Webhook Tag 为空` }
    }
    if (d.stageType === 'im_input') {
      if (!d.imInputConfig?.prompt?.trim()) {
        return { nodeId: n.id, message: `节点 ${d.name}: 引导语为空` }
      }
      const ps = d.imInputConfig.paramSchema
      if (!ps || typeof ps !== 'object' || Array.isArray(ps)) {
        return { nodeId: n.id, message: `节点 ${d.name}: paramSchema 不是合法 object` }
      }
    }
    if (d.stageType === 'approval' && (!d.approverIds || d.approverIds.length === 0)) {
      return { nodeId: n.id, message: `节点 ${d.name}: 未选择审批人` }
    }
  }
  return null
}
