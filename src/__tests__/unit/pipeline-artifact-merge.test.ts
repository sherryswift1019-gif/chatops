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
  it('uses body value when provided, existing otherwise (schedule)', () => {
    expect(mergePipelineForValidation(
      { schedule: '0 * * * *' },
      { schedule: '', artifactInputs: [] },
    ).schedule).toBe('0 * * * *')
    expect(mergePipelineForValidation(
      {},
      { schedule: '0 9 * * *', artifactInputs: [] },
    ).schedule).toBe('0 9 * * *')
  })

  it('uses body value when provided, existing otherwise (artifactInputs)', () => {
    const bodyInputs = [input({ name: 'from-body' })]
    const existingInputs = [input({ name: 'from-existing' })]
    expect(mergePipelineForValidation(
      { artifactInputs: bodyInputs },
      { schedule: '', artifactInputs: existingInputs },
    ).artifactInputs[0].name).toBe('from-body')
    expect(mergePipelineForValidation(
      {},
      { schedule: '', artifactInputs: existingInputs },
    ).artifactInputs[0].name).toBe('from-existing')
  })

  it('body schedule=empty overrides existing non-empty', () => {
    expect(mergePipelineForValidation(
      { schedule: '' },
      { schedule: '0 9 * * *', artifactInputs: [] },
    ).schedule).toBe('')
  })
})

describe('merge + validate integration: covers scenario A/B from review', () => {
  // Scenario A: existing is manual-only + artifactInputs without fallback;
  // body adds schedule. Must be rejected.
  it('A: adding schedule to pipeline with fallback-less inputs fails', () => {
    const merged = mergePipelineForValidation(
      { schedule: '0 * * * *' },
      { schedule: '', artifactInputs: [input()] },
    )
    expect(() => validateArtifactInputsForTrigger(merged.artifactInputs, merged))
      .toThrow(/default|defaultStrategy/)
  })

  // Scenario B: existing is scheduled with good inputs;
  // body replaces artifactInputs with fallback-less ones (no schedule field). Must be rejected.
  it('B: replacing artifactInputs on scheduled pipeline without fallbacks fails', () => {
    const merged = mergePipelineForValidation(
      { artifactInputs: [input()] },
      { schedule: '0 * * * *', artifactInputs: [input({ default: 'http://x' })] },
    )
    expect(() => validateArtifactInputsForTrigger(merged.artifactInputs, merged))
      .toThrow(/default|defaultStrategy/)
  })

  it('clearing schedule on existing scheduled pipeline allows fallback-less inputs', () => {
    const merged = mergePipelineForValidation(
      { schedule: '' },
      { schedule: '0 * * * *', artifactInputs: [input()] },
    )
    expect(() => validateArtifactInputsForTrigger(merged.artifactInputs, merged))
      .not.toThrow()
  })
})
