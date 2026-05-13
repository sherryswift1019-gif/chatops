import { describe, it, expect } from 'vitest'
import { parseFiveSectionMarkdown } from '../../pipeline/node-types/llm-brainstorm.js'

describe('parseFiveSectionMarkdown', () => {
  const validMd = `
## 已查证的现状
- 项目无登录页
## 这一轮要决定
- 选择存储方式
## 选项（带我的推荐）
**A. localStorage** ← 推荐
**B. cookie**
## 我替你做的默认（如果你不否决就走）
- 复选框默认不勾选
## 你怎么回？
- A / B / 自由文本
`
  it('valid round 1', () => {
    const r = parseFiveSectionMarkdown(validMd)
    expect(r.valid).toBe(true)
    expect(r.sections.context).toContain('项目无登录页')
    expect(r.sections.options).toContain('localStorage')
  })
  it('missing sections', () => {
    const r = parseFiveSectionMarkdown(`## 已查证的现状\n- x\n## 这一轮要决定\n- y`)
    expect(r.valid).toBe(false)
    expect(r.missingSections).toContain('options')
  })
  it('no options listed → violation', () => {
    const md = `## 已查证的现状\n- x\n## 这一轮要决定\n- y\n## 选项（带我的推荐）\n（空）\n## 我替你做的默认（如果你不否决就走）\n- z\n## 你怎么回？\n- 回答`
    const r = parseFiveSectionMarkdown(md)
    expect(r.violations).toContain('no_options_listed')
  })
  it('round 2 missing history ref → violation', () => {
    const r = parseFiveSectionMarkdown(validMd, { round: 2 })
    expect(r.violations).toContain('round2_missing_history_reference')
  })
  it('round 2 with history ref → valid', () => {
    const md = `
## 已查证的现状
- 上一轮你选了 A
## 这一轮要决定
- 选择默认勾选
## 选项（带我的推荐）
**A. 默认勾选** ← 推荐
**B. 默认不勾选**
## 我替你做的默认（如果你不否决就走）
- 显示 toast 提示
## 你怎么回？
- A / B
`
    const r = parseFiveSectionMarkdown(md, { round: 2 })
    expect(r.valid).toBe(true)
  })
})
