import type { ArtifactInput } from '../../pipeline/types.js'

/**
 * A pipeline needs resolvable defaults when it can fire without an interactive
 * caller to provide runtimeVars. Two sources today:
 *   - `schedule` non-empty → cron fires it
 *   - `triggerParams.apiEnabled === true` → external systems (CI, webhook, etc.) trigger
 *     without passing runtimeVars
 */
function requiresAutoResolvable(pipeline: {
  schedule?: string
  triggerParams?: Record<string, unknown>
}): boolean {
  if (pipeline.schedule) return true
  if (pipeline.triggerParams && pipeline.triggerParams.apiEnabled === true) return true
  return false
}

export function validateArtifactInputsForTrigger(
  inputs: ArtifactInput[],
  pipeline: { schedule?: string; triggerParams?: Record<string, unknown> },
): void {
  if (!requiresAutoResolvable(pipeline)) return
  for (const input of inputs) {
    const hasDefault = !!input.default || !!input.defaultStrategy
    if (!hasDefault) {
      throw new Error(
        `制品输入「${input.name}」缺少 default 或 defaultStrategy，定时 / API 自动触发无法解析`,
      )
    }
  }
}

/**
 * Compute the effective pipeline state from a PUT body and existing DB row.
 * For each field, use body value if provided, otherwise fall back to existing.
 */
export function mergePipelineForValidation(
  body: { schedule?: string; artifactInputs?: ArtifactInput[]; triggerParams?: Record<string, unknown> },
  existing: { schedule: string; artifactInputs: unknown[]; triggerParams: Record<string, unknown> },
): { schedule: string; artifactInputs: ArtifactInput[]; triggerParams: Record<string, unknown> } {
  return {
    schedule: body.schedule !== undefined ? body.schedule : existing.schedule,
    artifactInputs: body.artifactInputs !== undefined
      ? body.artifactInputs
      : (existing.artifactInputs as ArtifactInput[]),
    triggerParams: body.triggerParams !== undefined ? body.triggerParams : existing.triggerParams,
  }
}
