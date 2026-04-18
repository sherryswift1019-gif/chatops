import type { ArtifactInput } from '../../pipeline/types.js'

export function validateArtifactInputsForTrigger(
  inputs: ArtifactInput[],
  pipeline: { schedule?: string },
): void {
  const scheduled = !!pipeline.schedule
  if (!scheduled) return
  for (const input of inputs) {
    const hasDefault = !!input.default || !!input.defaultStrategy
    if (!hasDefault) {
      throw new Error(
        `制品输入「${input.name}」缺少 default 或 defaultStrategy，定时触发无法自动解析`,
      )
    }
  }
}

/**
 * Compute the effective pipeline state from a PUT body and existing DB row.
 * For each field, use body value if provided, otherwise fall back to existing.
 */
export function mergePipelineForValidation(
  body: { schedule?: string; artifactInputs?: ArtifactInput[] },
  existing: { schedule: string; artifactInputs: unknown[] },
): { schedule: string; artifactInputs: ArtifactInput[] } {
  return {
    schedule: body.schedule !== undefined ? body.schedule : existing.schedule,
    artifactInputs: body.artifactInputs !== undefined
      ? body.artifactInputs
      : (existing.artifactInputs as ArtifactInput[]),
  }
}
