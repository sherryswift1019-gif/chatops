import { describe, it, expect } from 'vitest'
import { parseInsufficientEvidence } from '../../agent/analysis/claude-runs.js'

describe('parseInsufficientEvidence', () => {
  it('识别 needs_user_decision:true 返回 markdown 和元数据', () => {
    const input = `根据代码分析，可能原因有三个：

1. PS1 ANSI 转义污染
2. SSH 超时
3. 日志格式

\`\`\`json
{
  "recommended_option": 1,
  "needs_user_decision": true,
  "verify_command": "ssh root@host 'echo $PS1'",
  "verify_criteria": "输出包含 ^[[ 即确认"
}
\`\`\``
    const result = parseInsufficientEvidence(input)
    expect(result).not.toBeNull()
    expect(result!.markdown).toContain('根据代码分析')
    expect(result!.markdown).toContain('PS1 ANSI')
    expect(result!.markdown).not.toContain('needs_user_decision')
    expect(result!.markdown).not.toContain('```')
    expect(result!.verifyCommand).toBe("ssh root@host 'echo $PS1'")
    expect(result!.verifyCriteria).toBe('输出包含 ^[[ 即确认')
    expect(result!.recommendedOption).toBe(1)
  })

  it('classification schema 不识别为 insufficient，返回 null', () => {
    const input = `# 分析

一些 markdown 分析

{"classification":"bug","level":"l2","confidence":"high","root_cause":{"type":"logic","summary":"x","file":"a.java","line_range":[1,2]},"solutions":[]}`
    expect(parseInsufficientEvidence(input)).toBeNull()
  })

  it('无 JSON 的纯文本返回 null', () => {
    expect(parseInsufficientEvidence('just some text')).toBeNull()
  })

  it('JSON 有 needs_user_decision:false 不识别', () => {
    const input = `分析完成
{"needs_user_decision": false, "classification": "bug"}`
    expect(parseInsufficientEvidence(input)).toBeNull()
  })

  it('裸 JSON（无代码围栏、无前缀）也能识别', () => {
    const input = `{"recommended_option": 2, "needs_user_decision": true, "verify_command": "ls", "verify_criteria": "非空"}`
    const result = parseInsufficientEvidence(input)
    expect(result).not.toBeNull()
    expect(result!.markdown).toBe('')
    expect(result!.verifyCommand).toBe('ls')
    expect(result!.recommendedOption).toBe(2)
  })

  it('verify_command/criteria 缺失也不崩（只要 needs_user_decision:true）', () => {
    const input = `分析中\n{"needs_user_decision": true}`
    const result = parseInsufficientEvidence(input)
    expect(result).not.toBeNull()
    expect(result!.verifyCommand).toBeUndefined()
    expect(result!.verifyCriteria).toBeUndefined()
    expect(result!.markdown).toBe('分析中')
  })
})
