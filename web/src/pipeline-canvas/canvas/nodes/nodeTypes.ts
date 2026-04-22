import { ScriptNode } from './ScriptNode'
import { ApprovalNode } from './ApprovalNode'
import { CapabilityNode } from './CapabilityNode'
import { WebhookNode } from './WebhookNode'

export const nodeTypes = {
  script: ScriptNode,
  approval: ApprovalNode,
  capability: CapabilityNode,
  wait_webhook: WebhookNode,
}
