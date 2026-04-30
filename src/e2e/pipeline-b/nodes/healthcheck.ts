// src/e2e/pipeline-b/nodes/healthcheck.ts
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function healthcheckNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  if (!state.sandboxHandle) throw new Error('healthcheck: sandboxHandle is null')

  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const deployScript = join(workDir, state.projectScripts.deploy)
  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-hc-'))
  const handleFile = join(handleDir, 'handle.json')
  writeFileSync(handleFile, JSON.stringify(state.sandboxHandle))

  const result = await runScript(
    deployScript,
    ['healthcheck', `--handle=${handleFile}`],
    { timeout: 60_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    throw new Error(`healthcheck: sandbox not healthy (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
  }

  console.log(`[PipelineB:healthcheck] runId=${state.runId} sandbox healthy`)
  return {}
}
