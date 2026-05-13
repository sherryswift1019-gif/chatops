import { z } from 'zod'
import { getConfig } from '../db/repositories/system-config.js'
import { getPool } from '../db/client.js'

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

export function checkTokenBudget(args: {
  usedTokens: number
  budget: number
}): { ok: boolean; usedTokens: number; budget: number } {
  return {
    ok: args.usedTokens < args.budget,
    usedTokens: args.usedTokens,
    budget: args.budget,
  }
}

export async function getCumulativeTokenUsage(pipelineRunId: number): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM((data->>'token_total')::int), 0)::text AS total
     FROM pipeline_run_state WHERE pipeline_run_id = $1`,
    [pipelineRunId],
  )
  return Number(rows[0]?.total ?? 0)
}
