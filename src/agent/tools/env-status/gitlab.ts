import axios from 'axios'
import https from 'https'
import { getConfig } from '../../../db/repositories/system-config.js'

export interface LatestCommit {
  commitId: string
  shortId: string
  message: string
}

export interface CompareResult {
  commitsBehind: number | null
  tooLarge: boolean
  latestSummaries: Array<{ shortId: string; message: string }>
}

async function gitlabConfig(): Promise<{ url: string; token: string; agent?: https.Agent } | null> {
  const cfg = await getConfig('gitlab')
  if (!cfg) return null
  const v = cfg.value as Record<string, string>
  if (!v.url || !v.token) return null
  const skip = v.skipTlsVerify === 'true' || v.skipTlsVerify === (true as unknown as string)
  return {
    url: v.url,
    token: v.token,
    agent: skip ? new https.Agent({ rejectUnauthorized: false }) : undefined,
  }
}

export async function getLatestBranchCommit(
  gitlabPath: string,
  branch: string,
): Promise<LatestCommit | null> {
  const gl = await gitlabConfig()
  if (!gl) return null

  const encodedProject = encodeURIComponent(gitlabPath)
  const encodedBranch = encodeURIComponent(branch)
  try {
    const res = await axios.get<{ commit: { id: string; short_id: string; message: string } }>(
      `${gl.url}/api/v4/projects/${encodedProject}/repository/branches/${encodedBranch}`,
      { headers: { 'PRIVATE-TOKEN': gl.token }, httpsAgent: gl.agent, timeout: 10000 }
    )
    return {
      commitId: res.data.commit.id,
      shortId: res.data.commit.short_id.slice(0, 8),
      message: res.data.commit.message,
    }
  } catch {
    return null
  }
}

export async function compareCommits(
  gitlabPath: string,
  fromShort: string,
  toShort: string,
): Promise<CompareResult | null> {
  const gl = await gitlabConfig()
  if (!gl) return null

  const encodedProject = encodeURIComponent(gitlabPath)
  try {
    const res = await axios.get<{
      commits: Array<{ id: string; short_id: string; message: string }>
      compare_timeout?: boolean
    }>(
      `${gl.url}/api/v4/projects/${encodedProject}/repository/compare`,
      {
        headers: { 'PRIVATE-TOKEN': gl.token },
        httpsAgent: gl.agent,
        timeout: 10000,
        params: { from: fromShort, to: toShort, straight: true },
      }
    )
    if (res.data.compare_timeout) {
      return { commitsBehind: null, tooLarge: true, latestSummaries: [] }
    }
    const commits = res.data.commits ?? []
    return {
      commitsBehind: commits.length,
      tooLarge: false,
      latestSummaries: commits.slice(0, 3).map(c => ({
        shortId: c.short_id.slice(0, 8),
        message: c.message.split('\n')[0].slice(0, 80),
      })),
    }
  } catch {
    return null
  }
}
