import { describe, it, expect } from 'vitest'
import { parseGitlabTreeUrl, assertSameProject } from '../../agent/prd-submit/url-parser.js'

describe('parseGitlabTreeUrl', () => {
  it('基本路径', () => {
    expect(parseGitlabTreeUrl('http://code.paraview.cn/PAM/devops/chatops/-/tree/prd-smoke')).toEqual({
      projectPath: 'PAM/devops/chatops',
      branch: 'prd-smoke',
    })
  })

  it('含斜杠的分支名（feat/docreview）', () => {
    expect(
      parseGitlabTreeUrl('http://code.paraview.cn/PAM/devops/chatops/-/tree/feat/docreview'),
    ).toEqual({
      projectPath: 'PAM/devops/chatops',
      branch: 'feat/docreview',
    })
  })

  it('带 query 参数（?ref_type=heads）', () => {
    expect(
      parseGitlabTreeUrl('https://gitlab.com/g/r/-/tree/main?ref_type=heads'),
    ).toEqual({ projectPath: 'g/r', branch: 'main' })
  })

  it('带 hash 锚点', () => {
    expect(parseGitlabTreeUrl('https://gitlab.com/g/r/-/tree/main#readme')).toEqual({
      projectPath: 'g/r',
      branch: 'main',
    })
  })

  it('子组嵌套', () => {
    expect(
      parseGitlabTreeUrl('http://h/PAM/group1/group2/repo/-/tree/main'),
    ).toEqual({ projectPath: 'PAM/group1/group2/repo', branch: 'main' })
  })

  it('https scheme', () => {
    expect(parseGitlabTreeUrl('https://gitlab.com/a/b/-/tree/x')).toEqual({
      projectPath: 'a/b',
      branch: 'x',
    })
  })

  it('分支名中含点号和连字符', () => {
    expect(parseGitlabTreeUrl('http://h/g/r/-/tree/release-1.2.3')).toEqual({
      projectPath: 'g/r',
      branch: 'release-1.2.3',
    })
  })

  it('尾部多余斜杠（PM 手贴）', () => {
    expect(parseGitlabTreeUrl('http://h/g/r/-/tree/main/')).toEqual({
      projectPath: 'g/r',
      branch: 'main',
    })
  })

  it('前后空白被 trim', () => {
    expect(parseGitlabTreeUrl('  http://h/g/r/-/tree/main  ')).toEqual({
      projectPath: 'g/r',
      branch: 'main',
    })
  })

  it('非 tree URL（blob）抛错', () => {
    expect(() => parseGitlabTreeUrl('http://h/g/r/-/blob/main/README.md')).toThrow(
      /无法解析/,
    )
  })

  it('不含 /-/ 分段抛错', () => {
    expect(() => parseGitlabTreeUrl('http://h/g/r/tree/main')).toThrow(/无法解析/)
  })

  it('空字符串抛错', () => {
    expect(() => parseGitlabTreeUrl('')).toThrow()
  })

  it('仅主机名抛错', () => {
    expect(() => parseGitlabTreeUrl('http://host.com')).toThrow(/无法解析/)
  })
})

describe('assertSameProject', () => {
  it('两 URL 同 repo → 返回合并结构', () => {
    expect(
      assertSameProject(
        'http://h/PAM/x/-/tree/prd-smoke',
        'http://h/PAM/x/-/tree/feat/docreview',
      ),
    ).toEqual({
      projectPath: 'PAM/x',
      sourceBranch: 'prd-smoke',
      targetBranch: 'feat/docreview',
    })
  })

  it('两 URL 不同 repo → 抛错', () => {
    expect(() =>
      assertSameProject('http://h/PAM/a/-/tree/x', 'http://h/PAM/b/-/tree/y'),
    ).toThrow(/必须是同一个仓库/)
  })

  it('工作地址 URL 本身错误 → 抛解析错', () => {
    expect(() =>
      assertSameProject('not-a-url', 'http://h/g/r/-/tree/main'),
    ).toThrow(/无法解析/)
  })
})
