/**
 * Pipeline 触发源显式类型。
 *
 * 同一条 pipeline 定义可以被多种入口触发：IM 群聊、管理页面手动按钮、
 * OpenAPI、Cron 调度。这里把触发上下文收拢成一个判别联合，
 * 让 runPipeline 的签名不再依赖位置参数顺序，并保证每种触发源
 * 携带自己必备的上下文（例如 IM 必须带 platform+groupId+userId）。
 *
 * Why: n8n 这类工具把 trigger 绑在 workflow 定义里，一个 workflow
 * 只能一个入口。我们需要同一条 pipeline 被 N 个入口复用，因此
 * 把触发从定义里解耦到运行时参数。
 */

export interface PipelineTriggerBase {
  /** 触发发起人 ID / 用户名。IM 场景为 initiatorId，manual 为登录用户，api 为调用方标识。 */
  triggeredBy: string
  /** 透传给 graph-runner 的额外参数（runtimeVars 之外的上下文，例如 reportId）。 */
  params?: Record<string, unknown>
}

export interface ImPipelineTrigger extends PipelineTriggerBase {
  type: 'im'
  platform: string
  groupId: string
  userId: string
}

export interface ManualPipelineTrigger extends PipelineTriggerBase {
  type: 'manual'
}

export interface ApiPipelineTrigger extends PipelineTriggerBase {
  type: 'api'
}

export interface ScheduledPipelineTrigger extends PipelineTriggerBase {
  type: 'scheduled'
}

export type PipelineTrigger =
  | ImPipelineTrigger
  | ManualPipelineTrigger
  | ApiPipelineTrigger
  | ScheduledPipelineTrigger

export type PipelineTriggerType = PipelineTrigger['type']

export const imTrigger = (
  args: Omit<ImPipelineTrigger, 'type'>,
): ImPipelineTrigger => ({ type: 'im', ...args })

export const manualTrigger = (
  args: Omit<ManualPipelineTrigger, 'type'>,
): ManualPipelineTrigger => ({ type: 'manual', ...args })

export const apiTrigger = (
  args: Omit<ApiPipelineTrigger, 'type'>,
): ApiPipelineTrigger => ({ type: 'api', ...args })

export const scheduledTrigger = (
  args: Omit<ScheduledPipelineTrigger, 'type'>,
): ScheduledPipelineTrigger => ({ type: 'scheduled', ...args })

export interface ImTriggerContext {
  platform: string
  groupId: string
  userId: string
}

export function extractImContext(trigger: PipelineTrigger): ImTriggerContext | undefined {
  if (trigger.type !== 'im') return undefined
  return { platform: trigger.platform, groupId: trigger.groupId, userId: trigger.userId }
}
