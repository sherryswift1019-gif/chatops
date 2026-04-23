/**
 * Unit test: gitlab-label.ts
 *
 * 真实代码路径未覆盖（其他单测总是把它 mock 掉）。
 * 本测试用 vi.mock('axios') 模拟 HTTP 调用，验证：
 *   - URL / header / body 拼装正确
 *   - GITLAB_URL 或 GITLAB_TOKEN 未配置时抛错
 *   - axios 报错时抛错（由调用方 try/catch）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 注意：vi.mock 会被 hoist 到 import 之上，这里 mock axios default export
vi.mock('axios', () => ({
  default: {
    put: vi.fn(),
  },
}))

import axios from 'axios'
import { gitlabAddIssueLabel } from '../../agent/handover/gitlab-label.js'

describe('gitlabAddIssueLabel', () => {
  const originalUrl = process.env.GITLAB_URL
  const originalToken = process.env.GITLAB_TOKEN

  beforeEach(() => {
    vi.mocked(axios.put).mockReset()
    process.env.GITLAB_URL = 'https://gitlab.example.com'
    process.env.GITLAB_TOKEN = 'test-token-xyz'
  })

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.GITLAB_URL
    else process.env.GITLAB_URL = originalUrl
    if (originalToken === undefined) delete process.env.GITLAB_TOKEN
    else process.env.GITLAB_TOKEN = originalToken
  })

  it('成功路径：URL + header + body 拼装正确', async () => {
    vi.mocked(axios.put).mockResolvedValue({ data: { iid: 42 } } as any)

    await gitlabAddIssueLabel('PAM/pas-api', 42, 'needs-handover')

    expect(axios.put).toHaveBeenCalledTimes(1)
    const [url, body, cfg] = vi.mocked(axios.put).mock.calls[0]
    expect(url).toBe(
      'https://gitlab.example.com/api/v4/projects/PAM%2Fpas-api/issues/42',
    )
    expect(body).toEqual({ add_labels: 'needs-handover' })
    expect((cfg as any).headers['PRIVATE-TOKEN']).toBe('test-token-xyz')
    expect((cfg as any).timeout).toBe(15_000)
  })

  it('projectPath 正确 URL-encode（斜杠变成 %2F）', async () => {
    vi.mocked(axios.put).mockResolvedValue({ data: {} } as any)

    await gitlabAddIssueLabel('group/sub/project-x', 1, 'label-a')

    const [url] = vi.mocked(axios.put).mock.calls[0]
    // encodeURIComponent 会把 `/` 变成 %2F
    expect(url).toContain('projects/group%2Fsub%2Fproject-x/issues/1')
  })

  it('GITLAB_URL 未配置时抛错', async () => {
    delete process.env.GITLAB_URL
    await expect(
      gitlabAddIssueLabel('PAM/pas-api', 1, 'label'),
    ).rejects.toThrow(/缺少 GitLab url 或 token/)
    expect(axios.put).not.toHaveBeenCalled()
  })

  it('GITLAB_TOKEN 未配置时抛错', async () => {
    delete process.env.GITLAB_TOKEN
    await expect(
      gitlabAddIssueLabel('PAM/pas-api', 1, 'label'),
    ).rejects.toThrow(/缺少 GitLab url 或 token/)
    expect(axios.put).not.toHaveBeenCalled()
  })

  it('axios 报错时抛错（由调用方 try/catch）', async () => {
    vi.mocked(axios.put).mockRejectedValue(new Error('503 gateway'))

    await expect(
      gitlabAddIssueLabel('PAM/x', 7, 'lab'),
    ).rejects.toThrow(/503 gateway/)
  })
})
