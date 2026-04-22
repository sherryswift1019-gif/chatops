import type { Capability } from '../db/repositories/capabilities.js'
import type { ProductLineCapability } from '../db/repositories/product-line-capabilities.js'

/**
 * Greet/help 列表过滤：选出当前用户在该产线下"能被 IM 触发"的能力。
 * 仅看 env_name='*' 的配置，env 特定配置不在 greet 场景参与决策。
 */
export function filterImTriggerableCapabilities(
  caps: Capability[],
  plCaps: ProductLineCapability[],
  userRole: string,
): Capability[] {
  const wildcardByKey = new Map<string, ProductLineCapability>()
  for (const p of plCaps) {
    if (p.envName === '*') wildcardByKey.set(p.capabilityKey, p)
  }
  return caps.filter(c => {
    const p = wildcardByKey.get(c.key)
    if (!p) return false
    if (!p.enabled) return false
    if (!p.allowedRoles.includes(userRole)) return false
    if (!p.triggerSources.includes('im')) return false
    return true
  })
}
