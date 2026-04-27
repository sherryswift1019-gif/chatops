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
  const apiEnabled = { triggerParams: { apiEnabled: true } }

  it('passes when no artifactInputs', () => {
    expect(() => validateArtifactInputsForTrigger([], apiEnabled)).not.toThrow()
  })

  it('passes when pipeline is manual-only (no API)', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input()],
      { triggerParams: {} },
    )).not.toThrow()
  })

  it('requires default or defaultStrategy when apiEnabled', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input()],
      apiEnabled,
    )).toThrow(/default|defaultStrategy/)
  })

  it('ignores apiEnabled=false', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input()],
      { triggerParams: { apiEnabled: false } },
    )).not.toThrow()
  })

  it('ignores apiEnabled when not a boolean true', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input()],
      { triggerParams: { apiEnabled: 'yes' as unknown as boolean } },
    )).not.toThrow()
  })

  it('accepts defaultStrategy present', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input({ defaultStrategy: 'latest-by-mtime' })],
      apiEnabled,
    )).not.toThrow()
  })

  it('error message names the offending input', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input({ name: '选 PAM 包' })],
      apiEnabled,
    )).toThrow(/选 PAM 包/)
  })
})
