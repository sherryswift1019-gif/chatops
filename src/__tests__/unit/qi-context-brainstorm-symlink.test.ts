import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { linkBrainstormArtifacts } from '../../pipeline/qi-context-helpers.js'

describe('linkBrainstormArtifacts', () => {
  let worktree: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'qi-ctx-'))
    mkdirSync(join(worktree, '.qi-context'), { recursive: true })
  })
  afterEach(() => { rmSync(worktree, { recursive: true, force: true }) })

  it('skips when brainstorm artifacts do not exist (forward-compatible)', async () => {
    await linkBrainstormArtifacts({ worktreePath: worktree, requirementId: 1 })
    expect(existsSync(join(worktree, '.qi-context/brainstorm.md'))).toBe(false)
    expect(existsSync(join(worktree, '.qi-context/enriched-input.json'))).toBe(false)
  })

  it('symlinks both files when they exist', async () => {
    mkdirSync(join(worktree, 'docs/brainstorm'), { recursive: true })
    writeFileSync(join(worktree, 'docs/brainstorm/qi-1.md'), '# brainstorm content')
    writeFileSync(join(worktree, 'docs/brainstorm/qi-1.json'),
      JSON.stringify({ schemaVersion: 'v1', rawInput: 'x' }))

    await linkBrainstormArtifacts({ worktreePath: worktree, requirementId: 1 })

    const md = readFileSync(join(worktree, '.qi-context/brainstorm.md'), 'utf-8')
    expect(md).toBe('# brainstorm content')
    const enriched = JSON.parse(readFileSync(join(worktree, '.qi-context/enriched-input.json'), 'utf-8'))
    expect(enriched.rawInput).toBe('x')
  })

  it('overwrites existing symlinks idempotently', async () => {
    mkdirSync(join(worktree, 'docs/brainstorm'), { recursive: true })
    writeFileSync(join(worktree, 'docs/brainstorm/qi-1.md'), 'v1')
    await linkBrainstormArtifacts({ worktreePath: worktree, requirementId: 1 })
    writeFileSync(join(worktree, 'docs/brainstorm/qi-1.md'), 'v2')
    await linkBrainstormArtifacts({ worktreePath: worktree, requirementId: 1 })
    expect(readFileSync(join(worktree, '.qi-context/brainstorm.md'), 'utf-8')).toBe('v2')
  })
})
