import { describe, it, expect } from 'vitest'
import { findProjectByName, findEnvByName } from '../../agent/tools/ssh-utils.js'

type P = { name: string; displayName: string; harborProject?: string | null }
type E = { name: string; displayName: string }

describe('findProjectByName', () => {
  const projects: P[] = [
    { name: 'web-terminal', displayName: 'Web Terminal', harborProject: 'chatops/web-terminal' },
    { name: 'pas-auth', displayName: 'PAS 认证', harborProject: 'chatops/pas-auth' },
    { name: 'api_gateway', displayName: 'API Gateway' },
  ]

  it('exact match on name', () => {
    expect(findProjectByName(projects, 'web-terminal')?.name).toBe('web-terminal')
  })

  it('exact match on displayName (Chinese)', () => {
    expect(findProjectByName(projects, 'PAS 认证')?.name).toBe('pas-auth')
  })

  it('exact match on harborProject', () => {
    expect(findProjectByName(projects, 'chatops/web-terminal')?.name).toBe('web-terminal')
  })

  it('fuzzy: case-insensitive', () => {
    expect(findProjectByName(projects, 'WEBTERMINAL')?.name).toBe('web-terminal')
  })

  it('fuzzy: drops hyphens (camelCase input)', () => {
    expect(findProjectByName(projects, 'WebTerminal')?.name).toBe('web-terminal')
  })

  it('fuzzy: swaps hyphen for underscore', () => {
    expect(findProjectByName(projects, 'web_terminal')?.name).toBe('web-terminal')
  })

  it('fuzzy: drops spaces', () => {
    expect(findProjectByName(projects, 'web terminal')?.name).toBe('web-terminal')
  })

  it('fuzzy: underscore ↔ hyphen on name', () => {
    expect(findProjectByName(projects, 'api-gateway')?.name).toBe('api_gateway')
  })

  it('returns undefined for empty input', () => {
    expect(findProjectByName(projects, '')).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(findProjectByName(projects, 'nonexistent-module')).toBeUndefined()
  })

  it('prefers exact match over fuzzy alternatives', () => {
    const list: P[] = [
      { name: 'exactname', displayName: 'A', harborProject: null },
      { name: 'exact-name', displayName: 'B', harborProject: null },
    ]
    expect(findProjectByName(list, 'exactname')?.displayName).toBe('A')
  })

  it('handles null harborProject', () => {
    const list: P[] = [{ name: 'solo', displayName: 'Solo', harborProject: null }]
    expect(findProjectByName(list, 'SOLO')?.name).toBe('solo')
  })
})

describe('findEnvByName', () => {
  const envs: E[] = [
    { name: 'dev', displayName: '开发' },
    { name: 'staging', displayName: 'Staging' },
  ]

  it('exact match on name', () => {
    expect(findEnvByName(envs, 'dev')?.name).toBe('dev')
  })

  it('exact match on Chinese displayName', () => {
    expect(findEnvByName(envs, '开发')?.name).toBe('dev')
  })

  it('fuzzy: case-insensitive', () => {
    expect(findEnvByName(envs, 'STAGING')?.name).toBe('staging')
  })

  it('returns undefined for empty input', () => {
    expect(findEnvByName(envs, '')).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(findEnvByName(envs, 'prod')).toBeUndefined()
  })
})
