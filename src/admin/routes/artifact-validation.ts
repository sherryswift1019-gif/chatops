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
