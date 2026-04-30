// src/e2e/pipeline-b/nodes/teardown-sandbox.ts
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { updateSandboxStatus } from '../../../db/repositories/e2e-sandboxes.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function teardownSandboxNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { sandboxHandle, sandboxId, runId, targetProjectId } = state

  if (!sandboxHandle) {
    console.log(`[PipelineB:teardownSandbox] runId=${runId} no sandboxHandle, skipping`)
    return {}
  }

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) {
    console.warn(`[PipelineB:teardownSandbox] project not found, skipping teardown`)
    return { sandboxHandle: null }
  }

  const workDir = project.workingDir ?? '.'
  const deployScript = join(workDir, state.projectScripts.deploy)
  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-teardown-'))
  const handleFile = join(handleDir, 'handle.json')
  writeFileSync(handleFile, JSON.stringify(sandboxHandle))

  const result = await runScript(
    deployScript,
    ['teardown', `--handle=${handleFile}`],
    { timeout: 120_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    console.warn(`[PipelineB:teardownSandbox] teardown exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`)
  }

  if (sandboxId) {
    await updateSandboxStatus(sandboxId, 'torn_down', { destroyedAt: new Date() }).catch((err) => {
      console.warn(`[PipelineB:teardownSandbox] updateSandboxStatus failed: ${err}`)
    })
  }

  console.log(`[PipelineB:teardownSandbox] runId=${runId} envId=${sandboxHandle.envId} torn down`)
  return { sandboxHandle: null }
}
