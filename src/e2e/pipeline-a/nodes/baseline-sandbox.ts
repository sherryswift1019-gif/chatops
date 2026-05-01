import { spawnSync, execSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { getE2eTargetProject, extractGitlabPath } from '../../../db/repositories/e2e-target-projects.js'
import { createSandbox, updateSandboxStatus } from '../../../db/repositories/e2e-sandboxes.js'
import { updateE2eSpecStatus } from '../../../db/repositories/e2e-specs.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import type { PipelineAStateType, BaselineSandboxHandle } from '../types.js'

export function getWorkspacePaths(targetProjectId: string): { containerPath: string; hostPath: string } {
  const testDataDir = process.env.TEST_DATA_DIR ?? '/data/chatops/test-runs'
  const hostTestDataDir = process.env.HOST_TEST_DATA_DIR ?? '/srv/chatops/test-runs'
  return {
    containerPath: join(testDataDir, 'workspaces', targetProjectId),
    hostPath: join(hostTestDataDir, 'workspaces', targetProjectId),
  }
}

async function ensureWorkspaceCloned(
  project: { id: string; gitlabRepo: string; defaultBranch: string },
  branch: string,
): Promise<void> {
  const { containerPath } = getWorkspacePaths(project.id)
  const cfg = await resolveGitlabConfig()
  if (!cfg.url || !cfg.token) throw new Error('GitLab config missing (url or token)')

  const repoPath = extractGitlabPath(project.gitlabRepo)
  const base = new URL(cfg.url.replace(/\/$/, ''))
  const authUrl = `${base.protocol}//oauth2:${cfg.token}@${base.host}/${repoPath}.git`

  if (!existsSync(containerPath)) {
    mkdirSync(dirname(containerPath), { recursive: true })
    execSync(`git clone --branch ${branch} --depth 1 ${authUrl} ${containerPath}`, {
      stdio: 'pipe',
      timeout: 120_000,
    })
  } else {
    execSync(
      `git -C ${containerPath} fetch origin ${branch} && git -C ${containerPath} reset --hard origin/${branch}`,
      { stdio: 'pipe', timeout: 60_000 },
    )
  }
}

export function runDockerScript(
  hostPath: string,
  scriptName: string,
  args: string[],
  timeoutMs = 300_000,
  envVars: Record<string, string> = {},
  network?: string,
) {
  const image = process.env.E2E_RUNNER_IMAGE ?? 'chatops-chatops:latest'
  const envArgs: string[] = []
  for (const [k, v] of Object.entries(envVars)) {
    envArgs.push('-e', `${k}=${v}`)
  }
  const networkArgs = network ? ['--network', network] : []
  const r = spawnSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${hostPath}:/workspace`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-w', '/workspace',
      ...networkArgs,
      ...envArgs,
      image,
      `/workspace/${scriptName}`,
      ...args,
    ],
    { encoding: 'utf8', timeout: timeoutMs, shell: false },
  )
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export async function setupBaselineSandboxNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { targetProjectId, baseBranch } = state
  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`project not found: ${targetProjectId}`)

  await ensureWorkspaceCloned(project, baseBranch)

  const { containerPath, hostPath } = getWorkspacePaths(targetProjectId)
  const handleFile = join(containerPath, 'e2e-handle-baseline.json')

  const provision = runDockerScript(hostPath, project.scripts.deploy, [
    'provision',
    `--branch=${baseBranch}`,
    '--out-handle=/workspace/e2e-handle-baseline.json',
  ])
  if (provision.status !== 0) throw new Error(`provision failed: ${provision.stderr.slice(0, 300)}`)

  const handleJson = JSON.parse(readFileSync(handleFile, 'utf8')) as Record<string, unknown>

  const sandboxRecord = await createSandbox({
    e2eRunId: null,
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    handle: handleJson as any,
  })

  const sandboxEnv: Record<string, string> = {
    BASE_IMAGE: process.env.E2E_SANDBOX_BASE_IMAGE ?? 'chatops-base:local',
    DOCKER_BUILDKIT: '0',
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    E2E_SANDBOX_DB_URL: process.env.E2E_SANDBOX_DB_URL ?? '',
  }
  const build = runDockerScript(hostPath, project.scripts.build, [], 600_000, sandboxEnv)
  if (build.status !== 0) {
    await updateSandboxStatus(sandboxRecord.id, 'failed')
    throw new Error(`build failed: ${build.stderr.slice(0, 300)}`)
  }

  const deploy = runDockerScript(hostPath, project.scripts.deploy, [
    'deploy',
    '--handle=/workspace/e2e-handle-baseline.json',
  ], 300_000, sandboxEnv)
  if (deploy.status !== 0) {
    await updateSandboxStatus(sandboxRecord.id, 'failed')
    throw new Error(`deploy failed: ${deploy.stderr.slice(0, 300)}`)
  }

  await updateSandboxStatus(sandboxRecord.id, 'ready', { readyAt: new Date() })

  const sandboxHandle: BaselineSandboxHandle = {
    envId: (handleJson.envId as string) ?? 'unknown',
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    endpoints: (handleJson.endpoints as Record<string, string>) ?? {},
    internalRefs: (handleJson.internalRefs as Record<string, unknown>) ?? {},
    sandboxId: sandboxRecord.id,
  }

  return { sandboxHandle }
}

export async function teardownBaselineSandboxNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { sandboxHandle, targetProjectId } = state
  if (sandboxHandle) {
    const project = await getE2eTargetProject(targetProjectId)
    if (project) {
      const { containerPath, hostPath } = getWorkspacePaths(targetProjectId)
      const handleFile = join(containerPath, 'e2e-handle-teardown.json')
      writeFileSync(handleFile, JSON.stringify(sandboxHandle))
      const result = runDockerScript(hostPath, project.scripts.deploy, [
        'teardown',
        '--handle=/workspace/e2e-handle-teardown.json',
      ])
      if (result.status !== 0) {
        console.warn(`[PipelineA:teardown] teardown failed: ${result.stderr.slice(0, 200)}`)
      }
      await updateSandboxStatus(sandboxHandle.sandboxId, 'torn_down', { destroyedAt: new Date() })
    }
  }

  const spec = state.specs[state.currentSpecIndex]
  const specWasCommitted = state.completedSpecs.some(c => c.specId === spec?.specId)
  const nextIndex = state.currentSpecIndex + 1

  if (spec && !specWasCommitted) {
    const finalStatus =
      state.diagnosisVerdict === 'product_bug'
        ? 'blocked_on_baseline_bug'
        : 'baseline_failed'
    await updateE2eSpecStatus(spec.specId, finalStatus)
  }

  return {
    sandboxHandle: null,
    currentSpecIndex: nextIndex,
    staticCheckAttempts: 0,
    baselineAttempts: 0,
    staticCheckResult: null,
    lastBaselineResult: null,
    diagnosisVerdict: null,
  }
}
