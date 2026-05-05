// src/e2e/pipeline-a/nodes/static-check.ts
//
// playbook YAML 静态校验：解析 YAML + 跑 zod schema 校验。失败时 lastError 写
// 详细 issues 列表，让 LLM 在下一轮 generate 时自修。
import { parsePlaybookYaml } from '../../pipeline-b/playbook/parse.js'
import type { PipelineAStateType } from '../types.js'

export async function staticCheckNode(
  state: PipelineAStateType,
): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec || !spec.generatedContent) {
    return {
      staticCheckResult: 'fail',
      staticCheckAttempts: state.staticCheckAttempts + 1,
      lastError: 'spec.generatedContent 为空，LLM 没产出',
    }
  }

  const parsed = parsePlaybookYaml(spec.generatedContent)
  if (parsed.ok) {
    return { staticCheckResult: 'pass', lastError: null }
  }

  const issues = parsed.issues?.map((i) => `  - ${i.path}: ${i.message}`).join('\n') ?? ''
  const errorText = `playbook YAML schema 校验失败: ${parsed.error}${issues ? `\n${issues}` : ''}`
  console.warn(`[PipelineA:staticCheck] ${errorText.slice(0, 500)}`)
  return {
    staticCheckResult: 'fail',
    staticCheckAttempts: state.staticCheckAttempts + 1,
    lastError: errorText,
  }
}
