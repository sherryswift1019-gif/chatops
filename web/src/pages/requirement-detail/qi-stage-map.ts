export const STEPPER_STAGES = ['init', 'spec', 'plan', 'dev', 'review', 'e2e', 'mr'] as const
export type StepperStage = typeof STEPPER_STAGES[number]

export interface V2StageResultLike {
  name: string
  status: 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped'
}

export type StageStatusValue = 'pending' | 'running' | 'failed' | 'done'

/**
 * 把节点 name 映射到 stepper 段。
 * 节点 ID 来源：src/quick-impl/bootstrap.ts makeNode 第一个参数。
 */
export function mapNodeNameToStage(name: string): StepperStage | null {
  if (name === 'init_branch') return 'init'

  // dev_fix_* 在 e2e 阶段（E2E 失败后修复 loop）
  if (name === 'dev_fix_author' || name === 'dev_fix_ai_review') return 'e2e'

  if (name.startsWith('spec_')) return 'spec'
  if (name.startsWith('plan_')) return 'plan'
  if (name.startsWith('dev_')) return 'dev'

  if (name === 'qi_e2e_runner') return 'e2e'
  if (name.startsWith('e2e_')) return 'e2e'
  if (name.startsWith('sandbox_')) return 'e2e'

  if (name === 'final_approval') return 'review'

  if (name === 'mr_create' || name === 'cleanup' || name === 'done') return 'mr'

  return null
}

/**
 * 计算一个 stepper 段的聚合状态。
 * 见 docs/superpowers/specs/2026-05-12-requirement-detail-page-redesign-design.md §「Stepper 状态算法」
 */
export function stageStatus(stage: StepperStage, allResults: V2StageResultLike[]): StageStatusValue {
  const nodes = allResults.filter(n => mapNodeNameToStage(n.name) === stage)
  const nonSkipped = nodes.filter(n => n.status !== 'skipped')

  if (nonSkipped.length === 0) return 'pending'
  if (nonSkipped.some(n => n.status === 'failed')) return 'failed'
  if (nonSkipped.some(n => n.status === 'running' || n.status === 'waiting')) return 'running'
  if (nonSkipped.every(n => n.status === 'success')) return 'done'
  if (nonSkipped.some(n => n.status === 'success')) return 'running'  // 部分完成
  return 'pending'
}
