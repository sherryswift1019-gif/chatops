export interface IMTrigger {
  id: number
  key: string
  displayName: string
  description: string
  pipelineId: number | null
  intentHints: string
  examples: string[]
  failureMessages: Record<string, string>
  defaultApprovalRuleId: number | null
  isSystem: boolean
  enabled: boolean
}

export interface ProductLineIMTrigger {
  id: number
  productLineId: number
  imTriggerKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
  triggerSources: string[]
  approvalRuleId: number | null
}

export interface SetIMTriggerInput {
  imTriggerKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
  triggerSources?: string[]
  approvalRuleId?: number | null
}
