// src/e2e/pipeline-b/startup-recovery.ts
import { writeFile, unlink, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  listInflightE2eRuns,
  updateE2eRunStatus,
} from '../../db/repositories/e2e-runs.js'
import {
  getSandboxByRunId,
  updateSandboxStatus,
} from '../../db/repositories/e2e-sandboxes.js'
import { getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { runScript } from './run-script.js'

async function teardownSandboxBestEffort(
  sandboxId: bigint,
  sandboxHandle: Record<string, unknown>,
  deployScript: string,
  cwd: string,
): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'e2e-recovery-'))
  const handleFile = join(tmpDir, 'handle.json')
  await writeFile(handleFile, JSON.stringify(sandboxHandle), 'utf8')

  try {
    const result = await runScript(deployScript, ['teardown', `--handle=${handleFile}`], {
      timeout: 60_000,
      cwd,
    })
    if (result.exitCode !== 0) {
      throw new Error(`teardown exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`)
    }
  } finally {
    await unlink(handleFile).catch(() => undefined)
  }

  await updateSandboxStatus(sandboxId, 'torn_down', { destroyedAt: new Date() })
}

async function deleteRemoteBranchBestEffort(
  gitlabRepo: string,
  branch: string,
): Promise<void> {
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) return

  const encodedRepo = encodeURIComponent(gitlabRepo)
  const encodedBranch = encodeURIComponent(branch)
  const apiUrl = `${url.replace(/\/$/, '')}/api/v4/projects/${encodedRepo}/repository/branches/${encodedBranch}`

  const resp = await fetch(apiUrl, {
    method: 'DELETE',
    headers: { 'PRIVATE-TOKEN': token },
  })

  if (resp.status !== 204 && resp.status !== 404) {
    throw new Error(`GitLab branch delete returned ${resp.status} for ${branch}`)
  }
}

export async function recoverInflightE2eRuns(): Promise<void> {
  const stuck = await listInflightE2eRuns()
  if (stuck.length === 0) return

  console.log(`[E2eRecovery] found ${stuck.length} inflight run(s) — marking aborted`)

  for (const run of stuck) {
    await updateE2eRunStatus(run.id, 'aborted', {
      finishedAt: new Date(),
      abortReason: 'process_restart',
    })

    const sandbox = await getSandboxByRunId(run.id)

    if (sandbox && sandbox.status !== 'torn_down' && sandbox.status !== 'failed') {
      const project = await getE2eTargetProject(run.targetProjectId).catch(() => null)
      const workDir = project?.workingDir ?? '.'
      const deployScriptName = project?.scripts.deploy ?? 'deploy.sh'
      const deployScript = join(workDir, deployScriptName)
      const handle = sandbox.handle as unknown as Record<string, unknown>
      await teardownSandboxBestEffort(sandbox.id, handle, deployScript, workDir).catch((err) => {
        console.error(`[E2eRecovery] teardown failed for sandbox ${sandbox.id}:`, err)
      })
    }

    const project = await getE2eTargetProject(run.targetProjectId).catch(() => null)
    const gitlabRepo = project?.gitlabRepo ?? run.targetProjectId
    await deleteRemoteBranchBestEffort(gitlabRepo, run.iterationBranch).catch((err) => {
      console.error(`[E2eRecovery] branch delete failed for ${run.iterationBranch}:`, err)
    })

    console.log(`[E2eRecovery] recovered run ${run.id}: aborted + teardown`)
  }
}
