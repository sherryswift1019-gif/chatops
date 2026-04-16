import { registerCapabilityHandler } from '../coordinator.js'
import { getTool } from '../tools/index.js'
import { mask } from '../masking/sensitive-info.js'
import { updateMrLabels } from '../../adapters/gitlab/labels.js'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import type { ClaudeRunner } from '../claude-runner.js'

let runner: ClaudeRunner | null = null
export function setReviewClaudeRunner(r: ClaudeRunner): void { runner = r }

const REVIEW_SYSTEM_PROMPT = `你是一个独立的代码审查专家。你的职责是审查 Merge Request 的 diff，从"这个改动有没有问题"的视角检查。

## 审查清单
1. **方案一致性**：改动是否与分析报告中的推荐方案一致？
2. **遗漏检查**：是否还有遗漏的修改点？
3. **代码质量**：变量命名、代码结构、错误处理是否合理？
4. **安全检查**：是否引入 SQL 注入、XSS、敏感信息泄露等风险？
5. **副作用**：改动是否影响其他模块？

## 输出格式
对每个问题给出：
- 文件名 + 行号
- 问题描述
- 风险等级（high / medium / low）
- 建议

## 最终结论
- **ai-approved**：无高风险问题，可以合并
- **ai-needs-attention**：存在需要人工关注的问题

你必须使用 review_mr_diff 工具读取 MR diff。
`

async function handleReviewMr(opts: TriggerOptions): Promise<TriggerResult> {
  const mrIid = opts.extraParams?.mrIid as number | undefined
  const projectPath = opts.extraParams?.projectPath as string | undefined

  if (!mrIid || !projectPath) {
    return { success: false, error: '缺少 mrIid 或 projectPath' }
  }

  console.log(`[ReviewAgent] reviewing MR !${mrIid} in ${projectPath}`)

  if (!runner) return { success: false, error: 'ClaudeRunner 未初始化' }

  const tools = [getTool('review_mr_diff')].filter(Boolean) as any[]

  const rawOutput = await runner.executeCapabilityDirect({
    prompt: `请审查 MR !${mrIid}（项目 ${projectPath}）。使用 review_mr_diff 工具读取 diff 后给出审查结论。`,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    context: opts.context,
    tools,
    sessionKey: `review-mr-${mrIid}`,
  })

  const output = mask(rawOutput)
  const approved = output.includes('ai-approved') || output.includes('可以合并') || output.includes('无高风险')
  const label = approved ? 'ai-approved' : 'ai-needs-attention'

  // 在 MR 上添加 Review 结论标签
  await updateMrLabels(projectPath, mrIid, { add: [label] }).catch(err =>
    console.error(`[ReviewAgent] MR !${mrIid} label 更新失败:`, err)
  )

  return {
    success: true,
    output: `Review 完成（${label}）:\n\n${output}`,
    data: { label, mrIid },
  }
}

export function registerReviewHandler(): void {
  registerCapabilityHandler('ai_review_mr', handleReviewMr)
  console.log('[ReviewAgent] ai_review_mr handler registered')
}

export { REVIEW_SYSTEM_PROMPT }
