import { spawnSync } from 'child_process'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { createSandbox, updateSandboxStatus } from '../../../db/repositories/e2e-sandboxes.js'
import { updateE2eSpecStatus } from '../../../db/repositories/e2e-specs.js'
import type { PipelineAStateType, BaselineSandboxHandle } from '../types.js'

function runScript(scriptPath: string, args: string[], timeoutMs = 300_000) {
  const r = spawnSync(scriptPath, args, { encoding: 'utf8', timeout: timeoutMs, shell: false })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export async function setupBaselineSandboxNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { targetProjectId, baseBranch } = state
  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`project not found: ${targetProjectId}`)

  const deployScript = join(project.workingDir, project.scripts.deploy)
  const buildScript = join(project.workingDir, project.scripts.build)

  // Step 1: provision — parse handle JSON from stdout
  const provision = runScript(deployScript, [`provision`, `--branch=${baseBranch}`])
  if (provision.status !== 0) throw new Error(`provision failed: ${provision.stderr.slice(0, 300)}`)

  let handleJson: Record<string, unknown> = {}
  try { handleJson = JSON.parse(provision.stdout.trim()) } catch { handleJson = {} }

  const sandboxRecord = await createSandbox({
    e2eRunId: null,
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    handle: handleJson as any,
  })

  // Step 2: build
  const build = runScript(buildScript, [], 600_000)
  if (build.status !== 0) {
    await updateSandboxStatus(sandboxRecord.id, 'failed')
    throw new Error(`build failed: ${build.stderr.slice(0, 300)}`)
  }

  // Step 3: deploy
  const deploy = runScript(deployScript, [`deploy`])
  if (deploy.status !== 0) {
    await updateSandboxStatus(sandboxRecord.id, 'failed')
    throw new Error(`deploy failed: ${deploy.stderr.slice(0, 300)}`)
  }

  await updateSandboxStatus(sandboxRecord.id, 'ready', { readyAt: new Date() })

  const sandboxHandle: BaselineSandboxHandle = {
    envId: (handleJson.envId as string) ?? 'unknown',
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    endpoints: (handleJson.endpoints as Record<string, string>) ?? {},
    internalRefs: (handleJson.internalRefs as Record<string, unknown>) ?? {},
    sandboxId: sandboxRecord.id,
  }

  return { sandboxHandle }
}

export async function teardownBaselineSandboxNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { sandboxHandle, targetProjectId } = state
  if (sandboxHandle) {
    const project = await getE2eTargetProject(targetProjectId)
    if (project) {
      const deployScript = join(project.workingDir, project.scripts.deploy)
      const handleFile = join(tmpdir(), `e2e-handle-teardown-${sandboxHandle.envId}.json`)
      writeFileSync(handleFile, JSON.stringify(sandboxHandle))
      const result = runScript(deployScript, [`teardown`, `--handle=${handleFile}`])
      if (result.status !== 0) {
        console.warn(`[PipelineA:teardown] teardown failed: ${result.stderr.slice(0, 200)}`)
      }
      await updateSandboxStatus(sandboxHandle.sandboxId, 'torn_down', { destroyedAt: new Date() })
    }
  }

  const spec = state.specs[state.currentSpecIndex]
  const specWasCommitted =
    state.completedSpecs.length > 0 &&
    state.completedSpecs[state.completedSpecs.length - 1].specId === spec?.specId
  const nextIndex = specWasCommitted ? state.currentSpecIndex : state.currentSpecIndex + 1

  // 未经 commit_and_pr 成功路径到达 teardown 时，标记当前 spec 为失败状态
  if (spec && !specWasCommitted) {
    const finalStatus =
      state.diagnosisVerdict === 'product_bug'
        ? 'blocked_on_baseline_bug'
        : 'baseline_failed'
    await updateE2eSpecStatus(spec.specId, finalStatus)
  }

  return {
    sandboxHandle: null,
    currentSpecIndex: nextIndex,
    staticCheckAttempts: 0,
    baselineAttempts: 0,
    staticCheckResult: null,
    lastBaselineResult: null,
    diagnosisVerdict: null,
  }
}
