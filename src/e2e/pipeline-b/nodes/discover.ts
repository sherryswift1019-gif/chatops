// src/e2e/pipeline-b/nodes/discover.ts
//
// playbook-driven discover：复用 loadScenariosFromGitlab 拉所有 playbook，按 scenarioFilter 过滤。
// state.playbooks 以 specPath 为键存原始 Playbook 对象（run-scenario 节点回查用）。
import { loadScenariosFromGitlab } from '../playbook/load-from-gitlab.js'
import { notifyRunStarted } from '../im-notifier.js'
import type { PipelineBStateType, ScenarioInfo } from '../types.js'

export async function discoverNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const loaded = await loadScenariosFromGitlab(state.targetProjectId, state.sourceBranch)
  console.log(`[PipelineB:discover] runId=${state.runId} 找到 ${Object.keys(loaded.playbooks).length} 个 playbook 文件`)

  const allScenarios: ScenarioInfo[] = loaded.scenarios.map((s) => ({
    id: s.id,
    name: s.name,
    tags: s.tags,
  }))

  let scenarios = allScenarios
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

  console.log(`[PipelineB:discover] runId=${state.runId} 共 ${scenarios.length} 个 scenario（过滤后）`)
  if (state.imContext) {
    notifyRunStarted(
      { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId: state.runId },
      scenarios.length,
    ).catch(() => {})
  }
  return { pendingScenarios: scenarios, playbooks: loaded.playbooks }
}
