import { describe, it, expect } from 'vitest'
import { mergePipelineForValidation, validateArtifactInputsForTrigger } from '../../admin/routes/artifact-validation.js'
import type { ArtifactInput } from '../../pipeline/types.js'

function input(partial: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    name: 't', listUrl: 'http://x', glob: '*', outputVar: 'P', valueFrom: 'url',
    ...partial,
  }
}

describe('mergePipelineForValidation', () => {
  it('uses body value when provided, existing otherwise (artifactInputs)', () => {
    const bodyInputs = [input({ name: 'from-body' })]
    const existingInputs = [input({ name: 'from-existing' })]
    expect(mergePipelineForValidation(
      { artifactInputs: bodyInputs },
      { artifactInputs: existingInputs, triggerParams: {} },
    ).artifactInputs[0].name).toBe('from-body')
    expect(mergePipelineForValidation(
      {},
      { artifactInputs: existingInputs, triggerParams: {} },
    ).artifactInputs[0].name).toBe('from-existing')
  })

  it('merges triggerParams', () => {
    expect(mergePipelineForValidation(
      { triggerParams: { apiEnabled: true } },
      { artifactInputs: [], triggerParams: {} },
    ).triggerParams).toEqual({ apiEnabled: true })
    expect(mergePipelineForValidation(
      {},
      { artifactInputs: [], triggerParams: { apiEnabled: true } },
    ).triggerParams).toEqual({ apiEnabled: true })
  })
})

describe('merge + validate integration: covers scenario A/B from review', () => {
  // Scenario C: existing has apiEnabled; body replaces inputs without fallbacks. Must be rejected.
  it('C: replacing inputs on api-enabled pipeline without fallbacks fails', () => {
    const merged = mergePipelineForValidation(
      { artifactInputs: [input()] },
      { artifactInputs: [], triggerParams: { apiEnabled: true } },
    )
    expect(() => validateArtifactInputsForTrigger(merged.artifactInputs, merged))
      .toThrow(/default|defaultStrategy/)
  })

  it('manual-only pipeline allows fallback-less inputs', () => {
    const merged = mergePipelineForValidation(
      { artifactInputs: [input()] },
      { artifactInputs: [], triggerParams: {} },
    )
    expect(() => validateArtifactInputsForTrigger(merged.artifactInputs, merged))
      .not.toThrow()
  })
})
