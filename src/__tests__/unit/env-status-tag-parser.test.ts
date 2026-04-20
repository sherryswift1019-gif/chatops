import { describe, it, expect } from 'vitest'
import { parseImageTag, findDeployedTag } from '../../agent/tools/env-status/tag-parser.js'

describe('parseImageTag', () => {
  it('parses simple branch_shortId', () => {
    expect(parseImageTag('develop_a1b2c3d4')).toEqual({ branch: 'develop', shortId: 'a1b2c3d4' })
  })

  it('parses branch with underscores', () => {
    expect(parseImageTag('release_1.2_deadbeef')).toEqual({ branch: 'release_1.2', shortId: 'deadbeef' })
    expect(parseImageTag('feature_auth_v2_cafebabe')).toEqual({ branch: 'feature_auth_v2', shortId: 'cafebabe' })
  })

  it('rejects latest/prev/non-commit tags', () => {
    expect(parseImageTag('latest')).toBeNull()
    expect(parseImageTag('prev')).toBeNull()
    expect(parseImageTag('develop_XYZ12345')).toBeNull()  // non-hex
    expect(parseImageTag('develop_a1b2c3')).toBeNull()     // too short
    expect(parseImageTag('develop_a1b2c3d4e')).toBeNull()  // too long
  })
})

describe('findDeployedTag', () => {
  it('picks the {branch}_{hex8} tag from RepoTags', () => {
    const tags = [
      'harbor.example.com/proj/svc:latest',
      'harbor.example.com/proj/svc:prev',
      'harbor.example.com/proj/svc:develop_a1b2c3d4',
    ]
    expect(findDeployedTag(tags, 'harbor.example.com', 'proj/svc'))
      .toEqual({ branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' })
  })

  it('returns null when no commit-style tag exists', () => {
    const tags = ['harbor.example.com/proj/svc:latest', 'harbor.example.com/proj/svc:prev']
    expect(findDeployedTag(tags, 'harbor.example.com', 'proj/svc')).toBeNull()
  })

  it('ignores tags from other repositories', () => {
    const tags = [
      'harbor.example.com/other/svc:develop_11111111',
      'harbor.example.com/proj/svc:latest',
    ]
    expect(findDeployedTag(tags, 'harbor.example.com', 'proj/svc')).toBeNull()
  })
})
