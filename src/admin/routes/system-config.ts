import type { FastifyInstance } from 'fastify'
import axios from 'axios'
import https from 'https'
import { getAllConfig, getConfig, setConfig } from '../../db/repositories/system-config.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
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
import type { IMAdapter } from '../../adapters/im/types.js'
import { DingTalkAdapter } from '../../adapters/im/dingtalk.js'

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

export function describeAxiosError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.response) {
      const status = err.response.status
      const data = err.response.data
      const msg = typeof data === 'object' && data !== null
        ? (data as { message?: string; error?: string; errors?: unknown }).message
          ?? (data as { error?: string }).error
          ?? JSON.stringify(data).slice(0, 200)
        : String(data).slice(0, 200)
      return `HTTP ${status}: ${msg}`
    }
    if (err.code === 'ECONNREFUSED') return '无法连接到服务器（ECONNREFUSED）'
    if (err.code === 'ENOTFOUND') return 'DNS 解析失败（ENOTFOUND），请检查 URL'
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') return '请求超时，请检查网络或 URL'
    if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
      return '证书验证失败（自签名证书），可勾选"跳过证书验证"重试'
    }
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export async function registerSystemConfigRoutes(
  app: FastifyInstance,
  opts: { adapters: IMAdapter[] } = { adapters: [] }
): Promise<void> {
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

  // ── DingTalk connection status ─────────────────────────────────────────

  app.get('/system-config/dingtalk/status', async (_req, reply) => {
    const dingCfg = await getConfig('dingtalk')
    const v = (dingCfg?.value ?? {}) as Record<string, string>
    if (!v.clientId || !v.clientSecret) {
      return reply.send({
        configured: false, started: false, startedAt: null, lastEventAt: null,
        startError: null, connected: false, needsRestart: false,
      })
    }
    const dingAdapter = opts.adapters.find(a => a.platform === 'dingtalk')
    if (!dingAdapter || !(dingAdapter instanceof DingTalkAdapter)) {
      return reply.send({
        configured: true, started: false, startedAt: null, lastEventAt: null,
        startError: '钉钉已配置，但 adapter 未启动（重启服务以生效）',
        connected: false, needsRestart: true,
      })
    }
    const status = dingAdapter.getConnectionStatus()
    const needsRestart = !dingAdapter.credentialsMatch(v.clientId, v.clientSecret)
    return reply.send({ ...status, needsRestart })
  })

  // ── GitLab test connection ─────────────────────────────────────────────

  app.post('/system-config/gitlab/test', async (_req, reply) => {
    const { url, token, skipTlsVerify } = await resolveGitlabConfig()
    if (!url || !token) {
      return reply.send({ ok: false, error: 'GitLab URL 或 Token 未配置，请先保存后再测试' })
    }
    const httpsAgent = skipTlsVerify ? new https.Agent({ rejectUnauthorized: false }) : undefined
    try {
      const res = await axios.get<{ id: number; username: string; name: string; email?: string }>(
        `${url.replace(/\/$/, '')}/api/v4/user`,
        { headers: { 'PRIVATE-TOKEN': token }, httpsAgent, timeout: 10000 }
      )
      return reply.send({
        ok: true,
        user: { username: res.data.username, name: res.data.name, email: res.data.email ?? null },
      })
    } catch (err) {
      return reply.send({ ok: false, error: describeAxiosError(err) })
    }
  })

  // ── Harbor test connection ─────────────────────────────────────────────

  app.post('/system-config/harbor/test', async (_req, reply) => {
    const cfg = await getConfig('harbor')
    const v = (cfg?.value ?? {}) as Record<string, string>
    const url = v.url ?? ''
    const username = v.registryUser ?? v.username ?? ''
    const password = v.registryPassword ?? v.password ?? ''
    if (!url || !username || !password) {
      return reply.send({ ok: false, error: 'Harbor URL / 用户名 / 密码未配置，请先保存后再测试' })
    }
    const skip = v.skipTlsVerify === 'true' || v.skipTlsVerify === (true as unknown as string)
    const httpsAgent = new https.Agent({
      rejectUnauthorized: !skip,
      ...(v.caCert ? { ca: v.caCert } : {}),
    })
    const auth = Buffer.from(`${username}:${password}`).toString('base64')
    try {
      const res = await axios.get<{ username: string; realname?: string; email?: string }>(
        `${url.replace(/\/$/, '')}/api/v2.0/users/current`,
        { headers: { Authorization: `Basic ${auth}` }, httpsAgent, timeout: 10000 }
      )
      return reply.send({
        ok: true,
        user: {
          username: res.data.username,
          name: res.data.realname ?? res.data.username,
          email: res.data.email ?? null,
        },
      })
    } catch (err) {
      return reply.send({ ok: false, error: describeAxiosError(err) })
    }
  })

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
        const rules = (pl.approvalRules ?? []) as Array<{ imTriggerKey: string; env: string; primaryApprovers: string[]; backupApprovers: string[]; primaryTimeoutMin: number; totalTimeoutMin: number }>
        for (const r of rules) {
          try {
            await insertApprovalRule({
              productLineId: plId, imTriggerKey: r.imTriggerKey, env: r.env,
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
