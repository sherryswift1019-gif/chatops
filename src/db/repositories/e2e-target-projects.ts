import { getPool } from '../client.js'

export interface E2eTargetProject {
  id: string
  displayName: string
  gitlabRepo: string
  defaultBranch: string
  workingDir: string
  scripts: { build: string; deploy: string; test: string; fix?: string }
  capabilities: Record<string, unknown>
  defaultSandboxKind: string
  createdAt: Date
}

export interface UpdateE2eTargetProjectData {
  displayName?: string
  gitlabRepo?: string
  defaultBranch?: string
  workingDir?: string
  scripts?: { build: string; deploy: string; test: string; fix?: string }
  defaultSandboxKind?: string
}

function mapRow(r: Record<string, unknown>): E2eTargetProject {
  return {
    id: r.id as string,
    displayName: r.display_name as string,
    gitlabRepo: r.gitlab_repo as string,
    defaultBranch: r.default_branch as string,
    workingDir: r.working_dir as string,
    scripts: r.scripts as E2eTargetProject['scripts'],
    capabilities: r.capabilities as Record<string, unknown>,
    defaultSandboxKind: r.default_sandbox_kind as string,
    createdAt: r.created_at as Date,
  }
}

export async function listE2eTargetProjects(): Promise<E2eTargetProject[]> {
  const { rows } = await getPool().query('SELECT * FROM e2e_target_projects ORDER BY id')
  return rows.map(mapRow)
}

export async function getE2eTargetProject(id: string): Promise<E2eTargetProject | null> {
  const { rows } = await getPool().query('SELECT * FROM e2e_target_projects WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updateE2eTargetProject(
  id: string,
  data: UpdateE2eTargetProjectData,
): Promise<E2eTargetProject | null> {
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1

  if (data.displayName !== undefined) { sets.push(`display_name = $${i++}`); vals.push(data.displayName) }
  if (data.gitlabRepo !== undefined) { sets.push(`gitlab_repo = $${i++}`); vals.push(data.gitlabRepo) }
  if (data.defaultBranch !== undefined) { sets.push(`default_branch = $${i++}`); vals.push(data.defaultBranch) }
  if (data.workingDir !== undefined) { sets.push(`working_dir = $${i++}`); vals.push(data.workingDir) }
  if (data.scripts !== undefined) { sets.push(`scripts = $${i++}`); vals.push(JSON.stringify(data.scripts)) }
  if (data.defaultSandboxKind !== undefined) { sets.push(`default_sandbox_kind = $${i++}`); vals.push(data.defaultSandboxKind) }

  if (sets.length === 0) return getE2eTargetProject(id)
  vals.push(id)

  const { rows } = await getPool().query(
    `UPDATE e2e_target_projects SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals,
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export function extractGitlabPath(gitlabRepo: string): string {
  try {
    const url = new URL(gitlabRepo)
    return url.pathname.replace(/^\//, '').replace(/\.git$/, '')
  } catch {
    return gitlabRepo.replace(/\.git$/, '')
  }
}

