// src/e2e/pipeline-b/nodes/discover.ts
import { join } from 'path'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType, ScenarioInfo } from '../types.js'

export async function discoverNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const testScript = join(workDir, state.projectScripts.test)

  const result = await runScript(
    testScript,
    ['--discover', '--format=json'],
    { timeout: 120_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    throw new Error(`discover: test.sh --discover failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
  }

  let scenarios: ScenarioInfo[] = []
  if (result.parsed && Array.isArray(result.parsed.scenarios)) {
    scenarios = result.parsed.scenarios as ScenarioInfo[]
  }

  const { scenarioFilter } = state
  if (scenarioFilter) {
    if (scenarioFilter.ids?.length) {
      const idSet = new Set(scenarioFilter.ids)
      scenarios = scenarios.filter((s) => idSet.has(s.id))
    } else if (scenarioFilter.tags?.length) {
      const tagSet = new Set(scenarioFilter.tags)
      scenarios = scenarios.filter((s) => s.tags.some((t) => tagSet.has(t)))
    }
  }

  console.log(`[PipelineB:discover] runId=${state.runId} found ${scenarios.length} scenarios`)
  return { pendingScenarios: scenarios }
}
