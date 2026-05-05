// src/e2e/pipeline-a/nodes/baseline-check.ts
//
// playbook-driven baseline-check：把生成的 playbook YAML 解析后，在 baseline sandbox
// 上调 runE2eScenario 跑每个 scenario。所有 scenario 全 pass 才算 baseline 通过。
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runE2eScenario } from '../../../agent/e2e-scenario/runner.js'
import { parsePlaybookYaml } from '../../pipeline-b/playbook/parse.js'
import type { SandboxHandle } from '../../pipeline-b/types.js'
import type { PipelineAStateType, BaselineResult } from '../types.js'

export async function runBaselineCheckNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec) return {}
  if (!spec.generatedContent) {
    return {
      lastBaselineResult: {
        specId: spec.specId,
        passed: false,
        evidenceSummary: 'baseline-check: spec.generatedContent 为空',
      },
      baselineAttempts: state.baselineAttempts + 1,
    }
  }
  if (!state.sandboxHandle) {
    throw new Error('baseline-check: sandboxHandle is null')
  }

  const parsed = parsePlaybookYaml(spec.generatedContent)
  if (!parsed.ok) {
    const issues = parsed.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') ?? ''
    const summary = `baseline-check: playbook YAML 校验失败 - ${parsed.error}${issues ? ` (${issues})` : ''}`
    return {
      lastBaselineResult: { specId: spec.specId, passed: false, evidenceSummary: summary },
      baselineAttempts: state.baselineAttempts + 1,
    }
  }

  const playbook = parsed.value
  const sandboxHandle: SandboxHandle = {
    envId: state.sandboxHandle.envId,
    kind: state.sandboxHandle.kind,
    endpoints: state.sandboxHandle.endpoints,
    internalRefs: state.sandboxHandle.internalRefs,
    containerId: state.sandboxHandle.containerId,
    workdir: state.sandboxHandle.workdir,
  }

  const evidenceRoot = mkdtempSync(join(tmpdir(), `pipeline-a-baseline-${spec.specId}-`))
  let allPassed = true
  const failedSummaries: string[] = []

  for (const scenario of playbook.scenarios) {
    const evidenceDir = join(evidenceRoot, scenario.id)
    const result = await runE2eScenario({
      playbook,
      scenarioId: scenario.id,
      evidenceDir,
      sandboxHandle,
      attemptNumber: state.baselineAttempts + 1,
    })

    const sceneResult = result.manifest?.result ?? 'error'
    console.log(
      `[PipelineA:baselineCheck] specId=${spec.specId} scenario=${scenario.id} result=${sceneResult}`,
    )

    if (sceneResult !== 'pass') {
      allPassed = false
      const reason = result.errorMessage
        ?? result.manifest?.errorMessage
        ?? result.manifest?.acceptanceResults.find((a) => a.result !== 'pass')?.reason
        ?? sceneResult
      failedSummaries.push(`${scenario.id}: ${reason}`)
    }
  }

  const summary = allPassed
    ? `Baseline PASSED: ${playbook.scenarios.length} scenario 全过`
    : `Baseline FAILED: ${failedSummaries.join(' | ')}`

  return {
    lastBaselineResult: {
      specId: spec.specId,
      passed: allPassed,
      evidenceDir: evidenceRoot,
      evidenceSummary: summary,
    },
    baselineAttempts: state.baselineAttempts + 1,
  }
}
