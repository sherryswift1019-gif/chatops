import { getConfig } from '../db/repositories/system-config.js'

export interface GitlabConfig {
  url: string
  token: string
  skipTlsVerify: boolean
}

/**
 * 解析 GitLab 配置（DB 优先，env fallback）
 *
 * 读取顺序：
 * 1. system_config.gitlab 中的 { url, token, skipTlsVerify }
 * 2. 若 url 或 token 任一为空，回退读 process.env.GITLAB_URL / GITLAB_TOKEN / GITLAB_SKIP_TLS_VERIFY
 * 3. 全部为空则返回 { url: '', token: '', skipTlsVerify: false }（调用方自行判断并报错）
 *
 * skipTlsVerify 取值规则：DB 里存的是 string 或 boolean；env 里是 "true" 或 "1" 才算 true。
 */
export async function resolveGitlabConfig(): Promise<GitlabConfig> {
  const cfg = await getConfig('gitlab')
  const v = (cfg?.value ?? {}) as Record<string, unknown>

  const dbUrl = typeof v.url === 'string' ? v.url : ''
  const dbToken = typeof v.token === 'string' ? v.token : ''

  if (dbUrl && dbToken) {
    return {
      url: dbUrl,
      token: dbToken,
      skipTlsVerify: v.skipTlsVerify === 'true' || v.skipTlsVerify === true,
    }
  }

  // env fallback
  const envUrl = process.env.GITLAB_URL ?? ''
  const envToken = process.env.GITLAB_TOKEN ?? ''
  const envSkip = process.env.GITLAB_SKIP_TLS_VERIFY
  return {
    url: envUrl,
    token: envToken,
    skipTlsVerify: envSkip === 'true' || envSkip === '1',
  }
}
