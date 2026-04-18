import type { TriggerResult } from '../coordinator.js'

const MAX_RETRIES = 3

export interface RetryContext {
  issueId: number
  level: string
  attempt: number
  lastError?: string
}

export type FixAttempt = (ctx: RetryContext) => Promise<TriggerResult>

export async function retryWithDowngrade(
  issueId: number,
  level: string,
  fixAttempt: FixAttempt,
  onDowngrade: (ctx: RetryContext) => Promise<void>,
): Promise<TriggerResult> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ctx: RetryContext = { issueId, level, attempt }

    console.log(`[FixAgent] attempt ${attempt}/${MAX_RETRIES} for issue #${issueId} (${level})`)

    const result = await fixAttempt(ctx)

    if (result.success) {
      console.log(`[FixAgent] issue #${issueId} fixed on attempt ${attempt}`)
      return result
    }

    ctx.lastError = result.error ?? result.output
    console.warn(`[FixAgent] attempt ${attempt} failed: ${ctx.lastError?.substring(0, 200)}`)

    if (attempt < MAX_RETRIES) {
      console.log(`[FixAgent] will retry (${attempt + 1}/${MAX_RETRIES})`)
    }
  }

  // 3 次全部失败 → 自动降级
  console.warn(`[FixAgent] all ${MAX_RETRIES} attempts failed for issue #${issueId}, triggering downgrade`)

  const downgradeCtx: RetryContext = { issueId, level, attempt: MAX_RETRIES, lastError: 'max retries exceeded' }
  await onDowngrade(downgradeCtx)

  return {
    success: false,
    error: `修复失败 ${MAX_RETRIES} 次，已自动降级为 L3（needs-manual）。fix 分支已保留。`,
  }
}
