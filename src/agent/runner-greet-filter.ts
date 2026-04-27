import type { IMTrigger } from '../db/repositories/im-triggers.js'
import type { ProductLineIMTrigger } from '../db/repositories/product-line-im-triggers.js'

/**
 * Greet/help 列表过滤：选出当前用户在该产线下"能被 IM 触发"的入口。
 * 仅看 env_name='*' 的配置，env 特定配置不在 greet 场景参与决策。
 *
 * phase 2 起,IM 入口配置从 product_line_im_triggers 读取(不再 product_line_capabilities)。
 */
export function filterImTriggerableTriggers(
  triggers: IMTrigger[],
  plTriggers: ProductLineIMTrigger[],
  userRole: string,
): IMTrigger[] {
  const wildcardByKey = new Map<string, ProductLineIMTrigger>()
  for (const p of plTriggers) {
    if (p.envName === '*') wildcardByKey.set(p.imTriggerKey, p)
  }
  return triggers.filter(t => {
    if (!t.enabled) return false
    const p = wildcardByKey.get(t.key)
    if (!p) return false
    if (!p.enabled) return false
    if (!p.allowedRoles.includes(userRole)) return false
    if (!p.triggerSources.includes('im')) return false
    return true
  })
}
