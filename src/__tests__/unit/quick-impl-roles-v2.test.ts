/**
 * Phase 1 v2 横切层单元测试。
 * 覆盖：role-manifest 加载/校验、resolveStandardsByManifest、feedback.md 渲染、
 *       diffAcceptanceCriteria、ensureWorktreeGitignore。
 *
 * stage_results 持久化由 quick-impl-stage-results.test.ts 覆盖（依赖 DB）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __setRepoRootForTesting,
  diffAcceptanceCriteria,
  ensureWorktreeGitignore,
  loadRoleManifest,
  prepareSkillContext,
  renderFeedbackMarkdown,
  resolveStandardsByManifest,
} from '../../quick-impl/skill-runner.js'

// =============================================================================
// fixtures: fake repo with .claude/skills/<skill>/role-manifest.json + docs/standards/
// =============================================================================

const FAKE_REPO = mkdtempSync(join(tmpdir(), 'qi-roles-v2-test-'))
const SKILL = 'test-skill'
const SKILL_DIR = join(FAKE_REPO, '.claude', 'skills', SKILL)
const ROLES_DIR = join(SKILL_DIR, 'roles')
const STANDARDS_DIR = join(FAKE_REPO, 'docs', 'standards')

beforeAll(() => {
  mkdirSync(ROLES_DIR, { recursive: true })
  mkdirSync(STANDARDS_DIR, { recursive: true })

  // 5 个 standards 文件
  for (const f of ['gitlab-config.md', 'tool-registration.md', 'commit-conventions.md', 'test-conventions.md', 'code-style.md']) {
    writeFileSync(join(STANDARDS_DIR, f), `# ${f}\n\nstub content`, 'utf8')
  }

  writeFileSync(join(SKILL_DIR, 'SKILL.md'), '# stub', 'utf8')
  writeFileSync(join(ROLES_DIR, 'spec-author.md'), '# spec-author stub', 'utf8')
  writeFileSync(join(ROLES_DIR, 'plan-decomposer.md'), '# plan-decomposer stub', 'utf8')

  __setRepoRootForTesting(FAKE_REPO)
})

afterAll(() => {
  __setRepoRootForTesting(null)
  rmSync(FAKE_REPO, { recursive: true, force: true })
})

// =============================================================================
// loadRoleManifest + zod 校验
// =============================================================================

describe('loadRoleManifest', () => {
  it('returns null when file missing', () => {
    expect(loadRoleManifest(SKILL)).toBeNull()
  })

  it('loads valid manifest and ignores _comment / $schema keys', () => {
    writeFileSync(
      join(SKILL_DIR, 'role-manifest.json'),
      JSON.stringify({
        $schema: './role-manifest.schema.json',
        _comment: 'doc string',
        'spec-author': { standards: ['gitlab-config.md'], inputs: ['rawInput'] },
        'plan-decomposer': { standards: ['*'], inputs: [] },
      }, null, 2),
    )
    const m = loadRoleManifest(SKILL)!
    expect(m).not.toBeNull()
    expect(Object.keys(m).sort()).toEqual(['plan-decomposer', 'spec-author'])
    expect(m['spec-author']!.standards).toEqual(['gitlab-config.md'])
    expect(m['plan-decomposer']!.standards).toEqual(['*'])
  })

  it('returns null when manifest references missing standard file', () => {
    writeFileSync(
      join(SKILL_DIR, 'role-manifest.json'),
      JSON.stringify({
        'spec-author': { standards: ['nonexistent.md'], inputs: [] },
      }),
    )
    expect(loadRoleManifest(SKILL)).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    writeFileSync(join(SKILL_DIR, 'role-manifest.json'), 'not json{')
    expect(loadRoleManifest(SKILL)).toBeNull()
  })
})

// =============================================================================
// resolveStandardsByManifest
// =============================================================================

describe('resolveStandardsByManifest', () => {
  it('returns [] when manifest is null', () => {
    expect(resolveStandardsByManifest(null, 'spec-author')).toEqual([])
  })

  it('returns specified subset', () => {
    const manifest = {
      'spec-author': { standards: ['gitlab-config.md', 'commit-conventions.md'], inputs: [] },
    }
    const paths = resolveStandardsByManifest(manifest, 'spec-author')
    expect(paths).toHaveLength(2)
    expect(paths.every((p) => p.endsWith('.md'))).toBe(true)
    expect(paths.some((p) => p.endsWith('gitlab-config.md'))).toBe(true)
    expect(paths.some((p) => p.endsWith('commit-conventions.md'))).toBe(true)
  })

  it('expands "*" to all .md files in docs/standards/', () => {
    const manifest = { 'dev-loop': { standards: ['*'], inputs: [] } }
    const paths = resolveStandardsByManifest(manifest, 'dev-loop')
    expect(paths).toHaveLength(5) // 5 个 fixture standards
  })

  it('returns [] for unknown role', () => {
    const manifest = { 'spec-author': { standards: ['*'], inputs: [] } }
    expect(resolveStandardsByManifest(manifest, 'unknown-role')).toEqual([])
  })
})

// =============================================================================
// prepareSkillContext: manifest 子集 symlink + inputs 过滤
// =============================================================================

describe('prepareSkillContext with manifest', () => {
  it('symlinks only manifest subset (spec-author = 1 file)', () => {
    writeFileSync(
      join(SKILL_DIR, 'role-manifest.json'),
      JSON.stringify({
        'spec-author': { standards: ['gitlab-config.md'], inputs: ['rawInput'] },
      }),
    )
    const wt = mkdtempSync(join(tmpdir(), 'qi-prep-wt-'))
    prepareSkillContext({
      worktreePath: wt,
      requirementId: 1,
      branch: 'b',
      baseBranch: 'main',
      artifactPath: join(wt, 'spec.md'),
      roleContent: 'role',
      inputs: { rawInput: 'foo', extra: 'bar' },
      skill: SKILL,
      role: 'spec-author',
    })
    const standardsDir = join(wt, '.qi-context', 'standards')
    expect(existsSync(standardsDir)).toBe(true)
    expect(existsSync(join(standardsDir, 'gitlab-config.md'))).toBe(true)
    expect(existsSync(join(standardsDir, 'tool-registration.md'))).toBe(false) // 不在子集

    // inputs 过滤：extra 不在 manifest.inputs 应该被剔除
    const inputsJson = JSON.parse(readFileSync(join(wt, '.qi-context', 'inputs.json'), 'utf8'))
    expect(inputsJson.inputs.rawInput).toBe('foo')
    expect(inputsJson.inputs.extra).toBeUndefined()

    rmSync(wt, { recursive: true, force: true })
  })

  it('does not filter inputs when manifest entry has empty inputs []', () => {
    writeFileSync(
      join(SKILL_DIR, 'role-manifest.json'),
      JSON.stringify({
        'spec-author': { standards: ['*'], inputs: [] },
      }),
    )
    const wt = mkdtempSync(join(tmpdir(), 'qi-prep-wt-'))
    prepareSkillContext({
      worktreePath: wt,
      requirementId: 1,
      branch: 'b',
      baseBranch: 'main',
      artifactPath: join(wt, 'spec.md'),
      roleContent: 'role',
      inputs: { rawInput: 'foo', extra: 'bar' },
      skill: SKILL,
      role: 'spec-author',
    })
    const inputsJson = JSON.parse(readFileSync(join(wt, '.qi-context', 'inputs.json'), 'utf8'))
    expect(inputsJson.inputs.rawInput).toBe('foo')
    expect(inputsJson.inputs.extra).toBe('bar') // 不过滤
    rmSync(wt, { recursive: true, force: true })
  })

  it('writes feedback.md when previousRound provided', () => {
    const wt = mkdtempSync(join(tmpdir(), 'qi-prep-wt-'))
    prepareSkillContext({
      worktreePath: wt,
      requirementId: 1,
      branch: 'b',
      baseBranch: 'main',
      artifactPath: join(wt, 'spec.md'),
      roleContent: 'role',
      inputs: {},
      previousRound: {
        round: 1,
        decision: 'rejected',
        rejectReason: 'AC 不够具体',
        reviewerNotes: [{ severity: 'error', msg: 'foo', file: 'src/a.ts' }],
        decidedBy: '张三',
        decidedAt: '2026-05-08T10:00:00Z',
      },
    })
    const fb = readFileSync(join(wt, '.qi-context', 'feedback.md'), 'utf8')
    expect(fb).toContain('Round 1 → Round 2')
    expect(fb).toContain('AC 不够具体')
    expect(fb).toContain('error: foo (src/a.ts)')
    expect(fb).toContain('张三')

    // inputs.previousRound 也应序列化进 inputs.json
    const inputsJson = JSON.parse(readFileSync(join(wt, '.qi-context', 'inputs.json'), 'utf8'))
    expect(inputsJson.previousRound.round).toBe(1)
    expect(inputsJson.previousRound.rejectReason).toBe('AC 不够具体')

    rmSync(wt, { recursive: true, force: true })
  })

  it('does not write feedback.md when no previousRound', () => {
    const wt = mkdtempSync(join(tmpdir(), 'qi-prep-wt-'))
    prepareSkillContext({
      worktreePath: wt,
      requirementId: 1,
      branch: 'b',
      baseBranch: 'main',
      artifactPath: join(wt, 'spec.md'),
      roleContent: 'role',
      inputs: {},
    })
    expect(existsSync(join(wt, '.qi-context', 'feedback.md'))).toBe(false)
    rmSync(wt, { recursive: true, force: true })
  })
})

// =============================================================================
// ensureWorktreeGitignore
// =============================================================================

describe('ensureWorktreeGitignore', () => {
  it('creates .gitignore with .qi-context/ when none exists', () => {
    const wt = mkdtempSync(join(tmpdir(), 'qi-gitig-wt-'))
    ensureWorktreeGitignore(wt)
    const content = readFileSync(join(wt, '.gitignore'), 'utf8')
    expect(content).toMatch(/\.qi-context\/$/m)
    rmSync(wt, { recursive: true, force: true })
  })

  it('appends .qi-context/ to existing .gitignore', () => {
    const wt = mkdtempSync(join(tmpdir(), 'qi-gitig-wt-'))
    writeFileSync(join(wt, '.gitignore'), 'node_modules/\ndist/\n', 'utf8')
    ensureWorktreeGitignore(wt)
    const content = readFileSync(join(wt, '.gitignore'), 'utf8')
    expect(content).toContain('node_modules/')
    expect(content).toContain('.qi-context/')
    rmSync(wt, { recursive: true, force: true })
  })

  it('does not duplicate when already present', () => {
    const wt = mkdtempSync(join(tmpdir(), 'qi-gitig-wt-'))
    writeFileSync(join(wt, '.gitignore'), 'node_modules/\n.qi-context/\n', 'utf8')
    ensureWorktreeGitignore(wt)
    ensureWorktreeGitignore(wt) // call twice
    const content = readFileSync(join(wt, '.gitignore'), 'utf8')
    const matches = content.match(/\.qi-context\//g) ?? []
    expect(matches).toHaveLength(1)
    rmSync(wt, { recursive: true, force: true })
  })

  it('handles trailing-newline absent', () => {
    const wt = mkdtempSync(join(tmpdir(), 'qi-gitig-wt-'))
    writeFileSync(join(wt, '.gitignore'), 'node_modules/', 'utf8') // no trailing \n
    ensureWorktreeGitignore(wt)
    const content = readFileSync(join(wt, '.gitignore'), 'utf8')
    expect(content).toMatch(/node_modules\/\n\.qi-context\/\n/)
    rmSync(wt, { recursive: true, force: true })
  })
})

// =============================================================================
// renderFeedbackMarkdown
// =============================================================================

describe('renderFeedbackMarkdown', () => {
  it('renders all sections', () => {
    const md = renderFeedbackMarkdown({
      round: 2,
      decision: 'rejected',
      rejectReason: 'foo',
      reviewerNotes: [{ severity: 'error', msg: 'bar', file: 'a.ts' }],
      previousArtifactPath: '/x/spec.md',
      previousCommits: ['abc123', 'def456'],
      acDiff: {
        added: [{ id: 'AC-4', text: 'new ac' }],
        removed: ['AC-3'],
        changed: [{ id: 'AC-1', oldText: 'old', newText: 'new' }],
      },
      decidedBy: '李四',
    })
    expect(md).toContain('Round 2 → Round 3')
    expect(md).toContain('rejected by 李四')
    expect(md).toContain('foo')
    expect(md).toContain('error: bar (a.ts)')
    expect(md).toContain('AC-4: new ac')
    expect(md).toContain('AC-3') // removed
    expect(md).toContain('旧: old')
    expect(md).toContain('新: new')
    expect(md).toContain('/x/spec.md')
    expect(md).toContain('abc123')
    expect(md).toContain('本轮要求')
  })

  it('omits sections that are empty', () => {
    const md = renderFeedbackMarkdown({ round: 1, decision: 'fail' })
    expect(md).toContain('Round 1 → Round 2')
    expect(md).not.toContain('## 拒绝原因')
    expect(md).not.toContain('## Reviewer 标记')
    expect(md).not.toContain('## AC 变化')
  })
})

// =============================================================================
// diffAcceptanceCriteria
// =============================================================================

describe('diffAcceptanceCriteria', () => {
  it('detects added / removed / changed', () => {
    const diff = diffAcceptanceCriteria(
      [
        { id: 'AC-1', text: 'old text' },
        { id: 'AC-2', text: 'unchanged' },
        { id: 'AC-3', text: 'will be removed' },
      ],
      [
        { id: 'AC-1', text: 'new text' }, // changed
        { id: 'AC-2', text: 'unchanged' }, // same
        { id: 'AC-4', text: 'new added' }, // added
      ],
    )
    expect(diff.added).toEqual([{ id: 'AC-4', text: 'new added' }])
    expect(diff.removed).toEqual(['AC-3'])
    expect(diff.changed).toEqual([{ id: 'AC-1', oldText: 'old text', newText: 'new text' }])
  })

  it('returns empty diff when identical', () => {
    const ac = [{ id: 'AC-1', text: 'foo' }]
    const diff = diffAcceptanceCriteria(ac, ac)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
  })

  it('handles undefined inputs', () => {
    const diff = diffAcceptanceCriteria(undefined, [{ id: 'AC-1', text: 'a' }])
    expect(diff.added).toEqual([{ id: 'AC-1', text: 'a' }])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
  })
})
