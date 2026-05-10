import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __setRepoRootForTesting,
  defaultMcpServerPath,
  loadRole,
  loadSkill,
  parseSkillOutput,
  prepareSkillContext,
  resolveRolePath,
  resolveSkillPath,
  runSkill,
  SkillExecutor,
  SkillNotFoundError,
  SkillOutputParseError,
} from '../../quick-impl/skill-runner.js'

// =============================================================================
// fixtures: fake repo with .claude/skills/test-skill/
// =============================================================================

const FAKE_REPO = mkdtempSync(join(tmpdir(), 'qi-skill-test-'))
const SKILL_DIR = join(FAKE_REPO, '.claude', 'skills', 'test-skill')
const ROLES_DIR = join(SKILL_DIR, 'roles')

beforeAll(() => {
  mkdirSync(ROLES_DIR, { recursive: true })
  writeFileSync(
    join(SKILL_DIR, 'SKILL.md'),
    [
      '---',
      'name: test-skill',
      '---',
      '# 底座契约',
      '1. 输入读 .qi-context/inputs.json',
      '2. 输出 ```json``` block',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(ROLES_DIR, 'spec-author.md'),
    '# Role: spec-author\n按 inputs 写 spec.md。',
    'utf8',
  )
  writeFileSync(
    join(ROLES_DIR, 'reviewer.md'),
    '# Role: reviewer\n输出 decision pass/fail + notes。',
    'utf8',
  )
  __setRepoRootForTesting(FAKE_REPO)
})

afterAll(() => {
  __setRepoRootForTesting(null)
  rmSync(FAKE_REPO, { recursive: true, force: true })
})

// =============================================================================
// resolveSkillPath / loadSkill
// =============================================================================

describe('skill file resolution', () => {
  it('resolveSkillPath finds repo skill', () => {
    expect(resolveSkillPath('test-skill')).toBe(join(SKILL_DIR, 'SKILL.md'))
  })

  it('resolveRolePath finds role manifest', () => {
    expect(resolveRolePath('test-skill', 'spec-author')).toBe(
      join(ROLES_DIR, 'spec-author.md'),
    )
  })

  it('throws SkillNotFoundError for missing skill', () => {
    expect(() => resolveSkillPath('nonexistent-skill')).toThrow(
      SkillNotFoundError,
    )
  })

  it('throws SkillNotFoundError for missing role', () => {
    expect(() => resolveRolePath('test-skill', 'nope')).toThrow(
      SkillNotFoundError,
    )
  })

  it('loadSkill returns content', () => {
    expect(loadSkill('test-skill')).toContain('# 底座契约')
  })

  it('loadRole returns content', () => {
    expect(loadRole('test-skill', 'reviewer')).toContain('reviewer')
  })
})

// =============================================================================
// parseSkillOutput
// =============================================================================

describe('parseSkillOutput', () => {
  it('extracts last fenced ```json``` block', () => {
    const text = [
      '正在分析需求...',
      '```json',
      '{"summary": "early version"}',
      '```',
      '修订后：',
      '```json',
      '{"summary": "final version"}',
      '```',
    ].join('\n')
    const out = parseSkillOutput(text)
    expect(out.summary).toBe('final version')
  })

  it('falls back to balanced { ... } when no fence', () => {
    const text =
      '完成。最终结果：{ "summary": "no fence here", "decision": "pass" }'
    const out = parseSkillOutput(text)
    expect(out.summary).toBe('no fence here')
    expect(out.decision).toBe('pass')
  })

  it('throws no_match when no JSON found', () => {
    expect(() =>
      parseSkillOutput('一段纯文本，没有 JSON 内容'),
    ).toThrow(SkillOutputParseError)

    try {
      parseSkillOutput('plain text only')
    } catch (err) {
      expect(err).toBeInstanceOf(SkillOutputParseError)
      expect((err as SkillOutputParseError).stage).toBe('no_match')
    }
  })

  it('throws json_parse for malformed JSON', () => {
    try {
      parseSkillOutput('```json\n{not valid json\n```')
    } catch (err) {
      expect(err).toBeInstanceOf(SkillOutputParseError)
      expect((err as SkillOutputParseError).stage).toBe('json_parse')
    }
  })

  it('throws schema for valid JSON missing required fields', () => {
    try {
      parseSkillOutput('```json\n{"foo": "bar"}\n```')
    } catch (err) {
      expect(err).toBeInstanceOf(SkillOutputParseError)
      expect((err as SkillOutputParseError).stage).toBe('schema')
    }
  })

  it('accepts reviewer JSON with notes array', () => {
    const text =
      '```json\n' +
      JSON.stringify({
        summary: 'review done',
        decision: 'fail',
        notes: [
          { severity: 'error', msg: 'missing test', file: 'src/foo.ts', line: 12 },
          { severity: 'warn', msg: 'naming unclear' },
        ],
      }) +
      '\n```'
    const out = parseSkillOutput(text)
    expect(out.decision).toBe('fail')
    expect(out.notes).toHaveLength(2)
    expect(out.notes![0]!.severity).toBe('error')
  })

  it('accepts dev-loop JSON with tasksDone array', () => {
    const text =
      '```json\n' +
      JSON.stringify({ summary: 'all done', tasksDone: [0, 1, 2] }) +
      '\n```'
    const out = parseSkillOutput(text)
    expect(out.tasksDone).toEqual([0, 1, 2])
  })

  it('rejects oversized summary', () => {
    const long = 'a'.repeat(600)
    try {
      parseSkillOutput('```json\n' + JSON.stringify({ summary: long }) + '\n```')
    } catch (err) {
      expect(err).toBeInstanceOf(SkillOutputParseError)
      expect((err as SkillOutputParseError).stage).toBe('schema')
    }
  })
})

// =============================================================================
// prepareSkillContext
// =============================================================================

describe('prepareSkillContext', () => {
  let WT: string

  beforeEach(() => {
    WT = mkdtempSync(join(tmpdir(), 'qi-ctx-test-wt-'))
  })

  it('writes role.md and inputs.json with required fields', () => {
    prepareSkillContext({
      worktreePath: WT,
      requirementId: 5,
      branch: 'feat/qi-5',
      baseBranch: 'main',
      artifactPath: 'docs/specs/qi-5.md',
      roleContent: '# spec-author role',
      inputs: { rawInput: '新增登录页', rejectHistory: [] },
    })

    const ctxDir = join(WT, '.qi-context')
    expect(existsSync(ctxDir)).toBe(true)
    expect(readFileSync(join(ctxDir, 'role.md'), 'utf8')).toBe('# spec-author role')

    const inputs = JSON.parse(readFileSync(join(ctxDir, 'inputs.json'), 'utf8'))
    expect(inputs.requirement_id).toBe(5)
    expect(inputs.worktree_path).toBe(WT)
    expect(inputs.branch).toBe('feat/qi-5')
    expect(inputs.base_branch).toBe('main')
    expect(inputs.artifact_path).toBe('docs/specs/qi-5.md')
    expect(inputs.inputs.rawInput).toBe('新增登录页')
  })

  it('preserves retry_counters with dev_completed_tasks', () => {
    prepareSkillContext({
      worktreePath: WT,
      requirementId: 5,
      branch: 'feat/qi-5',
      baseBranch: 'main',
      artifactPath: 'src/x.ts',
      roleContent: 'r',
      inputs: {},
      retryCounters: { dev_completed_tasks: [0, 1], spec_rounds: 2 },
    })
    const inputs = JSON.parse(
      readFileSync(join(WT, '.qi-context', 'inputs.json'), 'utf8'),
    )
    expect(inputs.retry_counters.dev_completed_tasks).toEqual([0, 1])
    expect(inputs.retry_counters.spec_rounds).toBe(2)
  })

  it('clears existing .qi-context before write', () => {
    const ctxDir = join(WT, '.qi-context')
    mkdirSync(ctxDir, { recursive: true })
    writeFileSync(join(ctxDir, 'stale.txt'), 'leftover')

    prepareSkillContext({
      worktreePath: WT,
      requirementId: 5,
      branch: 'feat/qi-5',
      baseBranch: 'main',
      artifactPath: 'x.md',
      roleContent: 'r',
      inputs: {},
    })

    expect(existsSync(join(ctxDir, 'stale.txt'))).toBe(false)
    expect(existsSync(join(ctxDir, 'role.md'))).toBe(true)
  })

  it('symlinks specSources to standards/', () => {
    const standardsSource = mkdtempSync(join(tmpdir(), 'qi-stds-'))
    const stdFile = join(standardsSource, 'CLAUDE.md')
    writeFileSync(stdFile, '# standards content')

    prepareSkillContext({
      worktreePath: WT,
      requirementId: 5,
      branch: 'feat/qi-5',
      baseBranch: 'main',
      artifactPath: 'x.md',
      roleContent: 'r',
      inputs: {},
      specSources: [stdFile],
    })

    const standardsDir = join(WT, '.qi-context', 'standards')
    expect(existsSync(standardsDir)).toBe(true)
    expect(existsSync(join(standardsDir, 'CLAUDE.md'))).toBe(true)
    expect(readFileSync(join(standardsDir, 'CLAUDE.md'), 'utf8')).toContain(
      'standards content',
    )

    rmSync(standardsSource, { recursive: true, force: true })
  })

  it('rejects path traversal in specSources', () => {
    expect(() =>
      prepareSkillContext({
        worktreePath: WT,
        requirementId: 5,
        branch: 'feat/qi-5',
        baseBranch: 'main',
        artifactPath: 'x.md',
        roleContent: 'r',
        inputs: {},
        specSources: ['/etc/passwd'],
      }),
    ).toThrow(/rejected for safety/)
  })

  it('rejects relative paths in specSources', () => {
    expect(() =>
      prepareSkillContext({
        worktreePath: WT,
        requirementId: 5,
        branch: 'feat/qi-5',
        baseBranch: 'main',
        artifactPath: 'x.md',
        roleContent: 'r',
        inputs: {},
        specSources: ['./not-absolute.md'],
      }),
    ).toThrow(/absolute path/)
  })

  it('silently skips nonexistent specSources', () => {
    expect(() =>
      prepareSkillContext({
        worktreePath: WT,
        requirementId: 5,
        branch: 'feat/qi-5',
        baseBranch: 'main',
        artifactPath: 'x.md',
        roleContent: 'r',
        inputs: {},
        specSources: ['/tmp/this-does-not-exist-' + Date.now() + '.md'],
      }),
    ).not.toThrow()
  })
})

// =============================================================================
// runSkill (end-to-end with fake executor)
// =============================================================================

describe('runSkill', () => {
  let WT: string

  beforeEach(() => {
    WT = mkdtempSync(join(tmpdir(), 'qi-run-skill-wt-'))
  })

  function makeFakeExecutor(scripted: {
    rawOutput: string
    inputTokens?: number
    outputTokens?: number
    durationMs?: number
    errorMessage?: string
  }): SkillExecutor & { calls: Array<Parameters<SkillExecutor['execute']>[0]> } {
    const calls: Array<Parameters<SkillExecutor['execute']>[0]> = []
    const fake: SkillExecutor & {
      calls: Array<Parameters<SkillExecutor['execute']>[0]>
    } = {
      calls,
      async execute(opts) {
        calls.push(opts)
        return {
          rawOutput: scripted.rawOutput,
          inputTokens: scripted.inputTokens,
          outputTokens: scripted.outputTokens,
          durationMs: scripted.durationMs,
          errorMessage: scripted.errorMessage ?? null,
        }
      },
    }
    return fake
  }

  it('happy path: loads skill+role, prepares context, runs executor, parses JSON', async () => {
    const fake = makeFakeExecutor({
      rawOutput:
        '我已经完成了 spec 草稿。\n\n```json\n' +
        JSON.stringify({ summary: 'spec drafted' }) +
        '\n```',
      inputTokens: 1234,
      outputTokens: 567,
      durationMs: 12345,
    })

    const result = await runSkill(
      {
        requirementId: 7,
        nodeId: 'spec_review_loop',
        skill: 'test-skill',
        role: 'spec-author',
        worktreePath: WT,
        branch: 'feat/qi-7',
        baseBranch: 'main',
        artifactPath: 'docs/specs/qi-7.md',
        inputs: { rawInput: '新需求' },
      },
      fake,
    )

    expect(result.output.summary).toBe('spec drafted')
    expect(result.inputTokens).toBe(1234)
    expect(result.outputTokens).toBe(567)
    expect(result.durationMs).toBe(12345)

    // executor 收到的参数验证
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]!
    expect(call.cwd).toBe(WT)
    expect(call.env.QI_REQUIREMENT_ID).toBe('7')
    expect(call.env.QI_NODE_ID).toBe('spec_review_loop')
    expect(call.systemPrompt).toContain('# 底座契约')
    expect(call.systemPrompt).toContain('spec-author')
    expect(call.prompt).toContain('quick-impl 节点：spec_review_loop')

    // .qi-context 已经被写
    expect(existsSync(join(WT, '.qi-context', 'role.md'))).toBe(true)
    expect(existsSync(join(WT, '.qi-context', 'inputs.json'))).toBe(true)
  })

  it('throws SkillOutputParseError when output missing JSON', async () => {
    const fake = makeFakeExecutor({
      rawOutput: '我做完了，但是忘记输出 JSON 了。',
    })

    await expect(
      runSkill(
        {
          requirementId: 8,
          nodeId: 'plan_author',
          skill: 'test-skill',
          role: 'spec-author',
          worktreePath: WT,
          branch: 'feat/qi-8',
          baseBranch: 'main',
          artifactPath: 'plan.md',
          inputs: {},
        },
        fake,
      ),
    ).rejects.toBeInstanceOf(SkillOutputParseError)
  })

  it('attaches last 500 chars of raw output to parse error message', async () => {
    const big = 'noise '.repeat(200)
    const fake = makeFakeExecutor({ rawOutput: big })
    try {
      await runSkill(
        {
          requirementId: 9,
          nodeId: 'x',
          skill: 'test-skill',
          role: 'spec-author',
          worktreePath: WT,
          branch: 'feat/qi-9',
          baseBranch: 'main',
          artifactPath: 'x.md',
          inputs: {},
        },
        fake,
      )
    } catch (err) {
      expect((err as Error).message).toContain('raw output')
    }
  })

  it('throws when executor reports errorMessage', async () => {
    const fake = makeFakeExecutor({
      rawOutput: '',
      errorMessage: 'timeout after 1800000ms',
    })
    await expect(
      runSkill(
        {
          requirementId: 10,
          nodeId: 'x',
          skill: 'test-skill',
          role: 'spec-author',
          worktreePath: WT,
          branch: 'feat/qi-10',
          baseBranch: 'main',
          artifactPath: 'x.md',
          inputs: {},
        },
        fake,
      ),
    ).rejects.toThrow(/executor error/)
  })

  it('passes maxTurns / timeoutMs / signal to executor', async () => {
    const fake = makeFakeExecutor({
      rawOutput: '```json\n{"summary":"ok"}\n```',
    })
    const ac = new AbortController()
    await runSkill(
      {
        requirementId: 11,
        nodeId: 'x',
        skill: 'test-skill',
        role: 'spec-author',
        worktreePath: WT,
        branch: 'feat/qi-11',
        baseBranch: 'main',
        artifactPath: 'x.md',
        inputs: {},
        maxTurns: 50,
        timeoutMs: 1234567,
        signal: ac.signal,
      },
      fake,
    )
    expect(fake.calls[0]!.maxTurns).toBe(50)
    expect(fake.calls[0]!.timeoutMs).toBe(1234567)
    expect(fake.calls[0]!.signal).toBe(ac.signal)
  })

  it('reviewer role: parses pass/fail + notes', async () => {
    const fake = makeFakeExecutor({
      rawOutput:
        '```json\n' +
        JSON.stringify({
          summary: 'reviewed',
          decision: 'fail',
          notes: [{ severity: 'error', msg: 'no test for new flow' }],
        }) +
        '\n```',
    })

    const result = await runSkill(
      {
        requirementId: 12,
        nodeId: 'dev_with_review_loop',
        skill: 'test-skill',
        role: 'reviewer',
        worktreePath: WT,
        branch: 'feat/qi-12',
        baseBranch: 'main',
        artifactPath: '',
        inputs: {},
      },
      fake,
    )

    expect(result.output.decision).toBe('fail')
    expect(result.output.notes![0]!.msg).toContain('no test')
  })
})

describe('defaultMcpServerPath', () => {
  it('points at quick-impl/mcp-server.js', () => {
    expect(defaultMcpServerPath()).toMatch(/quick-impl[\\/]mcp-server\.js$/)
  })
})
