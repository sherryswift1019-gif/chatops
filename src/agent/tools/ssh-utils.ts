import { getTestServerById } from '../../db/repositories/test-servers.js'
import type { ConnectionConfig } from '../../db/repositories/product-line-envs.js'

export interface SSHTarget {
  host: string
  port: number
  username: string
  password: string
}

/**
 * 从 connectionConfig 解析 SSH 连接信息。
 * 优先从 serverIds 查 TestServer，fallback 到旧的直接字段。
 */
export async function resolveSSHConfig(connectionConfig: ConnectionConfig): Promise<SSHTarget | null> {
  const cfg = connectionConfig as Record<string, unknown>

  // 新格式：通过 serverIds 关联服务器注册表
  if (Array.isArray(cfg.serverIds) && cfg.serverIds.length > 0) {
    const server = await getTestServerById(cfg.serverIds[0] as number)
    if (!server) return null
    return { host: server.host, port: server.port, username: server.username, password: server.credential }
  }

  // 旧格式兼容：直接字段
  if (cfg.host && cfg.username && cfg.password) {
    return { host: cfg.host as string, port: (cfg.port as number) ?? 22, username: cfg.username as string, password: cfg.password as string }
  }

  return null
}

/** 兼容旧数据：如果是目录路径（不以 .yml/.yaml 结尾），自动补 /docker-compose.yml */
export function resolveComposeFile(composePath: string): string {
  if (composePath.endsWith('.yml') || composePath.endsWith('.yaml')) {
    return composePath
  }
  return `${composePath.replace(/\/+$/, '')}/docker-compose.yml`
}

function normalizeName(s: string | null | undefined): string {
  if (!s) return ''
  return s.toLowerCase().replace(/[-_\s]+/g, '')
}

export function findProjectByName<T extends { name: string; displayName: string; harborProject?: string | null }>(
  projects: T[],
  input: string,
): T | undefined {
  const exact = projects.find(p =>
    p.name === input || p.displayName === input || p.harborProject === input
  )
  if (exact) return exact
  const key = normalizeName(input)
  if (!key) return undefined
  return projects.find(p =>
    normalizeName(p.name) === key ||
    normalizeName(p.displayName) === key ||
    normalizeName(p.harborProject) === key
  )
}

export function findEnvByName<T extends { name: string; displayName: string }>(
  envs: T[],
  input: string,
): T | undefined {
  const exact = envs.find(e => e.name === input || e.displayName === input)
  if (exact) return exact
  const key = normalizeName(input)
  if (!key) return undefined
  return envs.find(e => normalizeName(e.name) === key || normalizeName(e.displayName) === key)
}
