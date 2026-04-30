import { readFileSync } from 'fs'
import { join } from 'path'
import { executeCapabilityDirectForE2e } from '../llm-bridge.js'
import type { PipelineAStateType, DiagnosisVerdict } from '../types.js'

export async function diagnoseBaselineNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { lastBaselineResult, specs, currentSpecIndex } = state
  const spec = specs[currentSpecIndex]
  if (!lastBaselineResult || !spec) return { diagnosisVerdict: 'script_bug' }

  const evidenceDir = lastBaselineResult.evidenceDir ?? ''
  let evidenceSummary = lastBaselineResult.evidenceSummary ?? ''
  let manifestContent = ''
  try {
    manifestContent = readFileSync(join(evidenceDir, 'manifest.json'), 'utf8')
  } catch {
    /* evidence dir may not exist in test */
  }

  const prompt = `你是一个 QA 工程师，需要诊断以下 Playwright baseline 测试失败的根因。

spec 路径: ${spec.specPath}
失败摘要: ${evidenceSummary}
证据 manifest:
${manifestContent || '(无证据文件)'}

判断规则：
- 如果失败原因是"选择器错误、断言逻辑错误、时序假设错误、import 错误"等，判定为 script_bug
- 如果失败原因是"功能本身就是坏的、API 返回错误 response、数据库错误"等，判定为 product_bug
- 默认倾向 script_bug（baseline 理应是绿色的）

请只输出一个 JSON：{"verdict": "script_bug"} 或 {"verdict": "product_bug"}，不要其他文字。`

  const output = await executeCapabilityDirectForE2e(prompt, `diagnose-baseline-${spec.specId}`)

  let verdict: DiagnosisVerdict = 'script_bug'
  try {
    const match = output.match(/"verdict"\s*:\s*"(script_bug|product_bug)"/)
    if (match) verdict = match[1] as DiagnosisVerdict
  } catch {
    /* default */
  }

  console.log(`[PipelineA:diagnose] spec ${spec.specId}: verdict=${verdict}`)
  return { diagnosisVerdict: verdict }
}

export async function fixScriptNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { lastBaselineResult, specs, currentSpecIndex } = state
  const spec = specs[currentSpecIndex]
  if (!spec?.scriptPath) return {}

  const evidenceSummary = lastBaselineResult?.evidenceSummary ?? 'baseline failed'

  const prompt = `你是一个 Playwright 测试工程师，需要修复以下测试脚本中的 bug。

脚本路径: ${spec.scriptPath}
失败原因: ${evidenceSummary}

请输出修复后的完整 TypeScript 文件内容（包含所有 import 语句），不要任何解释。`

  const fixedContent = await executeCapabilityDirectForE2e(prompt, `fix-script-${spec.specId}`)

  const updatedSpec = { ...spec, generatedContent: fixedContent }
  const updatedSpecs = [...state.specs]
  updatedSpecs[state.currentSpecIndex] = updatedSpec

  return { specs: updatedSpecs, lastError: null }
}
