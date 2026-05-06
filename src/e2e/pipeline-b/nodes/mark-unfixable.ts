// src/e2e/pipeline-b/nodes/mark-unfixable.ts
import { finishScenarioRun, mergeEvidenceManifest } from '../../../db/repositories/e2e-scenario-runs.js'
import { notifyGovernorUnfixable } from '../im-notifier.js'
import type { PipelineBStateType } from '../types.js'

export async function markUnfixableNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { currentScenario, currentScenarioRunId, pendingScenarios, runId, lastFixResult } = state
  if (!currentScenario) return {}

  if (currentScenarioRunId) {
    const aiDiagnosis = lastFixResult ?? {
      verdict: 'uncertain' as const,
      rootCauseSummary: 'max fix attempts exceeded',
      fixCommitSha: null,
      fixedFiles: [],
      success: false,
      failureReason: 'exhausted all fix attempts',
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
  }
}
