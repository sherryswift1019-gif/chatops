import type { ResolvedProject } from './resolver.js'

export interface ProjectRow {
  name: string
  displayName: string
  resolved: ResolvedProject
  container: { name?: string; state?: string; startedAt?: string; health?: string; exitCode?: number }
  servers: string[]
  error?: string
}

export interface FormatInput {
  env: string
  productLine: string
  defaultBranch: string
  projects: ProjectRow[]
}

const ICONS: Record<ResolvedProject['status'], string> = {
  healthy: '✅',
  stale: '🟡',
  degraded: '⚠️',
  down: '❌',
  not_deployed: '⚪',
  unknown: '❓',
}

function humanizeDuration(startedAtISO?: string): string {
  if (!startedAtISO) return '-'
  const started = Date.parse(startedAtISO)
  if (isNaN(started)) return '-'
  const sec = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h${min % 60 > 0 ? `${min % 60}m` : ''}`
  const d = Math.floor(hr / 24)
  return `${d}d${hr % 24 > 0 ? `${hr % 24}h` : ''}`
}

function renderVersionCol(p: ProjectRow): string {
  const { deployed, latest, status } = p.resolved
  if (status === 'not_deployed' || (!deployed && !latest)) return '-'
  if (!deployed) return `(未知) → ${latest?.shortId ?? ''}`
  if (status === 'healthy') return deployed.imageTag
  return `${deployed.imageTag} → ${deployed.branch}_${latest?.shortId ?? '?'}`
}

function renderStatusCol(p: ProjectRow): string {
  const { status, commitsBehind, commitsBehindNote } = p.resolved
  const icon = ICONS[status]

  if (p.error) return `${icon} ${p.error}`

  switch (status) {
    case 'healthy': return `${icon} 最新`
    case 'stale': {
      if (commitsBehindNote === 'too_large') return `${icon} 落后（跨度过大）`
      if (commitsBehind === null) return `${icon} 落后（对比失败）`
      const note = commitsBehind >= 30 ? '（跨度较大）' : ''
      return `${icon} 落后 ${commitsBehind} 个 commit${note}`
    }
    case 'degraded': return `${icon} 运行但不健康`
    case 'down': {
      const code = p.container.exitCode !== undefined ? `(${p.container.exitCode})` : ''
      return `${icon} 容器异常${code}`
    }
    case 'not_deployed': return `${icon} 未部署`
    case 'unknown': return `${icon} 版本未知`
  }
}

function renderContainerCol(p: ProjectRow): string {
  const { state, startedAt } = p.container
  if (!state || state === undefined) return '-'
  if (state === 'running') return `running ${humanizeDuration(startedAt)}`
  return state
}

export function formatEnvStatusOutput(input: FormatInput): string {
  const lines: string[] = [
    `环境: ${input.env} (产线: ${input.productLine}, 默认分支: ${input.defaultBranch || '未配置'})`,
  ]
  const allServers = new Set<string>()
  input.projects.forEach(p => p.servers.forEach(s => allServers.add(s)))
  if (allServers.size > 0) {
    lines.push(`服务器: ${[...allServers].join(', ')}`)
  }
  lines.push('')

  for (const p of input.projects) {
    lines.push(`- ${p.displayName.padEnd(16)} | ${renderContainerCol(p).padEnd(14)} | ${renderVersionCol(p).padEnd(40)} | ${renderStatusCol(p)}`)
  }

  return lines.join('\n')
}
