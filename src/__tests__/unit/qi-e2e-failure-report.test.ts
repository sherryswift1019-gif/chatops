import { describe, it, expect } from 'vitest'
import {
  buildQiFailureReport,
  summarizeFailureReportForCard,
  type ScenarioRunRecord,
} from '../../quick-impl/qi-e2e-failure-report.js'
import type { Manifest } from '../../e2e/pipeline-b/playbook/manifest.js'
import type { Playbook } from '../../e2e/pipeline-b/playbook/types.js'

function manifest(opts: Partial<Manifest> & { scenarioId: string; result: Manifest['result'] }): Manifest {
  return {
    scenarioId: opts.scenarioId,
    attemptNumber: opts.attemptNumber ?? 1,
    result: opts.result,
    startedAt: '2026-05-09T10:00:00.000Z',
    finishedAt: '2026-05-09T10:00:30.000Z',
    durationMs: 30000,
    claudeTrace: opts.claudeTrace ?? [],
    acceptanceResults: opts.acceptanceResults ?? [],
    artifacts: opts.artifacts ?? [],
    errorMessage: opts.errorMessage ?? null,
    meta: opts.meta ?? null,
  }
}

function passRec(scenarioId: string): ScenarioRunRecord {
  return {
    scenarioId,
    evidenceDir: `/tmp/evidence/${scenarioId}`,
    manifest: manifest({ scenarioId, result: 'pass' }),
    rawOutput: 'pass output',
    errorMessage: null,
  }
}

const PLAYBOOK = {
  specPath: 'docs/specs/qi-1.md',
  specTitle: 'test',
  scenarios: [
    {
      id: 'login-happy',
      name: '正常登录',
      tags: [],
      setup: undefined,
      steps: [],
      acceptance: [{ kind: 'url_match', value: '/dashboard' }],
    },
    {
      id: 'login-bad-pwd',
      name: '错误密码',
      tags: [],
      setup: undefined,
      steps: [],
      acceptance: [{ kind: 'url_match', value: '/login' }],
    },
  ],
} as unknown as Playbook

describe('qi-e2e-failure-report', () => {
  describe('buildQiFailureReport', () => {
    it('全部 pass → failed=0', () => {
      const report = buildQiFailureReport([passRec('s1'), passRec('s2')])
      expect(report.total).toBe(2)
      expect(report.passed).toBe(2)
      expect(report.failed).toBe(0)
      expect(report.scenarios).toEqual([])
    })

    it('manifest result=fail → 失败 scenario', () => {
      const failed: ScenarioRunRecord = {
        scenarioId: 'login-happy',
        evidenceDir: '/tmp/e/1',
        manifest: manifest({
          scenarioId: 'login-happy',
          result: 'fail',
          acceptanceResults: [
            {
              kind: 'page_url',
              index: 0,
              result: 'fail',
              expected: '/dashboard',
              actual: '/login',
              reason: 'page did not redirect',
            },
          ],
        }),
        rawOutput: 'output',
        errorMessage: null,
      }
      const report = buildQiFailureReport([failed], PLAYBOOK)
      expect(report.failed).toBe(1)
      expect(report.scenarios[0].id).toBe('login-happy')
      expect(report.scenarios[0].name).toBe('正常登录')
      expect(report.scenarios[0].result).toBe('fail')
      expect(report.scenarios[0].failureReason).toContain('page_url#0')
      expect(report.scenarios[0].failureReason).toContain('page did not redirect')
      expect(report.scenarios[0].failedAcceptances).toHaveLength(1)
      expect(report.scenarios[0].failedAcceptances[0].expected).toBe('/dashboard')
    })

    it('errorMessage 顶级字段优先于 manifest', () => {
      const errored: ScenarioRunRecord = {
        scenarioId: 'login-bad-pwd',
        evidenceDir: '/tmp/e/2',
        manifest: null,
        rawOutput: 'crashed',
        errorMessage: 'Claude runner timeout after 30min',
      }
      const report = buildQiFailureReport([errored])
      expect(report.failed).toBe(1)
      expect(report.scenarios[0].result).toBe('no-manifest')
      expect(report.scenarios[0].failureReason).toContain('timeout')
    })

    it('混合 pass + fail 计数正确', () => {
      const records: ScenarioRunRecord[] = [
        passRec('login-happy'),
        {
          scenarioId: 'login-bad-pwd',
          evidenceDir: '/tmp/e/2',
          manifest: manifest({ scenarioId: 'login-bad-pwd', result: 'fail' }),
          rawOutput: '',
          errorMessage: null,
        },
      ]
      const report = buildQiFailureReport(records, PLAYBOOK)
      expect(report.total).toBe(2)
      expect(report.passed).toBe(1)
      expect(report.failed).toBe(1)
      expect(report.scenarios[0].name).toBe('错误密码')
    })

    it('claudeTrace 截断到 ~8KB', () => {
      const longTrace = Array.from({ length: 1000 }, (_, i) => ({
        step: i,
        intent: 'X'.repeat(100),
        tool: 'browser_navigate',
        verdict: 'ok' as const,
        note: null,
      }))
      const failed: ScenarioRunRecord = {
        scenarioId: 'login-happy',
        evidenceDir: '/tmp/e',
        manifest: manifest({
          scenarioId: 'login-happy',
          result: 'fail',
          claudeTrace: longTrace,
        }),
        rawOutput: '',
        errorMessage: null,
      }
      const report = buildQiFailureReport([failed], PLAYBOOK)
      const tailBytes = Buffer.byteLength(report.scenarios[0].claudeTraceTail, 'utf8')
      expect(tailBytes).toBeLessThanOrEqual(8 * 1024)
      expect(tailBytes).toBeGreaterThan(0)
    })

    it('manifest 缺失 fallback rawOutput 末尾', () => {
      const long = 'A'.repeat(10000)
      const errored: ScenarioRunRecord = {
        scenarioId: 'unknown',
        evidenceDir: '/tmp/e',
        manifest: null,
        rawOutput: long,
        errorMessage: 'crashed',
      }
      const report = buildQiFailureReport([errored])
      const trace = report.scenarios[0].claudeTraceTail
      expect(trace.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(trace, 'utf8')).toBeLessThanOrEqual(4 * 1024)
    })

    it('error verdict trace step 作为兜底失败原因', () => {
      const failed: ScenarioRunRecord = {
        scenarioId: 'login-happy',
        evidenceDir: '/tmp/e',
        manifest: manifest({
          scenarioId: 'login-happy',
          result: 'fail',
          claudeTrace: [
            { step: 1, intent: 'navigate', tool: 'b', verdict: 'ok', note: null },
            { step: 2, intent: 'click button', tool: 'b', verdict: 'error', note: 'selector not found' },
          ],
          acceptanceResults: [],
        }),
        rawOutput: '',
        errorMessage: null,
      }
      const report = buildQiFailureReport([failed], PLAYBOOK)
      expect(report.scenarios[0].failureReason).toContain('step 2')
      expect(report.scenarios[0].failureReason).toContain('selector not found')
    })

    it('playbook 缺失时用 scenarioId 当 name', () => {
      const failed: ScenarioRunRecord = {
        scenarioId: 's-no-playbook',
        evidenceDir: '/tmp/e',
        manifest: manifest({ scenarioId: 's-no-playbook', result: 'fail' }),
        rawOutput: '',
        errorMessage: null,
      }
      const report = buildQiFailureReport([failed])
      expect(report.scenarios[0].name).toBe('s-no-playbook')
    })
  })

  describe('summarizeFailureReportForCard', () => {
    it('全 pass 摘要', () => {
      expect(
        summarizeFailureReportForCard({ total: 3, passed: 3, failed: 0, scenarios: [] }),
      ).toBe('3 个 scenario 全部通过')
    })

    it('失败摘要含 id + reason，截断', () => {
      const summary = summarizeFailureReportForCard({
        total: 2,
        passed: 0,
        failed: 2,
        scenarios: [
          {
            id: 'login-happy',
            name: 'a',
            result: 'fail',
            failureReason: 'page did not redirect',
            failedAcceptances: [],
            claudeTraceTail: '',
            artifactsDir: null,
          },
          {
            id: 'login-bad-pwd',
            name: 'b',
            result: 'fail',
            failureReason: 'API returned 500',
            failedAcceptances: [],
            claudeTraceTail: '',
            artifactsDir: null,
          },
        ],
      })
      expect(summary).toContain('2/2 失败')
      expect(summary).toContain('login-happy')
      expect(summary).toContain('login-bad-pwd')
      expect(summary.length).toBeLessThanOrEqual(500)
    })

    it('多于 3 个 scenario → 摘要只列前 3', () => {
      const scenarios = Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        name: `s${i}`,
        result: 'fail' as const,
        failureReason: `reason${i}`,
        failedAcceptances: [],
        claudeTraceTail: '',
        artifactsDir: null,
      }))
      const summary = summarizeFailureReportForCard({
        total: 5,
        passed: 0,
        failed: 5,
        scenarios,
      })
      expect(summary).toContain('s0')
      expect(summary).toContain('s2')
      expect(summary).toContain('还有 2 个')
      expect(summary).not.toContain('s3')
      expect(summary).not.toContain('s4')
    })
  })
})
