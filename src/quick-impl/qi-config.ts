import { z } from 'zod'
import { getConfig } from '../db/repositories/system-config.js'

const AI_REVIEW_MAX_ROUNDS_DEFAULT = 3
const TOKEN_BUDGET_DEFAULT = 250000
const TOKEN_BUDGET_MIN = 10000

const QiConfigSchema = z.object({
  aiReviewMaxRounds: z.number().int().min(1).max(5)
    .catch(AI_REVIEW_MAX_ROUNDS_DEFAULT).default(AI_REVIEW_MAX_ROUNDS_DEFAULT),
  tokenBudgetPerRequirement: z.number().int().min(TOKEN_BUDGET_MIN)
    .catch(TOKEN_BUDGET_DEFAULT).default(TOKEN_BUDGET_DEFAULT),
})

export type QiConfig = z.infer<typeof QiConfigSchema>

export async function loadQiConfig(): Promise<QiConfig> {
  const entry = await getConfig('qi')
  const raw = (entry?.value ?? {}) as Record<string, unknown>

  // .catch() fires on type error, not range error — clamp manually
  const sanitized: Record<string, unknown> = { ...raw }
  if (typeof sanitized.aiReviewMaxRounds === 'number') {
    sanitized.aiReviewMaxRounds = Math.min(5, Math.max(1, sanitized.aiReviewMaxRounds))
  }
  if (typeof sanitized.tokenBudgetPerRequirement === 'number'
    && sanitized.tokenBudgetPerRequirement < TOKEN_BUDGET_MIN) {
    sanitized.tokenBudgetPerRequirement = TOKEN_BUDGET_MIN
  }

  return QiConfigSchema.parse(sanitized)
}
