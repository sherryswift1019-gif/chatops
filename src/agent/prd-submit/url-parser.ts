/**
 * 解析 GitLab 浏览器地址栏里的分支浏览 URL → { projectPath, branch }。
 *
 * 支持格式（PM 直接从浏览器复制的那个 URL）：
 *   http://host/PAM/devops/chatops/-/tree/prd-smoke
 *   http://host/PAM/devops/chatops/-/tree/feat/docreview
 *   https://host/group/repo/-/tree/branch?ref_type=heads
 *
 * 约定：
 *   - URL 的 `/-/tree/` 之后整段（去掉 query/anchor）视为**完整的分支名**，
 *     含 `/` 的分支名（如 `feat/docreview`）原样保留
 *   - 若 PM 粘贴的是"分支 + 子目录"混合 URL（如 `/-/tree/branch/docs`），
 *     本解析器**无法区分**分支边界——GitLab API 需要分支名决定 compare ref
 *   - PRD §3.1 已约定"只粘贴分支根 URL"；若 PM 误粘子路径 URL，下游
 *     GitLab compare 会把整串当 ref 去匹配，匹配不到分支时报错，进入 failed 路径
 */

export interface ParsedGitlabTreeUrl {
  projectPath: string // 例: 'PAM/devops/chatops'
  branch: string // 例: 'prd-smoke' / 'feat/docreview'
}

const TREE_URL_RE = /^https?:\/\/[^/]+\/(.+?)\/-\/tree\/([^?#]+)(?:[?#].*)?$/

export function parseGitlabTreeUrl(url: string): ParsedGitlabTreeUrl {
  const trimmed = url.trim()
  const match = trimmed.match(TREE_URL_RE)
  if (!match) {
    throw new Error(`无法解析 GitLab tree URL（要求形如 http://host/group/repo/-/tree/branch）: ${url}`)
  }
  const projectPath = match[1].replace(/\/$/, '') // 去掉尾部斜杠（理论上不会有）
  const branch = match[2].replace(/\/$/, '') // 去掉尾部斜杠（如 /-/tree/branch/ 多余那个）
  if (!projectPath) throw new Error(`projectPath 为空: ${url}`)
  if (!branch) throw new Error(`branch 为空: ${url}`)
  return { projectPath, branch }
}

/**
 * 校验两个 URL 解析出来的 projectPath 一致（PRD 硬约束：不支持跨 repo MR）。
 * 返回一致的 projectPath 或抛错。
 */
export function assertSameProject(workUrl: string, mrUrl: string): {
  projectPath: string
  sourceBranch: string
  targetBranch: string
} {
  const work = parseGitlabTreeUrl(workUrl)
  const mr = parseGitlabTreeUrl(mrUrl)
  if (work.projectPath !== mr.projectPath) {
    throw new Error(
      `工作地址与 MR 地址必须是同一个仓库；实际: 工作地址=${work.projectPath}, MR地址=${mr.projectPath}`,
    )
  }
  return {
    projectPath: work.projectPath,
    sourceBranch: work.branch,
    targetBranch: mr.branch,
  }
}
