import type { FastifyInstance } from 'fastify'
import {
  listE2eTargetProjects,
  getE2eTargetProject,
  updateE2eTargetProject,
  extractGitlabPath,
} from '../../db/repositories/e2e-target-projects.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { listProjectBranches } from '../../agent/tools/list-gitlab-branches.js'

export async function registerE2eTargetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/e2e-targets', async (_req, reply) => {
    return reply.send(await listE2eTargetProjects())
  })

  app.get<{ Params: { id: string } }>('/e2e-targets/:id', async (req, reply) => {
    const project = await getE2eTargetProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    return reply.send(project)
  })

  app.get<{ Params: { id: string } }>('/e2e-targets/:id/branches', async (req, reply) => {
    const project = await getE2eTargetProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const path = extractGitlabPath(project.gitlabRepo)
    const branches = await listProjectBranches(path)
    return reply.send({ branches, defaultBranch: project.defaultBranch })
  })

  app.get('/e2e-targets-gitlab-base-url', async (_req, reply) => {
    const cfg = await resolveGitlabConfig()
    return reply.send({ url: cfg.url ?? null })
  })

  app.post<{ Body: { gitlabRepo: string } }>('/e2e-targets/test-repo', async (req, reply) => {
    const { gitlabRepo } = req.body
    if (!gitlabRepo) return reply.status(400).send({ ok: false, message: '仓库地址不能为空' })

    const cfg = await resolveGitlabConfig()
    if (!cfg.url || !cfg.token) {
      return reply.send({ ok: false, message: '系统 GitLab 配置未完成（缺少 URL 或 Token）' })
    }

    const path = extractGitlabPath(gitlabRepo)
    const apiUrl = `${cfg.url.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(path)}`
    try {
      const resp = await fetch(apiUrl, {
        headers: { 'PRIVATE-TOKEN': cfg.token },
        signal: AbortSignal.timeout(8000),
      })
      if (resp.ok) {
        const data = (await resp.json()) as { name_with_namespace?: string }
        return reply.send({ ok: true, message: `连接成功：${data.name_with_namespace ?? path}` })
      }
      if (resp.status === 404) return reply.send({ ok: false, message: `仓库不存在或无权限访问：${path}` })
      return reply.send({ ok: false, message: `GitLab 返回 ${resp.status}` })
    } catch (err) {
      return reply.send({ ok: false, message: `连接失败：${err instanceof Error ? err.message : String(err)}` })
    }
  })

  app.put<{
    Params: { id: string }
    Body: {
      displayName?: string
      gitlabRepo?: string
      defaultBranch?: string
      workingDir?: string
      scripts?: { build: string; deploy: string; test: string; fix?: string }
      defaultSandboxKind?: string
    }
  }>('/e2e-targets/:id', async (req, reply) => {
    const project = await getE2eTargetProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const updated = await updateE2eTargetProject(req.params.id, req.body)
    return reply.send(updated)
  })
}

