// src/e2e/pipeline-b/nodes/discover.ts
//
// playbook-driven discover：复用 loadScenariosFromGitlab 拉所有 playbook，按 scenarioFilter 过滤。
// state.playbooks 以 specPath 为键存原始 Playbook 对象（run-scenario 节点回查用）。
// 若 state.playbookDraftId 存在，则从 DB draft 加载而非 GitLab。
import { loadScenariosFromGitlab } from '../playbook/load-from-gitlab.js'
import { parsePlaybookYaml } from '../playbook/parse.js'
import { getDraft } from '../../../db/repositories/e2e-playbook-drafts.js'
import { notifyRunStarted } from '../im-notifier.js'
import type { PipelineBStateType, ScenarioInfo } from '../types.js'
import type { Playbook } from '../playbook/types.js'

export async function discoverNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  let playbooksRecord: Record<string, Playbook>
  let allScenarios: ScenarioInfo[]

  if (state.playbookDraftId) {
    const draft = await getDraft(state.playbookDraftId)
    if (!draft || !draft.yamlContent) {
      throw new Error(`[PipelineB:discover] playbookDraftId=${state.playbookDraftId} 不存在或 yamlContent 为空`)
    }
    const parsed = parsePlaybookYaml(draft.yamlContent)
    if (!parsed.ok) {
      const issues = parsed.issues?.map((i) => `${i.path}: ${i.message}`).join('; ')
      throw new Error(
        `[PipelineB:discover] draft ${state.playbookDraftId} 解析失败: ${parsed.error}${issues ? ` (${issues})` : ''}`,
      )
    }
    const draftKey = `draft-${state.playbookDraftId}`
    playbooksRecord = { [draftKey]: parsed.value }
    allScenarios = parsed.value.scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      tags: s.tags ?? [],
    }))
    console.log(`[PipelineB:discover] runId=${state.runId} 从 draft ${state.playbookDraftId} 加载 ${allScenarios.length} 个 scenario`)
  } else {
    const loaded = await loadScenariosFromGitlab(state.targetProjectId, state.sourceBranch)
    console.log(`[PipelineB:discover] runId=${state.runId} 找到 ${Object.keys(loaded.playbooks).length} 个 playbook 文件`)
    playbooksRecord = loaded.playbooks
    allScenarios = loaded.scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      tags: s.tags,
    }))
  }

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
  return { pendingScenarios: scenarios, playbooks: playbooksRecord }
}
