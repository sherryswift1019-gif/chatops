import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { getWorkspacePaths, runDockerScript } from './baseline-sandbox.js'
import type { PipelineAStateType, BaselineResult } from '../types.js'

export async function runBaselineCheckNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec) return {}

  const project = await getE2eTargetProject(spec.targetProjectId)
  if (!project) throw new Error(`project not found: ${spec.targetProjectId}`)

  const scenarioId = spec.specPath.split('/').pop()!.replace('.md', '')
  const { containerPath, hostPath } = getWorkspacePaths(spec.targetProjectId)

  // 把生成的测试文件写到 workspace（target project 克隆目录），DooD 执行时可读
  if (spec.scriptPath && spec.generatedContent) {
    const testFilePath = join(containerPath, spec.scriptPath)
    mkdirSync(dirname(testFilePath), { recursive: true })
    writeFileSync(testFilePath, spec.generatedContent, 'utf8')
    console.log(`[PipelineA:baselineCheck] wrote test to ${testFilePath}`)
  }

  // evidence 落在 workspace 里，DooD 内路径为 /workspace/e2e-evidence/...
  const evidenceDirRelative = `e2e-evidence/baseline-${spec.specId}-attempt-${state.baselineAttempts + 1}`
  const evidenceDirInContainer = join(containerPath, evidenceDirRelative)
  mkdirSync(evidenceDirInContainer, { recursive: true })

  const apiPort = (state.sandboxHandle?.internalRefs?.apiPort as number | undefined) ?? 3000
  const sandboxUrl = `http://chatops-e2e-${apiPort}:3000`

  console.log(`[PipelineA:baselineCheck] attempt ${state.baselineAttempts + 1}: scenario=${scenarioId} sandboxUrl=${sandboxUrl}`)

  // 通过 DooD 在 workspace 里跑 test.sh，加入 chatops_default 网络让 playwright 能访问沙盒容器
  const result = runDockerScript(
    hostPath,
    'test.sh',
    [`--scenario`, scenarioId, `--evidence-dir=/workspace/${evidenceDirRelative}`],
    300_000,
    { SANDBOX_URL: sandboxUrl },
    'chatops_default',
  )

  const passed = result.status === 0
  const lastLine = (result.stdout ?? '').trim().split('\n').pop() ?? ''
  let summary = `Baseline check ${passed ? 'PASSED' : 'FAILED'} for ${scenarioId}`
  try {
    summary = JSON.parse(lastLine)?.summary ?? summary
  } catch {
    /* ignore */
  }

  const baselineResult: BaselineResult = {
    specId: spec.specId,
    passed,
    evidenceDir: evidenceDirInContainer,
    evidenceSummary: summary,
  }

  console.log(`[PipelineA:baselineCheck] attempt ${state.baselineAttempts + 1}: ${passed ? 'PASS' : 'FAIL'} - ${summary}`)
  if (!passed) {
    console.log(`[PipelineA:baselineCheck] stderr: ${(result.stderr ?? '').slice(0, 500)}`)
    console.log(`[PipelineA:baselineCheck] stdout last: ${lastLine}`)
  }
  return {
    lastBaselineResult: baselineResult,
    baselineAttempts: state.baselineAttempts + 1,
  }
}
