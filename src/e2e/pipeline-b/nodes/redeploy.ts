// src/e2e/pipeline-b/nodes/redeploy.ts
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { updateSandboxStatus } from '../../../db/repositories/e2e-sandboxes.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function redeployNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  if (!state.sandboxHandle) throw new Error('redeploy: sandboxHandle is null')

  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const deployScript = join(workDir, state.projectScripts.deploy)
  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-redeploy-'))
  const handleFile = join(handleDir, 'handle.json')
  writeFileSync(handleFile, JSON.stringify(state.sandboxHandle))

  if (state.sandboxId) {
    await updateSandboxStatus(state.sandboxId, 'redeploying').catch((err) => {
      console.warn(`[PipelineB:redeploy] updateSandboxStatus(redeploying) failed: ${err}`)
    })
  }

  const result = await runScript(
    deployScript,
    ['redeploy', `--handle=${handleFile}`],
    { timeout: 300_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    if (state.sandboxId) {
      await updateSandboxStatus(state.sandboxId, 'failed').catch((err) => {
        console.warn(`[PipelineB:redeploy] updateSandboxStatus(failed) failed: ${err}`)
      })
    }
    throw new Error(`redeploy: failed (exit ${result.exitCode}): ${result.stderr.slice(0, 400)}`)
  }

  if (state.sandboxId) {
    await updateSandboxStatus(state.sandboxId, 'ready').catch((err) => {
      console.warn(`[PipelineB:redeploy] updateSandboxStatus(ready) failed: ${err}`)
    })
  }

  console.log(`[PipelineB:redeploy] runId=${state.runId} redeployed ok`)
  return {}
}
