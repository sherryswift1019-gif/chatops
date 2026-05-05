// src/e2e/pipeline-b/nodes/deploy-initial.ts
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { runScript } from '../run-script.js'
import { getWorkspacePaths } from '../../workspace.js'
import type { PipelineBStateType } from '../types.js'

export async function deployInitialNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  if (!state.sandboxHandle) throw new Error('deploy-initial: sandboxHandle is null')

  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = getWorkspacePaths(state.targetProjectId).containerPath
  const buildScript = join(workDir, state.projectScripts.build)
  const deployScript = join(workDir, state.projectScripts.deploy)

  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-deploy-'))
  const handleFile = join(handleDir, 'handle.json')
  writeFileSync(handleFile, JSON.stringify(state.sandboxHandle))

  const imageName = `chatops-e2e-${state.runId}`
  const imageTag = `iter-${state.iterationBranch.replace(/\//g, '-')}`

  const buildResult = await runScript(buildScript, [], {
    timeout: 900_000,
    cwd: workDir,
    env: {
      IMAGE_NAME: imageName,
      IMAGE_TAG: imageTag,
    },
  })

  if (buildResult.exitCode !== 0) {
    throw new Error(`deploy-initial: build failed (exit ${buildResult.exitCode}): ${buildResult.stderr.slice(0, 400)}`)
  }

  const deployResult = await runScript(
    deployScript,
    ['deploy', `--handle=${handleFile}`],
    { timeout: 300_000, cwd: workDir },
  )

  if (deployResult.exitCode !== 0) {
    throw new Error(`deploy-initial: deploy failed (exit ${deployResult.exitCode}): ${deployResult.stderr.slice(0, 400)}`)
  }

  console.log(`[PipelineB:deployInitial] runId=${state.runId} build+deploy ok`)
  return {}
}
