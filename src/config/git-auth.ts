/**
 * GitLab HTTP clone/fetch/push 认证注入。
 *
 * git clone 对 HTTP(S) GitLab 仓库需要凭证，否则会提示：
 *   fatal: could not read Username for 'http://...': No such device or address
 *
 * 做法：把 `http://host/path.git` 改写成 `http://oauth2:<token>@host/path.git`。
 * 这样 `git clone --bare` / `git fetch origin` / `git push origin` 都自动带上认证
 * （因为 clone 后 remote URL 存到 `git config remote.origin.url` 里）。
 *
 * Token 来源走标准的 resolveGitlabConfig()：system_config.gitlab.token 优先，
 * 空则回退 env GITLAB_TOKEN。
 */
import { resolveGitlabConfig } from './gitlab.js'

export async function injectGitlabAuth(url: string): Promise<string> {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url
    if (u.username) return url // 已经有凭证，不覆盖
    const { token } = await resolveGitlabConfig()
    if (!token) return url
    u.username = 'oauth2'
    u.password = token
    return u.toString()
  } catch {
    return url
  }
}
