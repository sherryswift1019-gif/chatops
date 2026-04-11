import type { FastifyInstance } from 'fastify'
import { getAllConfig, getConfig, setConfig } from '../../db/repositories/system-config.js'
import { listProductLines, createProductLine } from '../../db/repositories/product-lines.js'
import { listMembers, addMember } from '../../db/repositories/product-line-members.js'
import { listEnvironments, createEnvironment } from '../../db/repositories/environments-repo.js'
import { listProductLineEnvs, upsertProductLineEnv } from '../../db/repositories/product-line-envs.js'
import { listProjects, createProject } from '../../db/repositories/projects-repo.js'
import { listCapabilities, createCapability } from '../../db/repositories/capabilities.js'
import { getProductLineCapabilities, batchSetProductLineCapabilities } from '../../db/repositories/product-line-capabilities.js'
import { getApprovalRules, insertApprovalRule } from '../../db/repositories/approval-rules.js'
import { listDingTalkUsers, upsertDingTalkUser } from '../../db/repositories/dingtalk-users.js'
import { getPool } from '../../db/client.js'

const SECRET_FIELDS = /secret|password|token|key/i

function maskSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && SECRET_FIELDS.test(k) && v.length > 0) {
      masked[k] = '****' + v.slice(-4)
    } else {
      masked[k] = v
    }
  }
  return masked
}

export async function registerSystemConfigRoutes(app: FastifyInstance): Promise<void> {
  // ── System Config CRUD ─────────────────────────────────────────────────

  app.get('/system-config', async (_req, reply) => {
    const configs = await getAllConfig()
    const result = configs.map(c => ({
      key: c.key, value: maskSecrets(c.value), updatedAt: c.updatedAt,
    }))
    return reply.send(result)
  })

  app.put<{ Params: { key: string }; Body: Record<string, unknown> }>(
    '/system-config/:key',
    async (req, reply) => {
      const { key } = req.params
      const newValue = req.body as Record<string, unknown>
      const existing = await getConfig(key)
      const merged: Record<string, unknown> = existing ? { ...existing.value } : {}
      for (const [k, v] of Object.entries(newValue)) {
        if (v !== '') merged[k] = v
      }
      const entry = await setConfig(key, merged)
      return reply.send({ key: entry.key, value: maskSecrets(entry.value), updatedAt: entry.updatedAt })
    }
  )

  // ── Full Platform Export ────────────────────────────────────────────────

  app.get('/export', async (_req, reply) => {
    const data = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      systemConfig: (await getAllConfig()).map(c => ({ key: c.key, value: c.value })),
      environments: await listEnvironments(),
      productLines: await Promise.all((await listProductLines()).map(async pl => ({
        ...pl,
        members: await listMembers(pl.id),
        envs: await listProductLineEnvs(pl.id),
        capabilities: await getProductLineCapabilities(pl.id),
        approvalRules: await getApprovalRules(pl.id),
      }))),
      projects: await listProjects(),
      capabilities: await listCapabilities(),
      dingtalkUsers: (await listDingTalkUsers()).map(u => ({
        userId: u.userId, name: u.name, avatar: u.avatar, department: u.department,
      })),
    }
    return reply
      .header('Content-Disposition', 'attachment; filename="chatops-export.json"')
      .header('Content-Type', 'application/json')
      .send(data)
  })

  // ── Full Platform Import ────────────────────────────────────────────────

  app.post('/import', async (req, reply) => {
    const data = req.body as Record<string, unknown>
    if (!data || typeof data !== 'object') return reply.status(400).send({ error: 'invalid JSON' })

    const stats = { systemConfig: 0, environments: 0, productLines: 0, projects: 0, capabilities: 0, dingtalkUsers: 0, members: 0, approvalRules: 0 }

    try {
      // 1. System config
      const configs = (data.systemConfig ?? []) as Array<{ key: string; value: Record<string, unknown> }>
      for (const c of configs) {
        if (c.key && c.value) { await setConfig(c.key, c.value); stats.systemConfig++ }
      }

      // 2. Environments
      const envs = (data.environments ?? []) as Array<{ name: string; displayName: string; sortOrder?: number }>
      for (const e of envs) {
        try { await createEnvironment({ name: e.name, displayName: e.displayName, sortOrder: e.sortOrder }); stats.environments++ }
        catch { /* duplicate, skip */ }
      }

      // 3. Capabilities
      const caps = (data.capabilities ?? []) as Array<{ key: string; displayName: string; description?: string; category?: string; toolNames?: string[]; needsApproval?: boolean }>
      for (const c of caps) {
        try {
          await createCapability({
            key: c.key, displayName: c.displayName, description: c.description ?? '',
            category: (c.category ?? 'query') as 'query' | 'action' | 'admin',
            toolNames: c.toolNames ?? [], needsApproval: c.needsApproval ?? false,
          })
          stats.capabilities++
        } catch { /* duplicate, skip */ }
      }

      // 4. DingTalk users
      const users = (data.dingtalkUsers ?? []) as Array<{ userId: string; name: string; avatar?: string; department?: string }>
      for (const u of users) {
        await upsertDingTalkUser({ userId: u.userId, name: u.name, avatar: u.avatar, department: u.department })
        stats.dingtalkUsers++
      }

      // 5. Product lines (with nested members, envs, capabilities, rules)
      const productLines = (data.productLines ?? []) as Array<Record<string, unknown>>
      // Need fresh env list for ID mapping
      const freshEnvs = await listEnvironments()
      const envNameToId = new Map(freshEnvs.map(e => [e.name, e.id]))

      for (const pl of productLines) {
        let plId: number
        try {
          const created = await createProductLine({
            name: pl.name as string, displayName: pl.displayName as string, description: (pl.description as string) ?? '',
          })
          plId = created.id
          stats.productLines++
        } catch { continue /* duplicate, skip */ }

        // Members
        const members = (pl.members ?? []) as Array<{ userId: string; userName: string; role: string }>
        for (const m of members) {
          try {
            await addMember({ productLineId: plId, userId: m.userId, userName: m.userName, role: m.role as 'developer' | 'tester' | 'ops' | 'admin' })
            stats.members++
          } catch { /* skip */ }
        }

        // Envs
        const plEnvs = (pl.envs ?? []) as Array<{ envId?: number; runtime: string; namespace?: string; enabled?: boolean; connectionConfig?: Record<string, unknown>; envName?: string }>
        for (const e of plEnvs) {
          // Try to resolve envId by name if not provided
          let envId = e.envId
          if (!envId && e.envName) envId = envNameToId.get(e.envName)
          if (!envId) continue
          try {
            await upsertProductLineEnv({
              productLineId: plId, envId,
              runtime: e.runtime as 'kubernetes' | 'docker',
              namespace: e.namespace, enabled: e.enabled,
              connectionConfig: e.connectionConfig,
            })
          } catch { /* skip */ }
        }

        // Capabilities
        const plCaps = (pl.capabilities ?? []) as Array<{ capabilityKey: string; envName: string; enabled: boolean; allowedRoles: string[] }>
        if (plCaps.length > 0) {
          try { await batchSetProductLineCapabilities(plId, plCaps) } catch { /* skip */ }
        }

        // Approval rules
        const rules = (pl.approvalRules ?? []) as Array<{ action: string; env: string; primaryApprovers: string[]; backupApprovers: string[]; primaryTimeoutMin: number; totalTimeoutMin: number }>
        for (const r of rules) {
          try {
            await insertApprovalRule({
              productLineId: plId, action: r.action, env: r.env,
              primaryApprovers: r.primaryApprovers, backupApprovers: r.backupApprovers,
              primaryTimeoutMin: r.primaryTimeoutMin ?? 10, totalTimeoutMin: r.totalTimeoutMin ?? 20,
            })
            stats.approvalRules++
          } catch { /* skip */ }
        }
      }

      // 6. Projects
      const projects = (data.projects ?? []) as Array<Record<string, unknown>>
      const freshPLs = await listProductLines()
      const plNameToId = new Map(freshPLs.map(p => [p.name, p.id]))

      for (const p of projects) {
        const plId = plNameToId.get(p.productLineName as string) ?? (p.productLineId as number)
        if (!plId) continue
        try {
          await createProject({
            productLineId: plId, name: p.name as string, displayName: p.displayName as string,
            gitlabPath: p.gitlabPath as string, harborProject: p.harborProject as string,
            ownerId: p.ownerId as string, ownerName: p.ownerName as string,
            dockerContainerName: p.dockerContainerName as string, k8sProjectName: p.k8sProjectName as string,
            composePath: p.composePath as string, description: p.description as string,
          })
          stats.projects++
        } catch { /* duplicate, skip */ }
      }

      return reply.send({ success: true, stats })
    } catch (err) {
      return reply.status(500).send({ success: false, error: String(err) })
    }
  })
}
