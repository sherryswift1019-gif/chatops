import { describe, it, expect } from 'vitest'
import { effectiveStatus } from './effectiveStatus'
import type { RequirementDetailDTO } from '../../api/requirements'

function makeDetail(overrides: Partial<RequirementDetailDTO>): RequirementDetailDTO {
  return {
    id: 1, title: 't', rawInput: '', status: 'developing',
    branch: null, baseBranch: 'main', gitlabProject: 'g/p',
    worktreePath: null, pipelineRunId: null, currentStage: null,
    specContent: null, planContent: null, mrUrl: null, abortReason: null,
    retryCounters: {}, source: 'web', createdBy: null, skipE2E: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', completedAt: null,
    waiters: [], stageResults: null,
    ...overrides,
  }
}

describe('effectiveStatus', () => {
  it('terminal status → original STATUS_CONFIG label', () => {
    expect(effectiveStatus(makeDetail({ status: 'merged' })).label).toBe('已合入')
    expect(effectiveStatus(makeDetail({ status: 'failed' })).label).toBe('失败')
    expect(effectiveStatus(makeDetail({ status: 'aborted' })).label).toBe('已中止')
    expect(effectiveStatus(makeDetail({ status: 'draft' })).label).toBe('草稿')
    expect(effectiveStatus(makeDetail({ status: 'queued' })).label).toBe('排队中')
  })

  it('pending waiter takes precedence over running node', () => {
    const d = makeDetail({
      status: 'developing',
      waiters: [{
        id: 1, requirementId: 1, pipelineRunId: 1, nodeId: 'spec_human_gate',
        approvalKind: 'spec', round: 1, decisionSet: 'binary',
        imPlatform: null, imGroupId: null, contextSummary: null,
        claimedBy: null, claimedAt: null, decision: null,
        rejectReason: null, budgetDelta: null, decidedBy: null,
        createdAt: '2026-01-01T00:00:00Z',
      }],
      stageResults: [
        { name: 'spec_author', type: 'llm_author', status: 'success' },
        { name: 'spec_human_gate', type: 'human_gate', status: 'running' },
      ],
    })
    expect(effectiveStatus(d).label).toBe('Spec 等你决策')
    expect(effectiveStatus(d).color).toBe('gold')
  })

  it('skips system orphan waiters', () => {
    const d = makeDetail({
      waiters: [{
        id: 1, requirementId: 1, pipelineRunId: 1, nodeId: 'x',
        approvalKind: 'spec', round: 1, decisionSet: 'binary',
        imPlatform: null, imGroupId: null, contextSummary: null,
        claimedBy: 'system', claimedAt: '2026-01-01T00:00:00Z',
        decision: 'aborted', rejectReason: null, budgetDelta: null,
        decidedBy: null, createdAt: '2026-01-01T00:00:00Z',
      }],
    })
    // 不应被识别为 pending waiter → 退到 STATUS_CONFIG.developing
    expect(effectiveStatus(d).label).toBe('开发中')
  })

  it('running node → node-specific label', () => {
    const d = makeDetail({
      status: 'developing',
      stageResults: [
        { name: 'init_branch', type: 'init_qi_branch', status: 'success' },
        { name: 'spec_author', type: 'llm_author', status: 'running' },
      ],
    })
    expect(effectiveStatus(d).label).toBe('Spec 生成中')
  })

  it('running node accepts backend display name (Spec Author 而非 spec_author)', () => {
    const d = makeDetail({
      status: 'spec_review',
      stageResults: [
        { name: 'Init Branch', type: 'init_qi_branch', status: 'success' },
        { name: 'Spec Author', type: 'llm_author', status: 'running' },
      ],
    })
    expect(effectiveStatus(d).label).toBe('Spec 生成中')
  })

  it('falls back to STATUS_CONFIG when no waiter and no running node', () => {
    const d = makeDetail({
      status: 'planning',
      stageResults: [{ name: 'init_branch', type: 'init_qi_branch', status: 'success' }],
    })
    expect(effectiveStatus(d).label).toBe('规划中')
  })

  it('all approval kinds have specific labels', () => {
    const kinds: Array<[string, string]> = [
      ['spec', 'Spec 等你决策'],
      ['plan', 'Plan 等你决策'],
      ['dev', 'Dev 等你决策'],
      ['final', '最终审批 等你决策'],
      ['qi_e2e_intervention', 'E2E 失败 等人工介入'],
      ['qi_sandbox_failed', 'Sandbox 失败 等介入'],
    ]
    for (const [kind, expected] of kinds) {
      const d = makeDetail({
        waiters: [{
          id: 1, requirementId: 1, pipelineRunId: 1, nodeId: 'x',
          approvalKind: kind as any, round: 1, decisionSet: 'binary',
          imPlatform: null, imGroupId: null, contextSummary: null,
          claimedBy: null, claimedAt: null, decision: null,
          rejectReason: null, budgetDelta: null, decidedBy: null,
          createdAt: '2026-01-01T00:00:00Z',
        }],
      })
      expect(effectiveStatus(d).label).toBe(expected)
    }
  })
})
