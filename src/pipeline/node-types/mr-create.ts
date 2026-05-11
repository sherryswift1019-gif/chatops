import axios from 'axios'
import { exec } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { injectGitlabAuth } from '../../config/git-auth.js'
import {
  getRequirementById,
  setMrUrl,
  setRequirementStatus,
  setSpecPlanContent,
  type Requirement,
} from '../../db/repositories/requirements.js'

const execAsync = promisify(exec)

// ─── helpers ─────────────────────────────────────────────────────────────────

function escapeShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** "http://host/group/repo(.git)" 或 "group/repo(.git)" → "group/repo" */
function normalizeProjectPath(input: string): string {
  let s = input.trim().replace(/\.git$/i, '')
  const m = s.match(/^https?:\/\/[^/]+\/(.+)$/i)
  if (m) s = m[1]
  return s.replace(/^\/+|\/+$/g, '')
}

async function gitPushBranch(
  worktreePath: string,
  branch: string,
  gitlabUrl: string,
  gitlabProject: string,
): Promise<void> {
  const projectPath = normalizeProjectPath(gitlabProject)
  const rawUrl = `${gitlabUrl.replace(/\/$/, '')}/${projectPath}.git`
  const authedUrl = await injectGitlabAuth(rawUrl)
  await execAsync(
    `git push ${escapeShell(authedUrl)} HEAD:${escapeShell(branch)}`,
    { cwd: worktreePath, timeout: 60_000 },
  )
}

async function detectRebaseHint(
  worktreePath: string,
  baseBranch: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `git rev-list --count HEAD..origin/${baseBranch}`,
      { cwd: worktreePath, timeout: 10_000 },
    )
    const behind = parseInt(stdout.trim(), 10)
    if (behind > 0) {
      return `注意：${baseBranch} 分支在此分支创建后有 ${behind} 个新提交，建议 rebase 后合并。`
    }
    return null
  } catch {
    return null
  }
}

/** 从 steps 里拿 dev_with_review_loop 的输出（可选）。 */
function devLoopOutput(ctx: ExecutionContext): Record<string, unknown> {
  for (const key of Object.keys(ctx.steps ?? {})) {
    if (key.includes('dev_with_review') || key.includes('dev_loop')) {
      return (ctx.steps[key]?.output ?? {}) as Record<string, unknown>
    }
  }
  return {}
}

function buildDescription(
  req: Requirement,
  specContent: string | null,
  ctx: ExecutionContext,
  rebaseHint: string | null,
): string {
  const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'
  const dev = devLoopOutput(ctx)
  const reviewDecision = (dev.review as { decision?: string } | undefined)?.decision ?? 'unknown'
  const tasksDone = (dev.tasksDone as number[] | undefined)?.length ?? 0
  const fixRounds = (dev.fixRounds as number | undefined) ?? 0

  const specExcerpt = (specContent ?? '').slice(0, 300) || '_（暂无 Spec 快照）_'

  let rebaseSection = ''
  if (rebaseHint) {
    rebaseSection = `\n## ⚠️ 提示\n${rebaseHint}\n`
  }

  return (
    `> 由 ChatOps quick-impl 自动生成 · 需求 #${req.id}\n` +
    `> 详情页：${baseUrl}/requirements/${req.id}\n\n` +
    `## 需求\n${req.rawInput}\n\n` +
    `## Spec（摘录）\n${specExcerpt}\n\n` +
    `## Review 摘要\n` +
    `- AI Code Review: ${reviewDecision}（修复 ${fixRounds} 轮）\n` +
    `- 完成任务数: ${tasksDone}\n` +
    `- 自动化测试: stub pass（Phase 1）\n` +
    rebaseSection
  )
}

// ─── idempotent helpers ───────────────────────────────────────────────────────

function parseMrIidFromUrl(mrUrl: string): number | null {
  const m = mrUrl.match(/\/merge_requests\/(\d+)(?:[/?#]|$)/)
  return m ? Number(m[1]) : null
}

async function findOpenMrBySourceBranch(
  gitlabUrl: string,
  gitlabToken: string,
  project: string,
  sourceBranch: string,
): Promise<{ iid: number; web_url: string } | null> {
  const resp = await axios.get<Array<{ iid: number; web_url: string; state: string }>>(
    `${gitlabUrl}/api/v4/projects/${encodeURIComponent(project)}/merge_requests`,
    {
      headers: { 'PRIVATE-TOKEN': gitlabToken },
      params: { source_branch: sourceBranch, state: 'opened' },
      timeout: 30_000,
    },
  )
  const opened = resp.data.find(m => m.state === 'opened')
  return opened ? { iid: opened.iid, web_url: opened.web_url } : null
}

// ─── node executor ────────────────────────────────────────────────────────────

registerNodeType({
  key: 'mr_create',
  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const requirementId = Number(
      params.requirementId ?? ctx.triggerParams?.requirementId,
    )
    if (!requirementId || isNaN(requirementId)) {
      return { status: 'failed', output: {}, error: 'mr_create: requirementId is required' }
    }

    const req = await getRequirementById(requirementId)
    if (!req) {
      return { status: 'failed', output: {}, error: `mr_create: requirement ${requirementId} not found` }
    }
    if (!req.branch) {
      return { status: 'failed', output: {}, error: 'mr_create: requirement has no branch (init_branch may not have run)' }
    }
    if (!req.worktreePath) {
      return { status: 'failed', output: {}, error: 'mr_create: requirement has no worktreePath' }
    }

    const { url: gitlabUrl, token: gitlabToken } = await resolveGitlabConfig()
    if (!gitlabUrl || !gitlabToken) {
      return { status: 'failed', output: {}, error: 'mr_create: missing GitLab config (url/token)' }
    }

    // git push
    try {
      await gitPushBranch(req.worktreePath, req.branch, gitlabUrl, req.gitlabProject)
    } catch (err) {
      return {
        status: 'failed',
        output: {},
        error: `mr_create: git push failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const rebaseHint = await detectRebaseHint(req.worktreePath, req.baseBranch)

    // Spec content: DB first, fallback to file (cleanup worker writes DB 30min later)
    let specContent = req.specContent
    if (!specContent) {
      const specFilePath = join(req.worktreePath, 'docs', 'specs', `qi-${requirementId}.md`)
      if (existsSync(specFilePath)) {
        specContent = readFileSync(specFilePath, 'utf8')
        await setSpecPlanContent(requirementId, specContent, null).catch(() => {})
      }
    }

    // Build title
    const titleTemplate = String(
      params.titleTemplate ?? '[quick-impl] {{requirement.title}}',
    )
    const rawTitle = titleTemplate.replace('{{requirement.title}}', req.title)
    const isDraft = params.draft !== false  // default true
    const title = isDraft && !rawTitle.startsWith('Draft:') ? `Draft: ${rawTitle}` : rawTitle

    // Build description
    const description = buildDescription(req, specContent, ctx, rebaseHint)

    // Labels
    const labels = Array.isArray(params.labels)
      ? (params.labels as string[]).join(',')
      : 'quick-impl,auto-generated'

    // Create or update MR (idempotent)
    let mr: { iid: number; web_url: string }
    let created = false

    const normalizedProject = normalizeProjectPath(req.gitlabProject)
    const existingMrIid = req.mrUrl ? parseMrIidFromUrl(req.mrUrl) : null

    if (existingMrIid !== null) {
      // PUT update existing MR (idempotent path: mrUrl already persisted from a previous run)
      try {
        const resp = await axios.put(
          `${gitlabUrl}/api/v4/projects/${encodeURIComponent(normalizedProject)}/merge_requests/${existingMrIid}`,
          { title, description, labels },
          { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 },
        )
        mr = resp.data as { iid: number; web_url: string }
        created = false
      } catch (err) {
        const msg = axios.isAxiosError(err)
          ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
          : String(err)
        return { status: 'failed', output: {}, error: `mr_create: GitLab API PUT error: ${msg}` }
      }
    } else {
      // POST create (existing behavior)
      try {
        const resp = await axios.post(
          `${gitlabUrl}/api/v4/projects/${encodeURIComponent(normalizedProject)}/merge_requests`,
          {
            title,
            description,
            source_branch: req.branch,
            target_branch: req.baseBranch,
            labels,
            remove_source_branch: params.removeSourceBranchAfterMerge !== false,
            squash: params.squashCommits === true,
          },
          { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 },
        )
        mr = resp.data as { iid: number; web_url: string }
        created = true
      } catch (err) {
        // 防御性：409 撞已有 MR → 查 source_branch 已有 MR → PUT update
        if (axios.isAxiosError(err) && err.response?.status === 409) {
          try {
            const existing = await findOpenMrBySourceBranch(gitlabUrl, gitlabToken, normalizedProject, req.branch)
            if (!existing) {
              return { status: 'failed', output: {}, error: 'mr_create: 409 but no open MR found by source_branch' }
            }
            const putResp = await axios.put(
              `${gitlabUrl}/api/v4/projects/${encodeURIComponent(normalizedProject)}/merge_requests/${existing.iid}`,
              { title, description, labels },
              { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 },
            )
            mr = putResp.data as { iid: number; web_url: string }
            created = false
          } catch (innerErr) {
            const msg = axios.isAxiosError(innerErr)
              ? `${innerErr.response?.status ?? ''} ${JSON.stringify(innerErr.response?.data ?? innerErr.message)}`
              : String(innerErr)
            return { status: 'failed', output: {}, error: `mr_create: 409 fallback PUT failed: ${msg}` }
          }
        } else {
          const msg = axios.isAxiosError(err)
            ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
            : String(err)
          return { status: 'failed', output: {}, error: `mr_create: GitLab API error: ${msg}` }
        }
      }
    }

    // Persist MR URL + advance status
    await setMrUrl(requirementId, mr.web_url)
    await setRequirementStatus(requirementId, 'mr_open')

    return {
      status: 'success',
      output: { mrUrl: mr.web_url, mrIid: mr.iid, rebaseHint, created },
    }
  },
})
