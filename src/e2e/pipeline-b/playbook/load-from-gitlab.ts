// src/e2e/pipeline-b/playbook/load-from-gitlab.ts
//
// 从目标仓库 docs/test-playbooks/*.yaml 拉所有 playbook，用 zod schema 校验后摊平成 scenarios。
// discover 节点和 admin /e2e-runs/scenario-options 端点共用此 helper。
import { getE2eTargetProject, extractGitlabPath } from '../../../db/repositories/e2e-target-projects.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { parsePlaybookYaml } from './parse.js'
import type { Playbook } from './types.js'

export const PLAYBOOKS_DIR = 'docs/test-playbooks'

export interface ScenarioWithPath {
  id: string
  name: string
  tags: string[]
  specPath: string
}

export interface PlaybookLoadResult {
  scenarios: ScenarioWithPath[]
  playbooks: Record<string, Playbook>
  ref: string
}

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
    if (resp.status === 404) return []
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
    console.warn(`[playbook-loader] 拉 ${filePath} 失败: ${resp.status}`)
    return null
  }
  return resp.text()
}

export async function loadScenariosFromGitlab(
  projectId: string,
  ref?: string,
): Promise<PlaybookLoadResult> {
  const project = await getE2eTargetProject(projectId)
  if (!project) throw new Error(`e2e_target_projects: "${projectId}" not found`)

  const cfg = await resolveGitlabConfig()
  if (!cfg.url || !cfg.token) {
    throw new Error('playbook-loader: GitLab 配置未完成（缺少 URL 或 Token），无法拉 playbook')
  }

  const repoPath = extractGitlabPath(project.gitlabRepo)
  const base = cfg.url.replace(/\/$/, '')
  const encodedRepo = encodeURIComponent(repoPath)
  const usedRef = ref || project.defaultBranch

  const files = await listPlaybookFiles(base, encodedRepo, usedRef, cfg.token)

  const playbooks: Record<string, Playbook> = {}
  const scenarios: ScenarioWithPath[] = []

  for (const file of files) {
    const content = await fetchPlaybookFile(base, encodedRepo, file.path, usedRef, cfg.token)
    if (!content) continue

    const parsed = parsePlaybookYaml(content)
    if (!parsed.ok) {
      const issues = parsed.issues?.map((i) => `${i.path}: ${i.message}`).join('; ')
      console.warn(`[playbook-loader] ${file.path} schema 校验失败，跳过: ${parsed.error}${issues ? ` (${issues})` : ''}`)
      continue
    }

    playbooks[file.path] = parsed.value
    for (const s of parsed.value.scenarios) {
      scenarios.push({ id: s.id, name: s.name, tags: s.tags ?? [], specPath: file.path })
    }
  }

  return { scenarios, playbooks, ref: usedRef }
}
