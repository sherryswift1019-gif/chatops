// src/e2e/pipeline-b/nodes/init-run.ts
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function initRunNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  if (state.runId && state.runId !== 0n) {
    // existingRunId 已由 runner 传入（coordinator handler 预创建），跳过 createE2eRun
    await updateE2eRunStatus(state.runId, 'running')
    const project = await getE2eTargetProject(state.targetProjectId)
    if (!project) throw new Error(`e2e target project not found: ${state.targetProjectId}`)
    return {
      iterationBranch: `test-iter/${state.runId}`,
      projectScripts: project.scripts ?? { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
    }
  }

  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const iterationBranch = `test-iter/${state.runId}`
  const workDir = project.workingDir ?? '.'

  const gitlabConfig = await resolveGitlabConfig()
  const gitEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    ...(gitlabConfig.token
      ? {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraheader',
          GIT_CONFIG_VALUE_0: `PRIVATE-TOKEN: ${gitlabConfig.token}`,
        }
      : {}),
  }

  const fetchResult = await runScript('git', ['-C', workDir, 'fetch', 'origin', state.sourceBranch], {
    timeout: 60_000,
    env: gitEnv,
  })
  if (fetchResult.exitCode !== 0) {
    throw new Error(`init-run: git fetch failed: ${fetchResult.stderr.slice(0, 300)}`)
  }

  const branchCheckResult = await runScript('git', ['-C', workDir, 'branch', '-r', '--list', `origin/${iterationBranch}`], {
    timeout: 15_000,
  })
  if (branchCheckResult.exitCode !== 0) {
    throw new Error(`init-run: git branch check failed: ${branchCheckResult.stderr.slice(0, 300)}`)
  }
  const branchExists = branchCheckResult.stdout.trim().length > 0

  if (branchExists) {
    const checkoutResult = await runScript('git', ['-C', workDir, 'checkout', iterationBranch], {
      timeout: 30_000,
      env: gitEnv,
    })
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`init-run: git checkout existing branch failed: ${checkoutResult.stderr.slice(0, 300)}`)
    }
    const resetResult = await runScript('git', ['-C', workDir, 'reset', '--hard', `origin/${iterationBranch}`], {
      timeout: 30_000,
      env: gitEnv,
    })
    if (resetResult.exitCode !== 0) {
      throw new Error(`init-run: git reset --hard failed: ${resetResult.stderr.slice(0, 300)}`)
    }
  } else {
    const checkoutResult = await runScript(
      'git',
      ['-C', workDir, 'checkout', '-b', iterationBranch, `origin/${state.sourceBranch}`],
      { timeout: 30_000, env: gitEnv },
    )
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`init-run: git checkout -b failed: ${checkoutResult.stderr.slice(0, 300)}`)
    }
  }

  await updateE2eRunStatus(state.runId, 'running')

  console.log(`[PipelineB:initRun] runId=${state.runId} sourceBranch=${state.sourceBranch} iterationBranch=${iterationBranch}`)
  return { iterationBranch }
}
