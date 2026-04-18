import { describe, it, expect } from 'vitest'
import { validateArtifactInputsForTrigger } from '../../admin/routes/artifact-validation.js'
import type { ArtifactInput } from '../../pipeline/types.js'

function input(partial: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    name: 't', listUrl: 'http://x', glob: '*', outputVar: 'P', valueFrom: 'url',
    ...partial,
  }
}

describe('validateArtifactInputsForTrigger', () => {
  const scheduled = { schedule: '0 * * * *' }

  it('passes when no artifactInputs', () => {
    expect(() => validateArtifactInputsForTrigger([], scheduled)).not.toThrow()
  })

  it('passes when pipeline is manual-only (no schedule)', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input()],
      { schedule: '' },
    )).not.toThrow()
  })

  it('requires default or defaultStrategy when scheduled', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input()],
      scheduled,
    )).toThrow(/default|defaultStrategy/)
  })

  it('accepts default present', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input({ default: 'http://x' })],
      scheduled,
    )).not.toThrow()
  })

  it('accepts defaultStrategy present', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input({ defaultStrategy: 'latest-by-mtime' })],
      scheduled,
    )).not.toThrow()
  })

  it('error message names the offending input', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input({ name: '选 PAM 包' })],
      scheduled,
    )).toThrow(/选 PAM 包/)
  })
})
