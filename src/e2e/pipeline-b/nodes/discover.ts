// src/e2e/pipeline-b/nodes/discover.ts
//
// playbook-driven discover：从目标仓库 docs/test-playbooks/*.yaml 拉所有 playbook，
// 用 zod schema 校验后摊平成 pendingScenarios。每个 scenario 知道自己来自哪个 specPath，
// state.playbooks 以 specPath 为键存原始 Playbook 对象（run-scenario 节点回查用）。
import { getE2eTargetProject, extractGitlabPath } from '../../../db/repositories/e2e-target-projects.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { parsePlaybookYaml } from '../playbook/parse.js'
import { notifyRunStarted } from '../im-notifier.js'
import type { Playbook } from '../playbook/types.js'
import type { PipelineBStateType, ScenarioInfo } from '../types.js'

const PLAYBOOKS_DIR = 'docs/test-playbooks'

interface GitlabTreeEntry { name: string; path: string; type: string }

async function listPlaybookFiles(
  base: string,
  encodedRepoPath: string,
  ref: string,
  token: string,
): Promise<GitlabTreeEntry[]> {
  const treeUrl = `${base}/api/v4/projects/${encodedRepoPath}/repository/tree?path=${encodeURIComponent(PLAYBOOKS_DIR)}&recursive=false&ref=${ref}&per_page=100`
  const resp = await fetch(treeUrl, {
    headers: { 'PRIVATE-TOKEN': token },
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) {
    if (resp.status === 404) return [] // 仓库还没建 docs/test-playbooks/
    throw new Error(`GitLab tree API ${resp.status}: ${treeUrl}`)
  }
  const tree = (await resp.json()) as GitlabTreeEntry[]
  return tree.filter((f) => f.type === 'blob' && (f.name.endsWith('.yaml') || f.name.endsWith('.yml')))
}

async function fetchPlaybookFile(
  base: string,
  encodedRepoPath: string,
  filePath: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const rawUrl = `${base}/api/v4/projects/${encodedRepoPath}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${ref}`
  const resp = await fetch(rawUrl, {
    headers: { 'PRIVATE-TOKEN': token },
    signal: AbortSignal.timeout(8_000),
  })
  if (!resp.ok) {
    console.warn(`[discover] 拉 ${filePath} 失败: ${resp.status}`)
    return null
  }
  return resp.text()
}

export async function discoverNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const cfg = await resolveGitlabConfig()
  if (!cfg.url || !cfg.token) {
    throw new Error('discover: GitLab 配置未完成（缺少 URL 或 Token），无法拉 playbook')
  }

  const repoPath = extractGitlabPath(project.gitlabRepo)
  const base = cfg.url.replace(/\/$/, '')
  const encodedRepo = encodeURIComponent(repoPath)
  const ref = state.sourceBranch || project.defaultBranch

  const files = await listPlaybookFiles(base, encodedRepo, ref, cfg.token)
  console.log(`[PipelineB:discover] runId=${state.runId} 找到 ${files.length} 个 playbook 文件`)

  const playbooks: Record<string, Playbook> = {}
  const allScenarios: ScenarioInfo[] = []

  for (const file of files) {
    const content = await fetchPlaybookFile(base, encodedRepo, file.path, ref, cfg.token)
    if (!content) continue

    const parsed = parsePlaybookYaml(content)
    if (!parsed.ok) {
      const issues = parsed.issues?.map((i) => `${i.path}: ${i.message}`).join('; ')
      console.warn(`[discover] ${file.path} schema 校验失败，跳过: ${parsed.error}${issues ? ` (${issues})` : ''}`)
      continue
    }

    playbooks[file.path] = parsed.value
    for (const s of parsed.value.scenarios) {
      allScenarios.push({ id: s.id, name: s.name, tags: s.tags ?? [] })
    }
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
  return { pendingScenarios: scenarios, playbooks }
}
