import { describe, it, expect } from 'vitest'
import { parseAnalysisOutput, buildMarkdownReport } from '../../agent/analysis/analyzer.js'

describe('parseAnalysisOutput', () => {
  it('parses valid JSON from Claude output', () => {
    const text = `分析完成，以下是结果：
{
  "classification": "bug",
  "level": "l1",
  "confidence": "high",
  "confidence_score": 0.85,
  "root_cause": {
    "type": "syntax",
    "summary": "初始化 SQL 缺少错误码",
    "file": "sql/init.sql",
    "line_range": [10, 15]
  },
  "solutions": [
    { "id": "option-a", "summary": "添加 INSERT 语句", "recommended": true, "risk": "low", "effort": "small" }
  ],
  "affected_modules": ["pas-secret-task"],
  "analysis_steps": ["Phase 1: 读代码", "Phase 2: 对比"]
}`

    const result = parseAnalysisOutput(text)
    expect(result).not.toBeNull()
    expect(result!.classification).toBe('bug')
    expect(result!.level).toBe('l1')
    expect(result!.confidence).toBe('high')
    expect(result!.confidence_score).toBe(0.85)
    expect(result!.solutions).toHaveLength(1)
    expect(result!.solutions[0].recommended).toBe(true)
    expect(result!.affected_modules).toContain('pas-secret-task')
  })

  it('returns null for text without JSON', () => {
    expect(parseAnalysisOutput('这是一段普通文本')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseAnalysisOutput('{ "classification": bug }')).toBeNull()
  })
})

describe('buildMarkdownReport', () => {
  it('generates readable markdown', () => {
    const output = {
      classification: 'bug' as const,
      level: 'l2' as const,
      confidence: 'medium' as const,
      confidence_score: 0.65,
      root_cause: { type: 'business_logic', summary: '会话超时判断错误', file: 'SessionManager.java', line_range: [142, 168] },
      solutions: [
        { id: 'option-a', summary: '调整判断优先级', recommended: true, risk: 'low', effort: 'small' },
        { id: 'option-b', summary: '增加前置检查', recommended: false, risk: 'medium', effort: 'medium' },
      ],
      affected_modules: ['pas-bastion-host'],
      analysis_steps: ['Phase 1: 读代码', 'Phase 2: 对比', 'Phase 3: 验证'],
    }

    const md = buildMarkdownReport(output)
    expect(md).toContain('## AI 分析报告')
    expect(md).toContain('L2 简单代码')
    expect(md).toContain('65%')
    expect(md).toContain('会话超时判断错误')
    expect(md).toContain('option-a')
    expect(md).toContain('推荐')
    expect(md).toContain('pas-bastion-host')
  })
})
