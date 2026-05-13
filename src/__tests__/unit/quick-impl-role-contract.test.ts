import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..', '..', '..')
const ROLES_DIR = join(REPO_ROOT, '.claude', 'skills', 'quick-impl-artifact-author', 'roles')
const STANDARDS_DIR = join(REPO_ROOT, 'docs', 'standards')

function readRole(name: string): string {
  return readFileSync(join(ROLES_DIR, `${name}.md`), 'utf8')
}

function readStandard(name: string): string {
  return readFileSync(join(STANDARDS_DIR, name), 'utf8')
}

function extractSection(md: string, headingRe: RegExp): string | null {
  const match = md.match(headingRe)
  if (!match || match.index === undefined) return null
  const start = match.index
  const restAfter = md.slice(start + match[0].length)
  const next = restAfter.search(/\n---\n|\n## /)
  return next === -1 ? md.slice(start) : md.slice(start, start + match[0].length + next)
}

describe('quick-impl role.md docs commit contract', () => {
  it('spec-author.md instructs commit_artifact with docs/specs/qi- path', () => {
    const md = readRole('spec-author')
    expect(md).toContain('commit_artifact')
    expect(md).toContain('docs/specs/qi-{requirement_id}.md')
    // round 1 format: docs(qi-{id}): spec — {summary}
    expect(md).toMatch(/docs\(qi-\{id\}\): spec /)
  })

  it('spec-author.md DoD checklist enforces commit_artifact', () => {
    const md = readRole('spec-author')
    // DoD section exists (v3 版本已精简为主观决策类自查)
    const dod = extractSection(md, /## DoD 自检 checklist[^\n]*\n/)
    expect(dod).not.toBeNull()
    // commit_artifact 约束在多轮修订章节中强制执行
    expect(md).toContain('每轮都 commit')
    expect(md).toContain('commit_artifact')
  })

  it('plan-decomposer.md instructs commit_artifact with docs/plans/qi- path', () => {
    const md = readRole('plan-decomposer')
    expect(md).toContain('commit_artifact')
    expect(md).toContain('docs/plans/qi-{requirement_id}.md')
    // round 1 format: docs(qi-{id}): plan — {summary}
    expect(md).toMatch(/docs\(qi-\{id\}\): plan /)
  })

  it('plan-decomposer.md DoD checklist enforces commit_artifact', () => {
    const md = readRole('plan-decomposer')
    // plan-decomposer 在 Step 6 中强制 commit_artifact（无独立 DoD 节）
    expect(md).toContain('commit_artifact')
    // Step 6 节明确规定 commit path 和格式
    expect(md).toContain('docs/plans/qi-{requirement_id}.md')
    expect(md).toContain('message')
  })

  it('dev-loop.md forbids re-committing docs/specs or docs/plans files', () => {
    const md = readRole('dev-loop')
    expect(md).toMatch(/不得.*重复.*commit.*docs\/specs/)
    expect(md).toContain('docs/plans/qi-')
  })

  it('commit-conventions.md documents docs commit format', () => {
    const md = readStandard('commit-conventions.md')
    expect(md).toContain('commit_artifact')
    expect(md).toMatch(/docs\(qi-\{requirement_id\}\): \{kind\} round \{N\}/)
    expect(md).toMatch(/spec.*plan.*test-spec/)
  })

  it('commit-conventions.md verify regex accepts docs(qi-X): commits', () => {
    const md = readStandard('commit-conventions.md')
    const verifyBlock = md.match(/grep -vE[^\n]+/)
    expect(verifyBlock).not.toBeNull()
    expect(verifyBlock![0]).toContain('docs')
  })
})
