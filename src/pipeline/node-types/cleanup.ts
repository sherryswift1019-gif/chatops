import * as fs from 'node:fs/promises'
import { registerNodeType } from './registry.js'
import type { NodeExecutionResult, ExecutionContext } from './types.js'

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

async function cleanRemoteBranch(_project: string, _branch: string): Promise<void> {
  throw new Error('remote_branch cleanup pending Sub-plan C (GitLab branch delete API)')
}

async function cleanDraftMr(_project: string, _mrIid: number): Promise<void> {
  throw new Error('draft_mr cleanup pending Sub-plan C (GitLab MR close API)')
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
