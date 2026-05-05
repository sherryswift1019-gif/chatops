// src/e2e/pipeline-b/nodes/init-run.ts
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { createE2eRun, updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { runScript } from '../run-script.js'
import { getWorkspacePaths, ensureWorkspaceCloned } from '../../workspace.js'
import type { PipelineBStateType } from '../types.js'

export async function initRunNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  // ---- cold-start: admin API 触发，没人预创建 e2e_runs row。先 createE2eRun 拿 runId
  let runId = state.runId
  if (!runId || runId === 0n) {
    const created = await createE2eRun({
      targetProjectId: state.targetProjectId,
      triggerType: 'api',
      triggerActor: null,
      sourceBranch: state.sourceBranch,
      iterationBranch: '',
      scenarioFilter: state.scenarioFilter,
      governorState: state.governorState as unknown as Record<string, unknown>,
    })
    runId = created.id
    console.log(`[PipelineB:initRun] cold-start: created e2e_runs row id=${runId}`)
  }

  const iterationBranch = `test-iter/${runId}`

  // ---- 把 target 项目 clone 到 workspace（容器内可见 /data/chatops/test-runs/.../<projectId>）
  // 后续 git fetch / checkout 在 workspace 里跑，避免 chatops 容器自身 /app 不是
  // git checkout 的问题。
  await ensureWorkspaceCloned(project, state.sourceBranch)
  const { containerPath } = getWorkspacePaths(state.targetProjectId)

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

  const fetchResult = await runScript('git', ['-C', containerPath, 'fetch', 'origin', state.sourceBranch], {
    timeout: 60_000,
    env: gitEnv,
  })
  if (fetchResult.exitCode !== 0) {
    throw new Error(`init-run: git fetch failed: ${fetchResult.stderr.slice(0, 300)}`)
  }

  const branchCheckResult = await runScript('git', ['-C', containerPath, 'branch', '-r', '--list', `origin/${iterationBranch}`], {
    timeout: 15_000,
  })
  if (branchCheckResult.exitCode !== 0) {
    throw new Error(`init-run: git branch check failed: ${branchCheckResult.stderr.slice(0, 300)}`)
  }
  const branchExists = branchCheckResult.stdout.trim().length > 0

  if (branchExists) {
    const checkoutResult = await runScript('git', ['-C', containerPath, 'checkout', iterationBranch], {
      timeout: 30_000,
      env: gitEnv,
    })
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`init-run: git checkout existing branch failed: ${checkoutResult.stderr.slice(0, 300)}`)
    }
    const resetResult = await runScript('git', ['-C', containerPath, 'reset', '--hard', `origin/${iterationBranch}`], {
      timeout: 30_000,
      env: gitEnv,
    })
    if (resetResult.exitCode !== 0) {
      throw new Error(`init-run: git reset --hard failed: ${resetResult.stderr.slice(0, 300)}`)
    }
  } else {
    const checkoutResult = await runScript(
      'git',
      ['-C', containerPath, 'checkout', '-b', iterationBranch, `origin/${state.sourceBranch}`],
      { timeout: 30_000, env: gitEnv },
    )
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`init-run: git checkout -b failed: ${checkoutResult.stderr.slice(0, 300)}`)
    }
  }

  await updateE2eRunStatus(runId, 'running')

  console.log(`[PipelineB:initRun] runId=${runId} sourceBranch=${state.sourceBranch} iterationBranch=${iterationBranch} workspace=${containerPath}`)
  return {
    runId,
    iterationBranch,
    projectScripts: project.scripts ?? { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
  }
}
