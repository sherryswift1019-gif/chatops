export type IMTriggerCategory = 'info' | 'ops' | 'bug' | 'feature'

export const IM_TRIGGER_CATEGORY_LABELS: Record<IMTriggerCategory, string> = {
  info: '信息抓取',
  ops: '运维操作',
  bug: 'Bug 修复',
  feature: '需求开发',
}

export interface IMTrigger {
  id: number
  key: string
  displayName: string
  description: string
  category: IMTriggerCategory
  pipelineId: number | null
  capabilityKey: string | null
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
