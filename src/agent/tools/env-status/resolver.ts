import type { DockerProbeResult } from './docker-probe.js'
import type { LatestCommit, CompareResult } from './gitlab.js'
import type { DeployedTag } from './tag-parser.js'

export type ProjectStatus = 'healthy' | 'stale' | 'degraded' | 'down' | 'not_deployed' | 'unknown'

export interface ResolvedProject {
  status: ProjectStatus
  deployed: DeployedTag | null
  latest: LatestCommit | null
  commitsBehind: number | null
  commitsBehindNote?: 'too_large' | 'compare_failed'
  latestCommitSummaries?: Array<{ shortId: string; message: string }>
}

export interface ResolveInput {
  probe: DockerProbeResult
  latest: LatestCommit | null
  compare: CompareResult | null
  hasHistory: boolean
}

export function resolveProjectStatus(input: ResolveInput): ResolvedProject {
  const { probe, latest, compare, hasHistory } = input

  if (probe.error) {
    return {
      status: 'unknown',
      deployed: probe.deployed,
      latest,
      commitsBehind: null,
    }
  }

  // 无容器
  if (!probe.container.exists) {
    return {
      status: hasHistory ? 'down' : 'not_deployed',
      deployed: null,
      latest,
      commitsBehind: null,
    }
  }

  const state = probe.container.state

  // 容器存在但不 running
  if (state !== 'running') {
    return {
      status: 'down',
      deployed: probe.deployed,
      latest,
      commitsBehind: null,
    }
  }

  // running 但 tag 反解失败
  if (!probe.deployed) {
    return {
      status: 'unknown',
      deployed: null,
      latest,
      commitsBehind: null,
    }
  }

  // running 但健康检查不过
  if (probe.container.health === 'unhealthy' || probe.container.health === 'starting') {
    return {
      status: 'degraded',
      deployed: probe.deployed,
      latest,
      commitsBehind: compare?.commitsBehind ?? null,
      commitsBehindNote: compare?.tooLarge ? 'too_large' : undefined,
    }
  }

  // running + healthy（或无 healthcheck）
  if (!latest) {
    // GitLab 查不到 latest，无法对比，视为 healthy 不附 commitsBehind
    return {
      status: 'healthy',
      deployed: probe.deployed,
      latest: null,
      commitsBehind: null,
    }
  }

  if (probe.deployed.shortId === latest.shortId) {
    return {
      status: 'healthy',
      deployed: probe.deployed,
      latest,
      commitsBehind: 0,
    }
  }

  // stale
  return {
    status: 'stale',
    deployed: probe.deployed,
    latest,
    commitsBehind: compare?.commitsBehind ?? null,
    commitsBehindNote: compare?.tooLarge
      ? 'too_large'
      : (compare === null ? 'compare_failed' : undefined),
    latestCommitSummaries: compare?.latestSummaries,
  }
}
