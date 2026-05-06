// src/admin/routes/e2e-playbook-drafts.ts
import type { FastifyInstance } from 'fastify'
import {
  createDraft,
  getDraft,
  listDraftsByProject,
  updateDraftYaml,
  rejectDraft,
} from '../../db/repositories/e2e-playbook-drafts.js'
import { getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { generatePlaybookFromInput } from '../../e2e/playbook-draft/llm-generator.js'
import { getPool } from '../../db/client.js'

// 内存 listener 注册表：draftId (string) → Set<(text: string | null, err?: string) => void>
type ChunkListener = (text: string | null, err?: string) => void
const draftListeners = new Map<string, Set<ChunkListener>>()

function broadcastChunk(draftId: bigint, text: string): void {
  const key = draftId.toString()
  const listeners = draftListeners.get(key)
  if (!listeners) return
  for (const l of listeners) l(text)
}

function broadcastDone(draftId: bigint): void {
  const key = draftId.toString()
  const listeners = draftListeners.get(key)
  if (!listeners) return
  for (const l of listeners) l(null) // null = done
  draftListeners.delete(key)
}

function broadcastError(draftId: bigint, message: string): void {
  const key = draftId.toString()
  const listeners = draftListeners.get(key)
  if (!listeners) return
  for (const l of listeners) l(null, message)
  draftListeners.delete(key)
}

function serializeDraft(draft: Awaited<ReturnType<typeof getDraft>>) {
  if (!draft) return null
  return {
    ...draft,
    id: draft.id.toString(),
    e2eRunId: draft.e2eRunId?.toString() ?? null,
  }
}

async function startLlmGeneration(draftId: bigint, scenarioInput: string, projectId: string): Promise<void> {
  try {
    const project = await getE2eTargetProject(projectId)
    const defaultBranch = project?.defaultBranch ?? 'main'

    const yaml = await generatePlaybookFromInput({
      scenarioInput,
      projectId,
      projectDefaultBranch: defaultBranch,
      onChunk: (chunk) => broadcastChunk(draftId, chunk),
    })

    await updateDraftYaml(draftId, yaml, 'reviewing')
    broadcastDone(draftId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[e2e-playbook-drafts] LLM generation failed draftId=${draftId}:`, err)
    await updateDraftYaml(draftId, '', 'generation_failed', message).catch(() => {})
    broadcastError(draftId, message)
  }
}

export async function registerE2ePlaybookDraftRoutes(app: FastifyInstance): Promise<void> {
  // POST /admin/e2e-playbook-drafts — 创建 draft + fire-and-forget LLM
  app.post<{ Body: { targetProjectId?: string; scenarioInput?: string } }>(
    '/e2e-playbook-drafts',
    async (req, reply) => {
      const { targetProjectId, scenarioInput } = req.body ?? {}
      if (!targetProjectId || !scenarioInput?.trim()) {
        return reply.status(400).send({ error: 'targetProjectId and scenarioInput required' })
      }

      const project = await getE2eTargetProject(targetProjectId)
      if (!project) {
        return reply.status(404).send({ error: 'target project not found' })
      }

      const draftId = await createDraft({ targetProjectId, scenarioInput: scenarioInput.trim() })

      void startLlmGeneration(draftId, scenarioInput.trim(), targetProjectId)

      return reply.status(202).send({ draftId: draftId.toString() })
    },
  )

  // GET /admin/e2e-playbook-drafts — 按 projectId 列表
  app.get<{ Querystring: { projectId?: string; limit?: string } }>(
    '/e2e-playbook-drafts',
    async (req, reply) => {
      const { projectId, limit } = req.query
      if (!projectId) {
        return reply.status(400).send({ error: 'projectId required' })
      }
      const drafts = await listDraftsByProject(projectId, limit ? parseInt(limit, 10) : undefined)
      return reply.send({ drafts: drafts.map(serializeDraft) })
    },
  )

  // GET /admin/e2e-playbook-drafts/:id — 详情
  app.get<{ Params: { id: string } }>(
    '/e2e-playbook-drafts/:id',
    async (req, reply) => {
      const draft = await getDraft(BigInt(req.params.id))
      if (!draft) return reply.status(404).send({ error: 'draft not found' })
      return reply.send(serializeDraft(draft))
    },
  )

  // GET /admin/e2e-playbook-drafts/:id/stream — SSE 实时推 LLM chunk
  app.get<{ Params: { id: string } }>(
    '/e2e-playbook-drafts/:id/stream',
    async (req, reply) => {
      const draftId = BigInt(req.params.id)
      const draft = await getDraft(draftId)
      if (!draft) return reply.status(404).send({ error: 'draft not found' })

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      let clientClosed = false
      const hb = setInterval(() => {
        if (!clientClosed) reply.raw.write(': ping\n\n')
      }, 15_000)

      req.raw.on('close', () => {
        clientClosed = true
        clearInterval(hb)
      })

      const send = (data: Record<string, unknown>) => {
        if (clientClosed) return
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      }

      // 若 draft 已完成/失败，立即发终态事件
      if (draft.status === 'reviewing' || draft.status === 'approved') {
        send({ type: 'done', yamlContent: draft.yamlContent })
        clearInterval(hb)
        reply.raw.end()
        return
      }
      if (draft.status === 'generation_failed') {
        send({ type: 'error', message: draft.errorMessage ?? 'generation failed' })
        clearInterval(hb)
        reply.raw.end()
        return
      }
      if (draft.status === 'rejected') {
        send({ type: 'error', message: 'draft was rejected' })
        clearInterval(hb)
        reply.raw.end()
        return
      }

      // status === 'drafting' — 注册 listener 等待 LLM 完成
      const key = draftId.toString()
      if (!draftListeners.has(key)) draftListeners.set(key, new Set())

      const listener: ChunkListener = (text, err) => {
        if (clientClosed) return
        if (err !== undefined) {
          send({ type: 'error', message: err })
          clearInterval(hb)
          reply.raw.end()
        } else if (text === null) {
          // done
          send({ type: 'done' })
          clearInterval(hb)
          reply.raw.end()
        } else {
          send({ type: 'chunk', text })
        }
      }

      draftListeners.get(key)!.add(listener)

      req.raw.on('close', () => {
        draftListeners.get(key)?.delete(listener)
      })
    },
  )

  // PUT /admin/e2e-playbook-drafts/:id — 用户编辑 yaml 保存
  app.put<{ Params: { id: string }; Body: { yamlContent?: string } }>(
    '/e2e-playbook-drafts/:id',
    async (req, reply) => {
      const draft = await getDraft(BigInt(req.params.id))
      if (!draft) return reply.status(404).send({ error: 'draft not found' })

      if (draft.status === 'drafting') {
        return reply.status(409).send({ error: 'draft is still generating, cannot edit yet' })
      }

      const { yamlContent } = req.body ?? {}
      if (yamlContent === undefined) {
        return reply.status(400).send({ error: 'yamlContent required' })
      }

      // 直接 UPDATE yaml_content，不切 status
      await getPool().query(
        `UPDATE e2e_playbook_drafts SET yaml_content = $1, updated_at = NOW() WHERE id = $2`,
        [yamlContent, draft.id],
      )

      const updated = await getDraft(draft.id)
      return reply.send({ draft: serializeDraft(updated) })
    },
  )

  // POST /admin/e2e-playbook-drafts/:id/regenerate — 重新生成
  app.post<{ Params: { id: string } }>(
    '/e2e-playbook-drafts/:id/regenerate',
    async (req, reply) => {
      const draft = await getDraft(BigInt(req.params.id))
      if (!draft) return reply.status(404).send({ error: 'draft not found' })

      if (draft.status === 'approved') {
        return reply.status(409).send({ error: 'approved draft cannot be regenerated' })
      }

      // 重置 status → drafting，清 yaml 和 error
      await getPool().query(
        `UPDATE e2e_playbook_drafts
         SET status = 'drafting', yaml_content = NULL, error_message = NULL, updated_at = NOW()
         WHERE id = $1`,
        [draft.id],
      )

      void startLlmGeneration(draft.id, draft.scenarioInput, draft.targetProjectId)

      return reply.status(202).send({ draftId: draft.id.toString() })
    },
  )

  // POST /admin/e2e-playbook-drafts/:id/reject — 拒绝
  app.post<{ Params: { id: string } }>(
    '/e2e-playbook-drafts/:id/reject',
    async (req, reply) => {
      const draft = await getDraft(BigInt(req.params.id))
      if (!draft) return reply.status(404).send({ error: 'draft not found' })

      await rejectDraft(draft.id)
      return reply.send({ ok: true })
    },
  )
}
