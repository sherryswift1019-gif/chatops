import type { StageFields, StageType } from '../types'
import { BESPOKE_STAGE_TYPES } from '../types'

/**
 * 切换 stageType 时清理旧类型独有字段：返回新的 StageFields。
 *
 * 共享字段（name / targetRoles / parallel / timeoutSeconds / retryCount /
 * onFailure / retryWhen / retryDelayMs / stageType）保留；每种 stageType 独占字段
 * （script / approverIds / approvalDescription / capabilityKey / capabilityParams /
 * webhookTag / imInputConfig / params）被清空，新类型按默认值注入。
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
    retryWhen: prev.retryWhen,
    retryDelayMs: prev.retryDelayMs,
  }
  // 所有独占字段先显式置 undefined，让浅合并能覆盖旧值；再按新 stageType 注入默认值
  const cleared: Partial<StageFields> = {
    script: undefined,
    approverIds: undefined,
    approvalDescription: undefined,
    capabilityKey: undefined,
    capabilityParams: undefined,
    webhookTag: undefined,
    imInputConfig: undefined,
    params: undefined,
  }
  switch (newType) {
    case 'script':
      return { ...base, ...cleared, script: '' }
    case 'approval':
      return { ...base, ...cleared, approverIds: [], approvalDescription: '' }
    case 'llm_agent':
      return { ...base, ...cleared, capabilityKey: '', capabilityParams: {} }
    case 'wait_webhook':
      return { ...base, ...cleared, webhookTag: '' }
    case 'im_input':
      return {
        ...base,
        ...cleared,
        imInputConfig: {
          prompt: '请提供以下参数：',
          paramSchema: { type: 'object', properties: {}, required: [] },
          timeoutSeconds: 600,
        },
      }
    // phase 3 新增 7 节点：统一用 params 容器，初始化为空对象，UI 按 paramSchema 渲染
    case 'http':
    case 'dm':
    case 'db_update':
    case 'sql_query':
    case 'file_read':
    case 'template_render':
    case 'fan_out':
      return { ...base, ...cleared, params: {} }
    // switch 节点：params 容器（cases + default 通过画布配置）
    case 'switch':
      return { ...base, ...cleared, params: { cases: [], default: undefined } }
  }
}

/**
 * 列出 prev 里已填、不属于 newType 独占字段的 field 名称（用于弹框提示）。
 */
export function obsoleteFieldsOnSwitch(prev: StageFields, newType: StageType): string[] {
  // 各类型独占字段；非 bespoke 类型共享同一个 params 容器
  const fieldsByType: Record<StageType, (keyof StageFields)[]> = {
    script: ['script'],
    approval: ['approverIds', 'approvalDescription'],
    llm_agent: ['capabilityKey', 'capabilityParams'],
    wait_webhook: ['webhookTag'],
    im_input: ['imInputConfig'],
    http: ['params'],
    dm: ['params'],
    db_update: ['params'],
    sql_query: ['params'],
    file_read: ['params'],
    template_render: ['params'],
    fan_out: ['params'],
    switch: ['params'],
  }
  const obsolete: string[] = []
  // 切到同类（bespoke ↔ bespoke 之外，dynamic ↔ dynamic 切换会保留 params? 不会 —— 切类型仍清空）
  // 简单处理：列出 prev 类型独占的、当前已填的字段；若 newType 与 prev 共享 params，仍提示 params 会被清
  for (const [type, fields] of Object.entries(fieldsByType) as [StageType, (keyof StageFields)[]][]) {
    if (type === newType) continue
    for (const f of fields) {
      if (!isEmpty(prev[f]) && !obsolete.includes(String(f))) obsolete.push(String(f))
    }
  }
  return obsolete
}

/** 仅在 NodeInspector 内部用，避免直接 import 到非画布代码 */
export function isBespokeStageType(t: StageType): boolean {
  return BESPOKE_STAGE_TYPES.has(t)
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  return false
}
