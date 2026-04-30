// src/e2e/pipeline-b/nodes/init-run.ts
import { spawn } from 'child_process'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import type { PipelineBStateType } from '../types.js'

async function gitExec(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}

export async function initRunNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const iterationBranch = `test-iter/${state.runId}`
  const workDir = project.workingDir ?? '.'

  const gitlabConfig = await resolveGitlabConfig()
  const gitEnv: Record<string, string> = gitlabConfig.token
    ? { GIT_ASKPASS: 'echo', GIT_TOKEN: gitlabConfig.token }
    : {}

  const fetchResult = await gitExec(
    ['-C', workDir, 'fetch', 'origin', state.sourceBranch],
    { env: gitEnv },
  )
  if (fetchResult.exitCode !== 0) {
    throw new Error(`init-run: git fetch failed: ${fetchResult.stderr.slice(0, 300)}`)
  }

  const branchCheckResult = await gitExec(['-C', workDir, 'branch', '-r', '--list', `origin/${iterationBranch}`])
  const branchExists = branchCheckResult.stdout.trim().length > 0

  if (branchExists) {
    const checkoutResult = await gitExec(
      ['-C', workDir, 'checkout', iterationBranch],
      { env: gitEnv },
    )
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`init-run: git checkout existing branch failed: ${checkoutResult.stderr.slice(0, 300)}`)
    }
  } else {
    const checkoutResult = await gitExec(
      ['-C', workDir, 'checkout', '-b', iterationBranch, `origin/${state.sourceBranch}`],
      { env: gitEnv },
    )
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`init-run: git checkout -b failed: ${checkoutResult.stderr.slice(0, 300)}`)
    }
  }

  await updateE2eRunStatus(state.runId, 'running')

  console.log(`[PipelineB:initRun] runId=${state.runId} iterationBranch=${iterationBranch}`)
  return { iterationBranch }
}
