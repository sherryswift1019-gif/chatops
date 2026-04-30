// src/e2e/pipeline-b/nodes/setup-sandbox.ts
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { createSandbox, updateSandboxStatus } from '../../../db/repositories/e2e-sandboxes.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType, SandboxHandle } from '../types.js'

export async function setupSandboxNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const deployScript = join(workDir, state.projectScripts.deploy)
  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-handle-'))
  const handleFile = join(handleDir, 'handle.json')

  const result = await runScript(
    deployScript,
    ['provision', `--branch=${state.sourceBranch}`, `--out-handle=${handleFile}`],
    { timeout: 600_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    await updateE2eRunStatus(state.runId, 'failed', { abortReason: `provision failed: ${result.stderr.slice(0, 300)}` })
    throw new Error(`setup-sandbox: provision failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
  }

  let handleJson: Record<string, unknown>
  try {
    handleJson = JSON.parse(readFileSync(handleFile, 'utf8'))
  } catch (err) {
    throw new Error(`setup-sandbox: failed to read handle file: ${err}`)
  }

  const sandboxRecord = await createSandbox({
    e2eRunId: state.runId,
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    handle: {
      envId: handleJson.envId as string,
      kind: (handleJson.kind as string) ?? 'docker-compose-local',
      endpoints: (handleJson.endpoints as Record<string, string>) ?? {},
      internalRefs: (handleJson.internalRefs as Record<string, unknown>) ?? {},
    },
  })

  const sandboxHandle: SandboxHandle = {
    envId: handleJson.envId as string,
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    endpoints: (handleJson.endpoints as Record<string, string>) ?? {},
    internalRefs: (handleJson.internalRefs as Record<string, unknown>) ?? {},
    containerId: handleJson.containerId as string | undefined,
    workdir: handleJson.workdir as string | undefined,
  }

  await updateSandboxStatus(sandboxRecord.id, 'ready', { readyAt: new Date() })

  console.log(`[PipelineB:setupSandbox] runId=${state.runId} sandboxId=${sandboxRecord.id} envId=${sandboxHandle.envId}`)
  return {
    sandboxId: sandboxRecord.id,
    sandboxHandle,
  }
}
