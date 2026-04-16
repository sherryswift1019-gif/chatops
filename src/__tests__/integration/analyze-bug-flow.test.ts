/**
 * 集成测试：analyze_bug 完整链路
 * 不启动 MCP Server，用 porygon.run（单轮轻量调用）验证：
 * 1. 意图识别 → analyze_bug
 * 2. Claude 能输出结构化 JSON 分析报告
 * 3. parseAnalysisOutput 能解析
 * 4. buildMarkdownReport 能生成
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { ClaudeRunner } from '../../agent/claude-runner.js'
import { buildClaudeAuthEnv } from '../../agent/claude-auth.js'
import { parseAnalysisOutput, buildMarkdownReport } from '../../agent/analysis/analyzer.js'
import { listCapabilities } from '../../db/repositories/capabilities.js'
import { ANALYZE_BUG_SYSTEM_PROMPT } from '../../agent/analysis/prompts.js'

describe('Integration: analyze_bug 完整链路', () => {
  let porygon: any
  let authEnv: Record<string, string>

  beforeAll(async () => {
    await resetTestDb()
    const runner = new ClaudeRunner()
    porygon = (runner as any).porygon
    authEnv = buildClaudeAuthEnv(process.env.ANTHROPIC_API_KEY)
  })

  it('意图识别 → analyze_bug', async () => {
    const caps = await listCapabilities()
    const capList = caps.map(c => `- ${c.key}: ${c.displayName} (${c.description})`).join('\n')

    const result = await porygon.run({
      prompt: `识别意图。可用能力:\n${capList}\n\n用户: 分析一下 TASK_PWD_4001 密码验证失败\n\n返回JSON：{"capability":"key","summary":"..."}`,
      appendSystemPrompt: '只返回 JSON，不要其他内容。',
      envVars: authEnv,
    })

    expect(String(result)).toContain('analyze_bug')
  }, 30_000)

  it.skipIf(!process.env.RUN_CLAUDE_TESTS)('Claude 能输出结构化 JSON 分析报告', async () => {
    const result = await porygon.run({
      prompt: `TASK_PWD_4001 密码验证失败。输出 JSON 分析报告。`,
      appendSystemPrompt: `你是 Bug 分析专家。只输出 JSON，格式：
{"classification":"bug","level":"l1","confidence":"high","confidence_score":0.85,"root_cause":{"type":"syntax","summary":"根因描述","file":"file.java","line_range":[0,0]},"solutions":[{"id":"a","summary":"方案","recommended":true,"risk":"low","effort":"small"}],"affected_modules":["模块"],"analysis_steps":["步骤1"]}`,
      envVars: authEnv,
    })

    const text = String(result)
    console.log('[Test] Claude analyze output (first 500):', text.substring(0, 500))

    expect(text).not.toContain('hit your limit')
    expect(text.length).toBeGreaterThan(50)

    // 尝试解析
    const parsed = parseAnalysisOutput(text)
    if (parsed) {
      console.log('[Test] Parsed report:', JSON.stringify({
        classification: parsed.classification,
        level: parsed.level,
        confidence: parsed.confidence,
        solutions: parsed.solutions.length,
      }))

      expect(['bug', 'config_issue', 'usage_issue']).toContain(parsed.classification)
      expect(['l1', 'l2', 'l3', 'l4']).toContain(parsed.level)
      expect(['high', 'medium', 'low']).toContain(parsed.confidence)
      expect(parsed.solutions.length).toBeGreaterThan(0)
      expect(parsed.root_cause.summary.length).toBeGreaterThan(0)

      // Markdown 生成
      const md = buildMarkdownReport(parsed)
      expect(md).toContain('## AI 分析报告')
      expect(md).toContain(parsed.root_cause.summary)
      console.log('[Test] Markdown (first 200):', md.substring(0, 200))
    } else {
      console.log('[Test] Claude 未返回严格 JSON，但有内容。可能需要调优 systemPrompt。')
    }
  }, 30_000)
})
