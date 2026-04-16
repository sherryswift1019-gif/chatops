import { describe, it, expect } from 'vitest'
import { handleIssueEvent, handleMergeRequestEvent } from '../../adapters/gitlab/issue-handler.js'

// Mock coordinator and DB
vi.mock('../../agent/coordinator.js', () => ({
  triggerCapability: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('../../db/repositories/bug-analysis-reports.js', () => ({
  getBugAnalysisReportByIssueId: vi.fn().mockResolvedValue({ id: 1, issueId: 100 }),
}))

import { vi } from 'vitest'
import { triggerCapability } from '../../agent/coordinator.js'

describe('GitLab Issue Handler', () => {
  it('triggers fix_bug_l3 when label changes to approved', async () => {
    await handleIssueEvent({
      object_kind: 'issue',
      object_attributes: { iid: 100, title: 'Bug', action: 'update', labels: [{ title: 'approved' }] },
      project: { path_with_namespace: 'pam/pas' },
      changes: {
        labels: {
          previous: [{ title: 'needs-approval' }],
          current: [{ title: 'approved' }],
        },
      },
    })

    expect(triggerCapability).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'fix_bug_l3',
    }))
  })

  it('does not trigger on irrelevant label changes', async () => {
    ;(triggerCapability as any).mockClear()

    await handleIssueEvent({
      object_kind: 'issue',
      object_attributes: { iid: 200, title: 'Bug', action: 'update', labels: [{ title: 'fixing' }] },
      project: { path_with_namespace: 'pam/pas' },
      changes: {
        labels: {
          previous: [{ title: 'graded' }],
          current: [{ title: 'fixing' }],
        },
      },
    })

    expect(triggerCapability).not.toHaveBeenCalled()
  })
})

describe('GitLab MR Handler', () => {
  it('triggers ai_review_mr when ai-generated MR is opened', async () => {
    ;(triggerCapability as any).mockClear()

    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: {
        iid: 567, title: 'fix(l1): 修复', action: 'open',
        source_branch: 'fix/issue-100', target_branch: 'develop',
        labels: [{ title: 'ai-generated' }, { title: 'level-l1' }],
      },
      project: { path_with_namespace: 'pam/pas' },
    })

    expect(triggerCapability).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'ai_review_mr',
    }))
  })

  it('does not trigger review for non-ai-generated MR', async () => {
    ;(triggerCapability as any).mockClear()

    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: {
        iid: 568, title: '人工 MR', action: 'open',
        source_branch: 'feature/x', target_branch: 'develop',
        labels: [],
      },
      project: { path_with_namespace: 'pam/pas' },
    })

    expect(triggerCapability).not.toHaveBeenCalled()
  })
})
