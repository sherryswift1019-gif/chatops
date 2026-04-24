/**
 * prd_create_mr — pipeline stage 1。
 *
 * 核心职责：
 *   1. 派生 MR 标题（override 优先；否则 commit log；最后回退 slug）
 *   2. 查 source/target 是否已有 open MR → 复用 / 新建
 *   3. **关键闸门**：本 stage 结束时 MR 一定是 Draft 状态
 *      - 新建：`Draft: {baseTitle}` 前缀创建，GitLab 自动 Draft
 *      - 复用：强制 PUT title 回 `Draft: {baseTitle}`，即使上次已 un-draft
 *
 * 跨 stage 数据：从 triggerParams 读 source/target/mrFilePath/title/authorEmail；
 * 事件 data 写 { mrIid, mrUrl, reused, baseTitle, wasForceDrafted, titleSource }，
 * 供 stage 2 review-handler 解除 Draft 时用（读 baseTitle）。
 */
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import { createEvent } from '../../db/repositories/prd-submit-events.js'
import { gitlabCreateMr } from '../mr/gitlab-mr.js'
import { resolveMrTitle, findOpenMr, setMrDraft } from './mr-api.js'

interface Params {
  submissionId: string
  projectPath: string
  sourceBranch: string
  targetBranch: string
  mrFilePath: string
  title: string | null // null → 从 commit log 派生
  authorEmail: string
}

function readParams(opts: TriggerOptions): Params | { error: string } {
  const p = opts.extraParams ?? {}
  const required: (keyof Params)[] = [
    'submissionId', 'projectPath', 'sourceBranch', 'targetBranch',
    'mrFilePath', 'authorEmail',
  ]
  for (const k of required) {
    if (!p[k] || typeof p[k] !== 'string') {
      return { error: `缺少 capabilityParams.${k}` }
    }
  }
  return {
    submissionId: p.submissionId as string,
    projectPath: p.projectPath as string,
    sourceBranch: p.sourceBranch as string,
    targetBranch: p.targetBranch as string,
    mrFilePath: p.mrFilePath as string,
    title: (p.title as string | null | undefined) ?? null,
    authorEmail: p.authorEmail as string,
  }
}

export async function handlePrdCreateMr(opts: TriggerOptions): Promise<TriggerResult> {
  const parsed = readParams(opts)
  if ('error' in parsed) {
    return { success: false, error: parsed.error }
  }
  const { submissionId, projectPath, sourceBranch, targetBranch, mrFilePath, title, authorEmail } = parsed

  const slug = mrFilePath.replace(/^docs\/prds\//, '').replace(/\.md$/, '')

  try {
    // 1. 派生标题
    const resolved = await resolveMrTitle(projectPath, sourceBranch, targetBranch, title, slug)
    const baseTitle = resolved.title

    // 2. 查已有 open MR
    const existing = await findOpenMr(projectPath, sourceBranch, targetBranch)

    let mrIid: number
    let mrUrl: string
    let reused: boolean
    let wasForceDrafted: boolean

    if (existing) {
      // 复用 + 强制 Draft（关键闸门：上次可能已 un-draft 过）
      mrIid = existing.iid
      mrUrl = existing.webUrl
      reused = true
      await setMrDraft(projectPath, mrIid, baseTitle, true)
      wasForceDrafted = true
      console.log(`[prd_create_mr] 复用 existing MR !${mrIid} 并强制重置 Draft`)
    } else {
      // 新建（自带 Draft 前缀）
      const mr = await gitlabCreateMr({
        projectPath,
        sourceBranch,
        targetBranch,
        title: `Draft: ${baseTitle}`,
        description: [
          `提交者: ${authorEmail}`,
          `文件: ${mrFilePath}`,
          `submissionId: ${submissionId}`,
        ].join('\n'),
        labels: 'prd-active-review',
      })
      mrIid = mr.iid
      mrUrl = mr.url
      reused = false
      wasForceDrafted = false
      console.log(`[prd_create_mr] 新建 MR !${mrIid} (Draft: ${baseTitle})`)
    }

    await createEvent({
      submissionId,
      projectPath,
      code: 'prd_create_mr',
      status: 'success',
      data: {
        mrIid,
        mrUrl,
        reused,
        baseTitle,
        wasForceDrafted,
        titleSource: resolved.source,
      },
    })

    return {
      success: true,
      output: `MR ${reused ? '已复用' : '已创建'} !${mrIid}: ${mrUrl}${reused ? '（重置为 Draft）' : ''}`,
      data: { mrIid, mrUrl, reused },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[prd_create_mr] 失败:`, msg)
    await createEvent({
      submissionId,
      projectPath,
      code: 'prd_create_mr',
      status: 'failed',
      data: { error: msg, sourceBranch, targetBranch },
    })
    return { success: false, error: msg }
  }
}

export function registerPrdCreateMrHandler(): void {
  registerCapabilityHandler('prd_create_mr', handlePrdCreateMr)
  console.log('[prd_create_mr] handler registered')
}
