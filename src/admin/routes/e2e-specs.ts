import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { listE2eSpecs, getE2eSpec, upsertE2eSpec, updateE2eSpecStatus } from '../../db/repositories/e2e-specs.js'
import { getE2eTargetProject, extractGitlabPath } from '../../db/repositories/e2e-target-projects.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { runPipelineA } from '../../e2e/pipeline-a/runner.js'

const VALID_STATUSES = ['pending', 'generating', 'pr_open', 'committed', 'baseline_failed', 'blocked_on_baseline_bug', 'skipped'] as const
type ValidStatus = typeof VALID_STATUSES[number]

export async function registerE2eSpecRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { projectId?: string } }>('/e2e-specs', async (req, reply) => {
    const { projectId } = req.query
    if (!projectId) return reply.status(400).send({ error: 'projectId required' })
    return reply.send(await listE2eSpecs(projectId))
  })

  app.post<{ Body: { targetProjectId: string; specPath: string; title: string; contentHash?: string } }>(
    '/e2e-specs',
    async (req, reply) => {
      const { targetProjectId, specPath, title, contentHash } = req.body
      if (!targetProjectId || !specPath || !title) {
        return reply.status(400).send({ error: 'targetProjectId, specPath, title required' })
      }
      const spec = await upsertE2eSpec({ targetProjectId, specPath, title, contentHash: contentHash ?? 'manual' })
      return reply.status(201).send(spec)
    },
  )

  app.post<{ Body: { targetProjectId: string } }>('/e2e-specs/sync', async (req, reply) => {
    const { targetProjectId } = req.body
    if (!targetProjectId) return reply.status(400).send({ error: 'targetProjectId required' })

    const project = await getE2eTargetProject(targetProjectId)
    if (!project) return reply.status(404).send({ error: 'project not found' })

    const cfg = await resolveGitlabConfig()
    if (!cfg.url || !cfg.token) {
      return reply.status(422).send({ error: 'GitLab 配置未完成（缺少 URL 或 Token）' })
    }

    const repoPath = extractGitlabPath(project.gitlabRepo)
    const base = cfg.url.replace(/\/$/, '')
    const encodedPath = encodeURIComponent(repoPath)
    const treeUrl = `${base}/api/v4/projects/${encodedPath}/repository/tree?path=docs/test-specs&recursive=false&ref=${project.defaultBranch}&per_page=100`

    const treeResp = await fetch(treeUrl, {
      headers: { 'PRIVATE-TOKEN': cfg.token },
      signal: AbortSignal.timeout(10_000),
    })

    if (!treeResp.ok) {
      if (treeResp.status === 404) {
        return reply.send({ synced: 0, specs: await listE2eSpecs(targetProjectId) })
      }
      return reply.status(502).send({ error: `GitLab API 返回 ${treeResp.status}` })
    }

    const tree = (await treeResp.json()) as Array<{ name: string; path: string; type: string }>
    const mdFiles = tree.filter((f) => f.type === 'blob' && f.name.endsWith('.md'))

    let synced = 0
    for (const file of mdFiles) {
      const rawUrl = `${base}/api/v4/projects/${encodedPath}/repository/files/${encodeURIComponent(file.path)}/raw?ref=${project.defaultBranch}`
      const rawResp = await fetch(rawUrl, {
        headers: { 'PRIVATE-TOKEN': cfg.token },
        signal: AbortSignal.timeout(8_000),
      })
      if (!rawResp.ok) continue

      const content = await rawResp.text()

      const frontmatterTitle = content.match(/^---\n[\s\S]*?^title:\s*(.+)$/m)?.[1]?.trim()
      const h1Title = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
      const title = frontmatterTitle ?? h1Title ?? file.name.replace(/\.md$/, '')
      const contentHash = createHash('sha256').update(content).digest('hex')

      await upsertE2eSpec({ targetProjectId, specPath: file.path, title, contentHash })
      synced++
    }

    return reply.send({ synced, specs: await listE2eSpecs(targetProjectId) })
  })

  app.post<{ Params: { id: string } }>('/e2e-specs/:id/generate', async (req, reply) => {
    const spec = await getE2eSpec(BigInt(req.params.id))
    if (!spec) return reply.status(404).send({ error: 'spec not found' })
    if (spec.generationStatus === 'generating') {
      return reply.status(409).send({ error: 'already generating' })
    }

    void runPipelineA({ targetProjectId: spec.targetProjectId, specPaths: [spec.specPath] }).catch((err) => {
      console.error('[e2e-specs:generate] Pipeline A error:', err)
      updateE2eSpecStatus(spec.id, 'baseline_failed').catch(() => {})
    })

    return reply.status(202).send({ message: 'generation started', specId: spec.id.toString() })
  })

  app.put<{ Params: { id: string }; Body: { generationStatus?: string; skip?: boolean } }>(
    '/e2e-specs/:id',
    async (req, reply) => {
      const spec = await getE2eSpec(BigInt(req.params.id))
      if (!spec) return reply.status(404).send({ error: 'not found' })

      if (req.body.skip) {
        await updateE2eSpecStatus(spec.id, 'skipped')
      } else if (req.body.generationStatus) {
        if (!VALID_STATUSES.includes(req.body.generationStatus as ValidStatus)) {
          return reply.status(400).send({ error: `invalid generationStatus: ${req.body.generationStatus}` })
        }
        await updateE2eSpecStatus(spec.id, req.body.generationStatus as ValidStatus)
      }
      return reply.send(await getE2eSpec(spec.id))
    },
  )
}
