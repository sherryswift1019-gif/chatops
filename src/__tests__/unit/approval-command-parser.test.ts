import { describe, it, expect } from 'vitest'
import { parseApprovalCommand } from '../../pipeline/approval-command-parser.js'

describe('parseApprovalCommand', () => {
  it('解析 approve #42', () => {
    expect(parseApprovalCommand('approve #42')).toEqual({ kind: 'approve', issueIid: 42 })
  })

  it('解析 reject #42（无 reason）', () => {
    expect(parseApprovalCommand('reject #42')).toEqual({ kind: 'reject', issueIid: 42 })
  })

  it('解析 reanalyze #42（无 hint）', () => {
    expect(parseApprovalCommand('reanalyze #42')).toEqual({ kind: 'reanalyze', issueIid: 42 })
  })

  it('去掉前导 @中文机器人，正常解析 approve', () => {
    expect(parseApprovalCommand('@助手 approve #42')).toEqual({ kind: 'approve', issueIid: 42 })
  })

  it('解析 reject 带 reason', () => {
    expect(parseApprovalCommand('reject #42 逻辑有误')).toEqual({
      kind: 'reject',
      issueIid: 42,
      reason: '逻辑有误',
    })
  })

  it('解析 reanalyze 带 hint', () => {
    expect(parseApprovalCommand('reanalyze #42 考虑缓存场景')).toEqual({
      kind: 'reanalyze',
      issueIid: 42,
      hint: '考虑缓存场景',
    })
  })

  it('支持不带 # 的写法：approve 42', () => {
    expect(parseApprovalCommand('approve 42')).toEqual({ kind: 'approve', issueIid: 42 })
  })

  it('大小写不敏感：APPROVE #42', () => {
    // approval-manager 里原正则是 /i，保持一致
    expect(parseApprovalCommand('APPROVE #42')).toEqual({ kind: 'approve', issueIid: 42 })
  })

  it('多余空格：  approve  #42  ', () => {
    expect(parseApprovalCommand('  approve  #42  ')).toEqual({ kind: 'approve', issueIid: 42 })
  })

  it('非法 issueIid（字母）：approve #abc → null', () => {
    expect(parseApprovalCommand('approve #abc')).toBeNull()
  })

  it('issueIid 为 0 → null（业务上 Issue iid 从 1 起）', () => {
    expect(parseApprovalCommand('approve #0')).toBeNull()
  })

  it('完全不是命令：hello → null', () => {
    expect(parseApprovalCommand('hello')).toBeNull()
  })

  it('空字符串 → null', () => {
    expect(parseApprovalCommand('')).toBeNull()
  })

  it('只有 @机器人 → null', () => {
    expect(parseApprovalCommand('@助手')).toBeNull()
  })

  it('非法动作：foo #42 → null', () => {
    expect(parseApprovalCommand('foo #42')).toBeNull()
  })

  it('approve 后无 issueIid → null', () => {
    expect(parseApprovalCommand('approve')).toBeNull()
  })

  it('非字符串输入 → null', () => {
    // @ts-expect-error 故意传非 string 类型，验证 runtime 防御
    expect(parseApprovalCommand(null)).toBeNull()
    // @ts-expect-error 同上
    expect(parseApprovalCommand(undefined)).toBeNull()
    // @ts-expect-error 同上
    expect(parseApprovalCommand(42)).toBeNull()
  })

  it('带 @机器人 + reason：@助手 reject #42 原因', () => {
    expect(parseApprovalCommand('@助手 reject #42 原因')).toEqual({
      kind: 'reject',
      issueIid: 42,
      reason: '原因',
    })
  })
})
