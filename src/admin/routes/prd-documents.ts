import type { FastifyInstance } from 'fastify'
import {
  listPrdDocuments,
  getPrdDocumentById,
  updatePrdStatus,
  updatePrdContent,
  deletePrdDocument,
  appendReviewHistory,
  type PrdStatus,
} from '../../db/repositories/prd-documents.js'
import { triggerPrdReviewAsync } from '../../agent/prd/prd-agent.js'
import { getDingTalkUserById } from '../../db/repositories/dingtalk-users.js'
import { notifyDm } from '../../agent/coordinator.js'
import { config } from '../../config.js'

const VALID_STATUSES: PrdStatus[] = [
  'drafting',
  'reviewing',
  'review_blocked',
  'draft',
  'approved',
  'archived',
]

export async function registerPrdDocumentRoutes(app: FastifyInstance): Promise<void> {
  // 列表（支持 product_line_id / status / created_by / limit / offset 过滤）
  app.get('/prd-documents', async (req) => {
    const q = req.query as Record<string, string | undefined>
    const productLineId = q.product_line_id ? Number(q.product_line_id) : undefined
    const status = q.status as PrdStatus | undefined
    const createdBy = q.created_by
    const limit = q.limit ? Number(q.limit) : 50
    const offset = q.offset ? Number(q.offset) : 0

    if (status && !VALID_STATUSES.includes(status)) {
      return {
        error: {
          code: 'INVALID_STATUS',
          message: `status must be one of ${VALID_STATUSES.join(',')}`,
        },
      }
    }

    const rows = await listPrdDocuments({ productLineId, status, createdBy, limit, offset })
    return { data: rows, total: rows.length }
  })

  // 详情
  app.get('/prd-documents/:id', async (req) => {
    const id = Number((req.params as any).id)
    const prd = await getPrdDocumentById(id)
    if (!prd) {
      return { error: { code: 'NOT_FOUND', message: `PRD ${id} not found` } }
    }
    return { data: prd }
  })

  // 状态流转（管理员手动）
  app.put('/prd-documents/:id/status', async (req) => {
    const id = Number((req.params as any).id)
    const body = req.body as { status?: PrdStatus }
    if (!body.status || !VALID_STATUSES.includes(body.status)) {
      return {
        error: {
          code: 'INVALID_STATUS',
          message: `status must be one of ${VALID_STATUSES.join(',')}`,
        },
      }
    }
    const updated = await updatePrdStatus(id, body.status)
    if (!updated) {
      return { error: { code: 'NOT_FOUND', message: `PRD ${id} not found` } }
    }
    return { data: updated }
  })

  // 人工处理自审阻塞（approve / approve_with_edits / reject）
  app.post('/prd-documents/:id/review-decision', async (req) => {
    const id = Number((req.params as any).id)
    const body = req.body as {
      action?: 'approve' | 'approve_with_edits' | 'reject'
      editedMarkdown?: string
      comment?: string
      decidedBy?: string
    }

    if (!body.action || !['approve', 'approve_with_edits', 'reject'].includes(body.action)) {
      return {
        error: {
          code: 'INVALID_ACTION',
          message: 'action must be approve / approve_with_edits / reject',
        },
      }
    }

    const prd = await getPrdDocumentById(id)
    if (!prd) {
      return { error: { code: 'NOT_FOUND', message: `PRD ${id} not found` } }
    }
    if (prd.status !== 'review_blocked') {
      return {
        error: {
          code: 'INVALID_STATE',
          message: `PRD ${id} is in ${prd.status}, review decision only applies to review_blocked`,
        },
      }
    }

    if (body.action === 'approve') {
      const updated = await updatePrdStatus(id, 'draft')
      await appendReviewHistory(id, {
        round: (prd.reviewHistory.at(-1)?.round ?? 0) + 1,
        result: {
          status: 'passed',
          round: (prd.reviewHistory.at(-1)?.round ?? 0) + 1,
          findings: [],
          recommendation: {
            action: 'approve',
            reason: `人工放行: ${body.comment ?? '（无备注）'}（by ${body.decidedBy ?? 'admin'}）`,
          },
          reviewedAt: new Date().toISOString(),
        },
      })
      return { data: updated }
    }

    if (body.action === 'approve_with_edits') {
      if (!body.editedMarkdown || body.editedMarkdown.trim().length < 200) {
        return {
          error: {
            code: 'MISSING_EDITED_MARKDOWN',
            message: 'approve_with_edits requires editedMarkdown (至少 200 字符)',
          },
        }
      }
      const updated = await updatePrdContent(id, { contentMarkdown: body.editedMarkdown })
      if (!updated) {
        return { error: { code: 'UPDATE_FAILED', message: 'Failed to update PRD' } }
      }
      // 人工编辑后重新进入自审
      const after = await updatePrdStatus(id, 'reviewing')
      triggerPrdReviewAsync(id)
      await appendReviewHistory(id, {
        round: (prd.reviewHistory.at(-1)?.round ?? 0) + 1,
        result: {
          status: 'passed',
          round: (prd.reviewHistory.at(-1)?.round ?? 0) + 1,
          findings: [],
          recommendation: {
            action: 'approve_with_edits',
            reason: `人工编辑后放行: ${body.comment ?? '（无备注）'}（by ${body.decidedBy ?? 'admin'}）`,
          },
          reviewedAt: new Date().toISOString(),
        },
      })
      return { data: after }
    }

    // reject → 打回 drafting，等 PM 重新对话
    const updated = await updatePrdStatus(id, 'drafting')
    const rejectReason = `人工驳回: ${body.comment ?? '（无备注）'}（by ${body.decidedBy ?? 'admin'}）`
    await appendReviewHistory(id, {
      round: (prd.reviewHistory.at(-1)?.round ?? 0) + 1,
      result: {
        status: 'blocked',
        round: (prd.reviewHistory.at(-1)?.round ?? 0) + 1,
        findings: [],
        recommendation: {
          action: 'reject',
          reason: rejectReason,
        },
        reviewedAt: new Date().toISOString(),
      },
    })

    // Best-effort IM 通知：PRD 的 createdBy 若匹配 dingtalk_users（说明是 IM 路径创建），
    // 发钉钉私聊；web 后台创建的用户无钉钉映射则跳过。任何失败只 log，不影响返回。
    void notifyPmOnReject(prd.id, prd.title, prd.createdBy, rejectReason).catch((err) => {
      req.log.warn({ err, prdId: id }, '[review-decision] notifyPmOnReject failed')
    })

    return { data: updated }
  })

  // 手动重跑自审
  app.post('/prd-documents/:id/rerun-review', async (req) => {
    const id = Number((req.params as any).id)
    const prd = await getPrdDocumentById(id)
    if (!prd) {
      return { error: { code: 'NOT_FOUND', message: `PRD ${id} not found` } }
    }
    triggerPrdReviewAsync(id)
    return { data: { prdId: id, status: 'review_triggered' } }
  })

  // 删除
  app.delete('/prd-documents/:id', async (req) => {
    const id = Number((req.params as any).id)
    const ok = await deletePrdDocument(id)
    if (!ok) {
      return { error: { code: 'NOT_FOUND', message: `PRD ${id} not found` } }
    }
    return { data: { id, deleted: true } }
  })
}

async function notifyPmOnReject(
  prdId: number,
  prdTitle: string,
  createdBy: string,
  reason: string
): Promise<void> {
  // createdBy 必须是钉钉 staffId（IM 路径创建的 PRD）。web 后台 admin 用户不在表里 → 跳过。
  const dtUser = await getDingTalkUserById(createdBy)
  if (!dtUser) {
    console.log(`[prd-documents] skip DM: ${createdBy} not in dingtalk_users (prd=${prdId})`)
    return
  }

  const lines = [
    `📝 你的 PRD「${prdTitle}」被驳回了`,
    '',
    `原因：${reason}`,
  ]
  if (config.WEB_BASE_URL) {
    lines.push('', `查看详情：${config.WEB_BASE_URL}/prd-documents/${prdId}`)
  }
  await notifyDm(dtUser.userId, lines.join('\n'))
}
