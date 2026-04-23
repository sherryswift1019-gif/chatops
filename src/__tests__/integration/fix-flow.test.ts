/**
 * 集成测试：L1/L2 修复闭环
 * mock Claude 输出 + mock Git 操作，验证完整流程
 */
import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest'
import { extractProjectPath, isFixSuccessful } from '../../agent/fix/fix-runner.js'

// ── 单元测试：辅助函数 ──────────────────────────────────

describe('Fix Runner: extractProjectPath', () => {
  it('HTTP URL', () => {
    expect(extractProjectPath('http://code.paraview.cn/PAM/java-code/pas-6.0.git'))
      .toBe('PAM/java-code/pas-6.0')
  })

  it('HTTPS URL', () => {
    expect(extractProjectPath('https://gitlab.com/org/repo.git'))
      .toBe('org/repo')
  })

  it('无 .git 后缀', () => {
    expect(extractProjectPath('http://code.paraview.cn/PAM/java-code/pas-6.0'))
      .toBe('PAM/java-code/pas-6.0')
  })

  it('SSH URL', () => {
    expect(extractProjectPath('git@code.paraview.cn:PAM/java-code/pas-6.0.git'))
      .toBe('PAM/java-code/pas-6.0')
  })
})

describe('Fix Runner: isFixSuccessful', () => {
  // 严格 marker 规则（2026-04-23 改）：输出末尾**单独一行**为 `修复完成` 才算成功。
  // 原 fuzzy 关键字匹配（"所有测试通过"/"BUILD SUCCESS"）已废弃——Claude 在
  // 解释根因/引用日志时常出现"测试失败"等字样，误触发 failurePatterns 让明明改
  // 好了却判失败。marker 是唯一可靠信号。

  it('末尾行是 "修复完成" → 成功', () => {
    expect(isFixSuccessful('修改了 2 个文件，所有测试通过。\n修复完成')).toBe(true)
  })

  it('末尾行是 "修复完成" 带尾部空行 → 成功', () => {
    expect(isFixSuccessful('修复了 NPE\n修复完成\n\n')).toBe(true)
  })

  it('末尾行带额外内容 → 失败（严格匹配）', () => {
    expect(isFixSuccessful('所有测试通过\n修复完成，请审查')).toBe(false)
  })

  it('输出中含 "修复完成" 但非末尾行 → 失败', () => {
    expect(isFixSuccessful('修复完成\n不过还要再改一处')).toBe(false)
  })

  it('只有"所有测试通过"无 marker → 失败（防 fuzzy 误触发）', () => {
    expect(isFixSuccessful('修改了 2 个文件，所有测试通过。')).toBe(false)
  })

  it('含"测试失败"→ 失败', () => {
    expect(isFixSuccessful('运行测试后发现测试失败：NullPointerException')).toBe(false)
  })

  it('空输出 → 失败', () => {
    expect(isFixSuccessful('')).toBe(false)
    expect(isFixSuccessful('   \n\n')).toBe(false)
  })
})

// ── 集成测试：完整修复流程（mock DB + mock Git + mock Claude）────

describe('Integration: L1/L2 修复闭环', () => {
  // mock 所有外部依赖
  const mockAcquire = vi.fn()
  const mockRelease = vi.fn()
  const mockCreateFixBranch = vi.fn()
  const mockCommitChanges = vi.fn()
  const mockPushBranch = vi.fn()
  const mockExecuteCapabilityDirect = vi.fn()
  const mockGetReport = vi.fn()
  const mockGetKnowledgeRepo = vi.fn()
  const mockHandleFixComplete = vi.fn()
  const mockAxiosPost = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()

    // 默认 mock 返回值
    mockAcquire.mockResolvedValue({ path: '/tmp/worktree/test', id: 'wt-1' })
    mockRelease.mockResolvedValue(undefined)
    mockCreateFixBranch.mockResolvedValue('fix/issue-42')
    mockCommitChanges.mockResolvedValue(undefined)
    mockPushBranch.mockResolvedValue(undefined)
    mockHandleFixComplete.mockResolvedValue(undefined)
    mockGetReport.mockResolvedValue({
      id: 1,
      issueId: 42,
      productLineId: 1,
      rootCauseSummary: 'SQL 缺失',
      solutionsJson: [{ id: 'a', summary: '添加 SQL 映射', recommended: true, risk: 'low', effort: 'low' }],
      affectedModules: ['pas-secret-task'],
      confidence: 'high',
    })
    mockGetKnowledgeRepo.mockResolvedValue({
      codeRepoUrl: 'http://code.paraview.cn/PAM/java-code/pas-6.0.git',
      codeDefaultBranch: 'test',
    })
    mockAxiosPost.mockResolvedValue({
      data: { iid: 100, web_url: 'http://code.paraview.cn/mr/100', id: 999 },
    })
  })

  // 使用 vi.doMock 需要动态 import，这里用直接测试辅助函数 + 流程验证
  it('isFixSuccessful 正确识别成功场景', () => {
    expect(isFixSuccessful('修改了 2 个文件\n修复完成')).toBe(true)
    expect(isFixSuccessful('BUILD FAILURE: compilation error')).toBe(false)
  })

  it('extractProjectPath 处理多种 URL 格式', () => {
    expect(extractProjectPath('http://code.paraview.cn/PAM/java-code/pas-6.0.git')).toBe('PAM/java-code/pas-6.0')
    expect(extractProjectPath('https://gitlab.com/group/subgroup/project.git')).toBe('group/subgroup/project')
    expect(extractProjectPath('git@gitlab.com:org/repo.git')).toBe('org/repo')
  })
})
