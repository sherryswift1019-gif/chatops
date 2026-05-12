import { z } from 'zod'
import { getConfig } from '../db/repositories/system-config.js'

const QiConfigSchema = z.object({
  aiReviewMaxRounds: z.number().int().min(1).max(5).catch(3).default(3),
  tokenBudgetPerRequirement: z.number().int().min(10000).catch(250000).default(250000),
})

export type QiConfig = z.infer<typeof QiConfigSchema>

export async function loadQiConfig(): Promise<QiConfig> {
  const entry = await getConfig('qi')
  const raw = (entry?.value ?? {}) as Record<string, unknown>

  // Pre-clamp out-of-range values before zod parses (zod .catch() fallbacks on type failure,
  // not range failure, so explicit clamp is needed to honour the "clamp, not reject" contract).
  const sanitized: Record<string, unknown> = { ...raw }
  if (typeof sanitized.aiReviewMaxRounds === 'number') {
    sanitized.aiReviewMaxRounds = Math.min(5, Math.max(1, sanitized.aiReviewMaxRounds))
  }
  if (
    typeof sanitized.tokenBudgetPerRequirement === 'number' &&
    sanitized.tokenBudgetPerRequirement < 10000
  ) {
    sanitized.tokenBudgetPerRequirement = 250000
  }

  return QiConfigSchema.parse(sanitized)
}
