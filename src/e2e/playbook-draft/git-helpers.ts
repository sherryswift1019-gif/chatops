// src/e2e/playbook-draft/git-helpers.ts
//
// 底层 git / GitLab API helper，被 pipeline-a/nodes/commit-pr.ts 和
// playbook-draft/commit-to-gitlab.ts 共享。
import { spawnSync } from 'child_process'

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

export function git(args: string[], cwd: string, env: Record<string, string> = {}): GitResult {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 60_000,
    cwd,
    env: { ...process.env, ...env },
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export interface GitlabApiResult<T> {
  ok: boolean
  status: number
  data: T | null
  text: string
}

export async function gitlabApi<T>(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<GitlabApiResult<T>> {
  const headers: Record<string, string> = { 'PRIVATE-TOKEN': token }
  let bodyText: string | undefined
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    bodyText = JSON.stringify(body)
  }
  const resp = await fetch(url, {
    method,
    headers,
    body: bodyText,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await resp.text()
  let data: T | null = null
  try { data = text ? JSON.parse(text) as T : null } catch { /* not JSON */ }
  return { ok: resp.ok, status: resp.status, data, text }
}
