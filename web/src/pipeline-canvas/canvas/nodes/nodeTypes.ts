import { ScriptNode } from './ScriptNode'
import { ApprovalNode } from './ApprovalNode'
import { CapabilityNode } from './CapabilityNode'
import { WebhookNode } from './WebhookNode'
import { ImInputNode } from './ImInputNode'
import { SwitchNode } from './SwitchNode'

export const nodeTypes = {
  script: ScriptNode,
  approval: ApprovalNode,
  capability: CapabilityNode,
  wait_webhook: WebhookNode,
  im_input: ImInputNode,
  switch: SwitchNode,
}
