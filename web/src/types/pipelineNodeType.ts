export interface PipelineNodeType {
  key: string
  displayName: string
  description: string
  category: 'general' | 'flow' | 'llm' | 'specialized'
  paramSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  enabled: boolean
}
