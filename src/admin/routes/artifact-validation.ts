import type { ArtifactInput } from '../../pipeline/types.js'

/**
 * A pipeline needs resolvable defaults when it can fire without an interactive
 * caller to provide runtimeVars. The current trigger source:
 *   - `triggerParams.apiEnabled === true` → external systems (CI, webhook, etc.) trigger
 *     without passing runtimeVars
 */
function requiresAutoResolvable(pipeline: {
  triggerParams?: Record<string, unknown>
}): boolean {
  if (pipeline.triggerParams && pipeline.triggerParams.apiEnabled === true) return true
  return false
}

export function validateArtifactInputsForTrigger(
  inputs: ArtifactInput[],
  pipeline: { triggerParams?: Record<string, unknown> },
): void {
  if (!requiresAutoResolvable(pipeline)) return
  for (const input of inputs) {
    const hasDefault = !!input.default || !!input.defaultStrategy
    if (!hasDefault) {
      throw new Error(
        `制品输入「${input.name}」缺少 default 或 defaultStrategy，API 自动触发无法解析`,
      )
    }
  }
}

/**
 * Compute the effective pipeline state from a PUT body and existing DB row.
 * For each field, use body value if provided, otherwise fall back to existing.
 */
export function mergePipelineForValidation(
  body: { artifactInputs?: ArtifactInput[]; triggerParams?: Record<string, unknown> },
  existing: { artifactInputs: unknown[]; triggerParams: Record<string, unknown> },
): { artifactInputs: ArtifactInput[]; triggerParams: Record<string, unknown> } {
  return {
    artifactInputs: body.artifactInputs !== undefined
      ? body.artifactInputs
      : (existing.artifactInputs as ArtifactInput[]),
    triggerParams: body.triggerParams !== undefined ? body.triggerParams : existing.triggerParams,
  }
}
