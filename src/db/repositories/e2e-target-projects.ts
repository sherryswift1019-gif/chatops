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
