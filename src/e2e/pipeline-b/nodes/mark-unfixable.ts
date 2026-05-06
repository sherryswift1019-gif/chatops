// src/e2e/pipeline-b/nodes/mark-unfixable.ts
import { finishScenarioRun, mergeEvidenceManifest } from '../../../db/repositories/e2e-scenario-runs.js'
import { notifyGovernorUnfixable } from '../im-notifier.js'
import type { PipelineBStateType } from '../types.js'

export async function markUnfixableNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { currentScenario, currentScenarioRunId, pendingScenarios, runId, lastFixResult, humanReviewDecision } = state
  if (!currentScenario) return {}

  if (currentScenarioRunId) {
    let aiDiagnosis = lastFixResult
    if (!aiDiagnosis) {
      // 没经过 e2e_fix_agent（reject 直达此处 / 异常 fallthrough）。区分两种语义：
      //  - reject 路径：人审决策为 reject，并未尝试修复
      //  - 其他：兜底文案，配合 lastUnfixableScenario 让 finalize 报准确 reason
      const reason =
        humanReviewDecision === 'reject'
          ? 'human reviewer rejected fix attempt'
          : 'no fix attempted (auto-rejected: missing reviewer context)'
      aiDiagnosis = {
        verdict: 'uncertain' as const,
        rootCauseSummary: reason,
        fixCommitSha: null,
        fixedFiles: [],
        success: false,
        failureReason: reason,
      }
    }
    // 两步：仅改 result（不传 evidenceManifest，COALESCE 保留原 manifest），
    // 然后把 aiDiagnosis 用 jsonb 浅 merge 追加进去——避免历史 bug：之前用
    // finishScenarioRun({evidenceManifest:{aiDiagnosis}}) 整体覆盖，把 host Claude
    // 写入的 acceptanceResults / claudeTrace / artifacts 全洗掉。
    await finishScenarioRun(currentScenarioRunId, 'unfixable').catch((err) => {
      console.warn(`[PipelineB:markUnfixable] finishScenarioRun failed: ${err}`)
    })
    await mergeEvidenceManifest(currentScenarioRunId, { aiDiagnosis }).catch((err) => {
      console.warn(`[PipelineB:markUnfixable] mergeEvidenceManifest failed: ${err}`)
    })
  }

  const remaining = pendingScenarios.filter((s) => s.id !== currentScenario.id)

  console.log(`[PipelineB:markUnfixable] runId=${runId} scenario=${currentScenario.id} UNFIXABLE remaining=${remaining.length}`)
  if (state.imContext) {
    notifyGovernorUnfixable(
      { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId },
      currentScenario.id,
    ).catch(() => {})
  }
  return {
    pendingScenarios: remaining,
    currentScenario: null,
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
    lastUnfixableScenario: currentScenario.id,
  }
}
