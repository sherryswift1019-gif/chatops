import type { StageFields, StageType } from '../types'

/**
 * 切换 stageType 时清理旧类型独有字段：返回新的 StageFields。
 *
 * 共享字段（name / targetRoles / parallel / timeoutSeconds / retryCount /
 * onFailure / stageType）保留；每种 stageType 独占字段（script / approverIds /
 * approvalDescription / capabilityKey / capabilityParams / webhookTag /
 * imInputConfig）被清空，新类型按默认值注入。
 */
export function pruneStageFields(prev: StageFields, newType: StageType): StageFields {
  const base: StageFields = {
    id: prev.id,
    name: prev.name,
    stageType: newType,
    targetRoles: prev.targetRoles,
    parallel: prev.parallel,
    timeoutSeconds: prev.timeoutSeconds,
    retryCount: prev.retryCount,
    onFailure: prev.onFailure,
  }
  switch (newType) {
    case 'script':
      return { ...base, script: '' }
    case 'approval':
      return { ...base, approverIds: [], approvalDescription: '' }
    case 'capability':
      return { ...base, capabilityKey: '', capabilityParams: {} }
    case 'wait_webhook':
      return { ...base, webhookTag: '' }
    case 'im_input':
      return {
        ...base,
        imInputConfig: {
          prompt: '请提供以下参数：',
          paramSchema: { type: 'object', properties: {}, required: [] },
          timeoutSeconds: 600,
        },
      }
  }
}

/**
 * 列出 prev 里已填、不属于 newType 独占字段的 field 名称（用于弹框提示）。
 */
export function obsoleteFieldsOnSwitch(prev: StageFields, newType: StageType): string[] {
  const fieldsByType: Record<StageType, (keyof StageFields)[]> = {
    script: ['script'],
    approval: ['approverIds', 'approvalDescription'],
    capability: ['capabilityKey', 'capabilityParams'],
    wait_webhook: ['webhookTag'],
    im_input: ['imInputConfig'],
  }
  const obsolete: string[] = []
  for (const [type, fields] of Object.entries(fieldsByType) as [StageType, (keyof StageFields)[]][]) {
    if (type === newType) continue
    for (const f of fields) {
      if (!isEmpty(prev[f])) obsolete.push(String(f))
    }
  }
  return obsolete
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  return false
}
