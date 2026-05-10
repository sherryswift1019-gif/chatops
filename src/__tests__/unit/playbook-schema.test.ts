// src/__tests__/unit/playbook-schema.test.ts
import { describe, it, expect } from 'vitest'
import {
  parsePlaybookYaml,
  validatePlaybook,
  parseManifestJson,
  validateManifest,
} from '../../e2e/pipeline-b/playbook/parse.js'

const MIN_VALID_YAML = `
specPath: docs/test-specs/login.md
specTitle: 用户登录
scenarios:
  - id: login.success
    name: 正确账号密码登录成功
    tags: [smoke, auth]
    steps:
      - "打开 /login"
      - "输入账号密码并提交"
    acceptance:
      - kind: url_match
        value: /dashboard
        timeout_ms: 5000
`

describe('parsePlaybookYaml', () => {
  it('解析最小合法 playbook', () => {
    const r = parsePlaybookYaml(MIN_VALID_YAML)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.scenarios).toHaveLength(1)
    expect(r.value.scenarios[0].id).toBe('login.success')
    expect(r.value.scenarios[0].acceptance[0].kind).toBe('url_match')
  })

  it('YAML 语法错返结构化错误', () => {
    const r = parsePlaybookYaml('foo: : :')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/YAML 解析失败/)
  })

  it('顶层不是对象 → 报错', () => {
    const r = parsePlaybookYaml('- a\n- b')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/顶层必须是对象/)
  })

  it('缺 acceptance 字段 → schema 错', () => {
    const yaml = `
specPath: x.md
scenarios:
  - id: a
    name: A
    acceptance: []
`
    const r = parsePlaybookYaml(yaml)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues?.some((i) => i.path.includes('acceptance'))).toBe(true)
  })

  it('scenario.id 含非法字符 → 报错', () => {
    const yaml = `
specPath: x.md
scenarios:
  - id: "bad id with space"
    name: A
    acceptance:
      - kind: url_match
        value: /
`
    const r = parsePlaybookYaml(yaml)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues?.some((i) => /id/.test(i.path))).toBe(true)
  })

  it('scenario.id 重复 → superRefine 报错', () => {
    const yaml = `
specPath: x.md
scenarios:
  - id: dup
    name: A
    acceptance: [{ kind: url_match, value: / }]
  - id: dup
    name: B
    acceptance: [{ kind: url_match, value: / }]
`
    const r = parsePlaybookYaml(yaml)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues?.some((i) => /重复/.test(i.message))).toBe(true)
  })

  it('dev-loop 风格 YAML（specTitle + 全 NL string acceptance）解析通过', () => {
    const yaml = `
specPath: docs/specs/qi-42.md
specTitle: 用户登录记住用户名
scenarios:
  - id: remember-username
    name: 勾选记住用户名后下次自动填充
    tags: [happy]
    steps:
      - "打开 /login"
      - "输入用户名 admin 并勾选「记住用户名」"
      - "点击登录按钮"
    acceptance:
      - "页面 URL 跳转到 /dashboard"
      - "通过 page.evaluate(() => localStorage.getItem('chatops_remembered_username')) 获取值等于 'admin'"
`
    const r = parsePlaybookYaml(yaml)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.specPath).toBe('docs/specs/qi-42.md')
    expect(r.value.specTitle).toBe('用户登录记住用户名')
    expect(r.value.scenarios[0].acceptance).toHaveLength(2)
    expect(r.value.scenarios[0].acceptance[0]).toEqual({
      kind: 'natural_language',
      text: '页面 URL 跳转到 /dashboard',
    })
    expect(r.value.scenarios[0].acceptance[1].kind).toBe('natural_language')
  })
})

describe('acceptance 类型', () => {
  function pb(acceptance: unknown) {
    return validatePlaybook({
      specPath: 'x.md',
      scenarios: [
        { id: 'a', name: 'A', acceptance: [acceptance] },
      ],
    })
  }

  it('url_match 合法', () => {
    expect(pb({ kind: 'url_match', value: '/x' }).ok).toBe(true)
  })

  it('url_regex 合法', () => {
    expect(pb({ kind: 'url_regex', pattern: '^/x$' }).ok).toBe(true)
  })

  it('dom_visible 合法', () => {
    expect(pb({ kind: 'dom_visible', selector: '[data-testid=x]' }).ok).toBe(true)
  })

  it('dom_text_contains 合法', () => {
    expect(
      pb({ kind: 'dom_text_contains', selector: 'h1', value: '欢迎' }).ok,
    ).toBe(true)
  })

  it('api_response 含 status + body_contains 合法', () => {
    expect(
      pb({
        kind: 'api_response',
        request: 'GET /api/me',
        expect_status: 200,
        expect_body_contains: 'testuser',
      }).ok,
    ).toBe(true)
  })

  it('api_response status 越界 → 报错', () => {
    expect(
      pb({ kind: 'api_response', request: 'GET /', expect_status: 999 }).ok,
    ).toBe(false)
  })

  it('log_contains 合法', () => {
    expect(
      pb({ kind: 'log_contains', source: 'app', value: 'started' }).ok,
    ).toBe(true)
  })

  it('db_query rows 期望合法', () => {
    expect(
      pb({
        kind: 'db_query',
        connection: 'app_db',
        sql: 'SELECT 1',
        expect: { rows: 1 },
      }).ok,
    ).toBe(true)
  })

  it('db_query field 期望合法', () => {
    expect(
      pb({
        kind: 'db_query',
        connection: 'app_db',
        sql: 'SELECT email FROM users',
        expect: { field: { col: 'email', equals: 'a@b.com' } },
      }).ok,
    ).toBe(true)
  })

  it('db_query expect 全空 → 报错', () => {
    expect(
      pb({
        kind: 'db_query',
        connection: 'app_db',
        sql: 'SELECT 1',
        expect: {},
      }).ok,
    ).toBe(false)
  })

  it('未知 kind → discriminatedUnion 报错', () => {
    expect(pb({ kind: 'screenshot_diff', baseline: 'a.png' }).ok).toBe(false)
  })

  it('kind 缺失 → 报错', () => {
    expect(pb({ value: '/x' }).ok).toBe(false)
  })

  it('natural_language kind 对象合法', () => {
    const r = validatePlaybook({
      specPath: 'docs/specs/qi-1.md',
      scenarios: [{
        id: 's1',
        name: 'NL 形态',
        steps: ['步骤'],
        acceptance: [{ kind: 'natural_language', text: '页面跳转到 /dashboard' }],
      }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.scenarios[0].acceptance[0]).toEqual({
      kind: 'natural_language',
      text: '页面跳转到 /dashboard',
    })
  })

  it('裸 string acceptance 自动 transform 为 natural_language', () => {
    const r = validatePlaybook({
      specPath: 'docs/specs/qi-1.md',
      scenarios: [{
        id: 's1',
        name: 'string 形态',
        steps: ['步骤'],
        acceptance: ['用户名输入框值等于 admin'],
      }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.scenarios[0].acceptance[0]).toEqual({
      kind: 'natural_language',
      text: '用户名输入框值等于 admin',
    })
  })

  it('natural_language 必须有非空 text（空串 → 报错）', () => {
    const r = validatePlaybook({
      specPath: 'docs/specs/qi-1.md',
      scenarios: [{
        id: 's1', name: 's', steps: ['x'],
        acceptance: [{ kind: 'natural_language', text: '' }],
      }],
    })
    expect(r.ok).toBe(false)
  })
})

describe('parseManifestJson', () => {
  const NOW = '2026-05-02T10:00:00.000Z'
  const MIN_OK = {
    scenarioId: 'login.success',
    attemptNumber: 1,
    result: 'pass',
    startedAt: NOW,
    finishedAt: NOW,
    durationMs: 1234,
  }

  it('最小合法 manifest 通过', () => {
    const r = parseManifestJson(JSON.stringify(MIN_OK))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.claudeTrace).toEqual([])
    expect(r.value.acceptanceResults).toEqual([])
    expect(r.value.artifacts).toEqual([])
  })

  it('完整 manifest（含 trace + acceptance + artifacts）通过', () => {
    const full = {
      ...MIN_OK,
      result: 'fail',
      claudeTrace: [
        { step: 0, intent: '打开页面', tool: 'browser_navigate', verdict: 'ok' },
        { step: 1, intent: '点击登录', tool: 'browser_click', verdict: 'error', note: '按钮不存在' },
      ],
      acceptanceResults: [
        {
          kind: 'url_match',
          index: 0,
          result: 'fail',
          expected: '/dashboard',
          actual: '/login',
        },
      ],
      artifacts: [
        { path: 'screenshot-1.png', kind: 'screenshot' },
        { path: 'console.log', kind: 'log', size_bytes: 4096 },
      ],
    }
    const r = validateManifest(full)
    expect(r.ok).toBe(true)
  })

  it('JSON 语法错 → 报错', () => {
    const r = parseManifestJson('{not json')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/JSON 解析失败/)
  })

  it('result 取值非法 → 报错', () => {
    const r = validateManifest({ ...MIN_OK, result: 'flaky' })
    expect(r.ok).toBe(false)
  })

  it('artifact.kind 取值非法 → 报错', () => {
    const r = validateManifest({
      ...MIN_OK,
      artifacts: [{ path: 'x', kind: 'video' }],
    })
    expect(r.ok).toBe(false)
  })

  it('startedAt 不是 datetime → 报错', () => {
    const r = validateManifest({ ...MIN_OK, startedAt: '2026-05-02' })
    expect(r.ok).toBe(false)
  })

  it('LLM 写 null 的 optional 字段被 schema 接受（acceptanceResults.reason / errorMessage / claudeTrace.note）', () => {
    const withNullables = {
      ...MIN_OK,
      result: 'pass',
      errorMessage: null,
      claudeTrace: [
        { step: 0, intent: '打开页面', tool: null, args_summary: null, verdict: 'ok', note: null, started_at: null, duration_ms: null },
      ],
      acceptanceResults: [
        { kind: 'url_match', index: 0, result: 'pass', reason: null, expected: null, actual: null, duration_ms: null },
      ],
      artifacts: [
        { path: 'x.png', kind: 'screenshot', description: null, size_bytes: null },
      ],
      meta: null,
    }
    const r = validateManifest(withNullables)
    expect(r.ok).toBe(true)
  })
})
