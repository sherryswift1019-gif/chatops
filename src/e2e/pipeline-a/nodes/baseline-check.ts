import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import type { PipelineAStateType, BaselineResult } from '../types.js'

export async function runBaselineCheckNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec) return {}

  const project = await getE2eTargetProject(spec.targetProjectId)
  if (!project) throw new Error(`project not found: ${spec.targetProjectId}`)

  const testScript = join(project.workingDir, project.scripts.test)
  const evidenceDir = join(tmpdir(), `e2e-evidence-baseline-${spec.specId}-attempt-${state.baselineAttempts + 1}`)
  mkdirSync(evidenceDir, { recursive: true })

  const scenarioId = spec.specPath.split('/').pop()!.replace('.md', '')

  const result = spawnSync(testScript, [`--scenario`, scenarioId, `--evidence-dir=${evidenceDir}`], {
    encoding: 'utf8',
    timeout: 300_000,
  })

  const passed = result.status === 0
  const lastLine = (result.stdout ?? '').trim().split('\n').pop() ?? ''
  let summary = `Baseline check ${passed ? 'PASSED' : 'FAILED'} for ${scenarioId}`
  try {
    summary = JSON.parse(lastLine)?.summary ?? summary
  } catch {
    /* ignore */
  }

  const baselineResult: BaselineResult = {
    specId: spec.specId,
    passed,
    evidenceDir,
    evidenceSummary: summary,
  }

  console.log(`[PipelineA:baselineCheck] attempt ${state.baselineAttempts + 1}: ${passed ? 'PASS' : 'FAIL'}`)
  return {
    lastBaselineResult: baselineResult,
    baselineAttempts: state.baselineAttempts + 1,
  }
}
