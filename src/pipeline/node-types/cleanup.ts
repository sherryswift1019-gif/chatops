import * as fs from 'node:fs/promises'
import axios from 'axios'
import { registerNodeType } from './registry.js'
import type { NodeExecutionResult, ExecutionContext } from './types.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'

type CleanupTarget =
  | { kind: 'worktree'; path: string }
  | { kind: 'sandbox'; path: string }
  | { kind: 'remote_branch'; project: string; branch: string }
  | { kind: 'bare_repo'; path: string }
  | { kind: 'draft_mr'; project: string; mrIid: number }

type CleanupReport = {
  cleaned: Array<CleanupTarget & { ok: true }>
  failed: Array<CleanupTarget & { ok: false; error: string }>
}

async function cleanRemoteBranch(project: string, branch: string): Promise<void> {
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) {
    throw new Error('GitLab config (url/token) missing')
  }
  try {
    await axios.delete(
      `${url}/api/v4/projects/${encodeURIComponent(project)}/repository/branches/${encodeURIComponent(branch)}`,
      {
        headers: { 'PRIVATE-TOKEN': token },
        timeout: 30_000,
      },
    )
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return
    }
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
      : String(err)
    throw new Error(`GitLab DELETE branch failed: ${msg}`)
  }
}

async function cleanDraftMr(project: string, mrIid: number): Promise<void> {
  if (!mrIid || mrIid <= 0) {
    return
  }
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) {
    throw new Error('GitLab config (url/token) missing')
  }
  try {
    await axios.put(
      `${url}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${mrIid}`,
      { state_event: 'close' },
      {
        headers: { 'PRIVATE-TOKEN': token },
        timeout: 30_000,
      },
    )
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return
    }
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
      : String(err)
    throw new Error(`GitLab close MR failed: ${msg}`)
  }
}

registerNodeType({
  key: 'cleanup',
  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const targets = (params.targets ?? []) as CleanupTarget[]
    if (!Array.isArray(targets)) {
      return { status: 'failed', output: {}, error: 'cleanup: targets must be array' }
    }

    const report: CleanupReport = { cleaned: [], failed: [] }

    for (const t of targets) {
      try {
        switch (t.kind) {
          case 'worktree':
          case 'sandbox':
          case 'bare_repo':
            await fs.rm(t.path, { recursive: true, force: true })
            break
          case 'remote_branch': await cleanRemoteBranch(t.project, t.branch); break
          case 'draft_mr':      await cleanDraftMr(t.project, t.mrIid);       break
          default:
            report.failed.push({ ...(t as CleanupTarget), ok: false, error: 'unknown kind' })
            continue
        }
        report.cleaned.push({ ...t, ok: true })
      } catch (err) {
        report.failed.push({
          ...t,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { status: 'success', output: { report } }
  },
})
