/**
 * GitLab MR API helper — 给 prd-submit 链路的三个能力：
 *   - resolveMrTitle: 从 commit log 派生 MR 标题（或用 override），失败回退 slug
 *   - findOpenMr: 查同 source/target 是否已有 open MR（幂等复用依据）
 *   - setMrDraft: 通过 PUT title 切换 MR 的 Draft 状态（闸门）
 *
 * 注意：
 *   - 不复用 src/agent/mr/gitlab-mr.ts（那是 bug-fix 链路专用，我们只调用其 gitlabCreateMr）
 *   - 所有 URL 都对 projectPath / ref 做 encodeURIComponent（`/` 会被编码为 `%2F`）
 */
import axios from 'axios'
import { resolveGitlabConfig } from '../../config/gitlab.js'

const FIXUP_PREFIX_RE = /^(fixup!|squash!|wip:|WIP:|wip\(|WIP\()/

export type TitleSource = 'override' | 'commit' | 'fallback'

export interface ResolvedTitle {
  /** 最终用于 MR 的标题（已加 [PRD] 前缀，不含 Draft: 前缀）*/
  title: string
  source: TitleSource
}

async function getGitlab(): Promise<{ url: string; token: string }> {
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) {
    throw new Error('缺少 GitLab url 或 token 配置')
  }
  return { url, token }
}

/**
 * 从 sourceBranch 领先 targetBranch 的 commits 中取一个合适的 title 作 MR 标题。
 * 过滤掉 fixup!/squash!/wip: 类前缀（这类 commit 不应该成为 PRD 标题）。
 * 失败路径：compare 返回空 / API 报错 / 全是 fixup → 回退 `[PRD] ${slug}`。
 */
export async function resolveMrTitle(
  projectPath: string,
  sourceBranch: string,
  targetBranch: string,
  override: string | null,
  slug: string,
): Promise<ResolvedTitle> {
  if (override && override.trim()) {
    return { title: `[PRD] ${override.trim()}`, source: 'override' }
  }

  try {
    const { url, token } = await getGitlab()
    const resp = await axios.get(
      `${url}/api/v4/projects/${encodeURIComponent(projectPath)}/repository/compare`,
      {
        params: { from: targetBranch, to: sourceBranch },
        headers: { 'PRIVATE-TOKEN': token },
        timeout: 30_000,
      },
    )
    const commits = (resp.data?.commits ?? []) as Array<{ title?: string }>
    // GitLab /repository/compare 返回 commits 是 `git log from..to` 的顺序：
    // **最老在前，最新在后**（与之前 PRD 注释里的"倒序"假设相反）。
    // 取最新一次非 fixup 类 commit 的 title 作为 MR 标题——这通常是 PM 刚 push 的
    // 实质修改，也对齐 GitLab UI 开 MR 时的默认标题行为。
    const picked = [...commits].reverse().find(c => c.title && !FIXUP_PREFIX_RE.test(c.title.trim()))
    if (picked?.title) {
      return { title: `[PRD] ${picked.title.trim()}`, source: 'commit' }
    }
  } catch (err) {
    console.warn(
      `[prd-submit/mr-api] compare API 失败，回退 slug: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return { title: `[PRD] ${slug}`, source: 'fallback' }
}

export interface OpenMr {
  iid: number
  webUrl: string
  title: string // 含 Draft: 前缀（若 GitLab 已识别为 Draft）
}

/**
 * 查询同 source/target 的 open MR（同一对分支在 GitLab 里最多 1 个 open MR）。
 * 返回 null 表示没有可复用的 MR。
 */
export async function findOpenMr(
  projectPath: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<OpenMr | null> {
  const { url, token } = await getGitlab()
  const resp = await axios.get(
    `${url}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests`,
    {
      params: {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        state: 'opened',
      },
      headers: { 'PRIVATE-TOKEN': token },
      timeout: 30_000,
    },
  )
  const list = resp.data as Array<{ iid: number; web_url: string; title: string }>
  if (!Array.isArray(list) || list.length === 0) return null
  const mr = list[0]
  return { iid: mr.iid, webUrl: mr.web_url, title: mr.title }
}

/**
 * 切换 MR 的 Draft 状态。通过 PUT title 加 / 去 `Draft: ` 前缀来驱动 GitLab 的
 * Draft 检测（GitLab 会把 "Draft:" / "WIP:" 开头的 MR 自动判为 draft，禁用 Merge 按钮）。
 *
 * @param baseTitle 不含 `Draft:` 前缀的标题（例：`[PRD] xxx`）。
 * @param isDraft   true → 加前缀；false → 去前缀（仅 GitLab 已有前缀时会看到效果）。
 */
export async function setMrDraft(
  projectPath: string,
  mrIid: number,
  baseTitle: string,
  isDraft: boolean,
): Promise<void> {
  const { url, token } = await getGitlab()
  const newTitle = isDraft ? `Draft: ${baseTitle}` : baseTitle
  await axios.put(
    `${url}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}`,
    { title: newTitle },
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 30_000 },
  )
}
