// src/e2e/pipeline-b/nodes/reset-iteration-branch.ts
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function resetIterationBranchNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

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

  const fetchResult = await runScript('git', ['-C', workDir, 'fetch', 'origin'], {
    timeout: 60_000,
    env: gitEnv,
  })
  if (fetchResult.exitCode !== 0) {
    throw new Error(`reset-iteration-branch: git fetch failed: ${fetchResult.stderr.slice(0, 300)}`)
  }

  const resetResult = await runScript('git', ['-C', workDir, 'reset', '--hard', `origin/${state.sourceBranch}`], {
    timeout: 30_000,
  })
  if (resetResult.exitCode !== 0) {
    throw new Error(`reset-iteration-branch: git reset failed: ${resetResult.stderr.slice(0, 300)}`)
  }

  console.log(`[PipelineB:resetIterationBranch] runId=${state.runId} reset to origin/${state.sourceBranch}`)
  return {}
}
