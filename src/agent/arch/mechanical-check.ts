/**
 * 架构文档机械校验
 * 遍历所有规则的 mechanicalCheck，汇总错误列表。
 */

import { ARCH_RULES, type ArchMechanicalError } from './rules.js'
import type { StructuredArch } from './structured-types.js'

export interface MechanicalCheckResult {
  passed: boolean
  blockers: ArchMechanicalError[]
  warnings: ArchMechanicalError[]
}

export function runMechanicalCheck(arch: StructuredArch): MechanicalCheckResult {
  const all: ArchMechanicalError[] = []

  for (const rule of ARCH_RULES) {
    if (rule.mechanicalCheck) {
      const errors = rule.mechanicalCheck(arch)
      all.push(...errors)
    }
  }

  const blockers = all.filter(e => e.severity === 'blocker')
  const warnings = all.filter(e => e.severity === 'warning')

  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
  }
}
