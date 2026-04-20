import { globMatch } from './glob-match.js'
import type { ArtifactInput } from './types.js'

export interface ArtifactFile {
  name: string
  path: string
  size: number
  mtime: number
  downloadUrl: string
}

interface RemoteFileEntry {
  name: string
  path: string
  type: string
  size: number
  mtime: number
}

interface RemoteListResponse {
  files?: RemoteFileEntry[]
}

function buildDownloadUrl(listUrl: string, path: string): string {
  const base = new URL(listUrl)
  const segments = path.replace(/^\//, '').split('/').map(encodeURIComponent)
  return `${base.origin}/${segments.join('/')}`
}

export async function listArtifacts(
  input: Pick<ArtifactInput, 'listUrl' | 'glob' | 'authHeaders'>,
): Promise<ArtifactFile[]> {
  const url = `${input.listUrl}${input.listUrl.includes('?') ? '&' : '?'}json=true`
  const headers: Record<string, string> = { Accept: 'application/json', ...(input.authHeaders ?? {}) }

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (e) {
    throw new Error(`ARTIFACT_REPO_UNREACHABLE: ${input.listUrl} — ${(e as Error).message}`)
  }
  if (!res.ok) {
    throw new Error(`ARTIFACT_REPO_UNREACHABLE: ${input.listUrl} — HTTP ${res.status}`)
  }
  const body = (await res.json()) as RemoteListResponse
  const files = body.files ?? []

  return files
    .filter(f => f.type === 'file')
    .filter(f => globMatch(f.name, input.glob))
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => ({
      name: f.name, path: f.path, size: f.size, mtime: f.mtime,
      downloadUrl: buildDownloadUrl(input.listUrl, f.path),
    }))
}

function extract(file: ArtifactFile, valueFrom: ArtifactInput['valueFrom']): string {
  switch (valueFrom) {
    case 'name': return file.name
    case 'path': return file.path
    case 'url':
    default:     return file.downloadUrl
  }
}

export async function resolveArtifact(
  input: ArtifactInput,
  providedRuntimeVar: string | undefined,
): Promise<string> {
  if (providedRuntimeVar !== undefined && providedRuntimeVar !== '') return providedRuntimeVar
  if (input.default) return input.default
  if (!input.defaultStrategy) {
    throw new Error(`ARTIFACT_INPUT_UNRESOLVED: ${input.outputVar} (无 runtimeVar / default / defaultStrategy)`)
  }

  const all = await listArtifacts(input)
  if (all.length === 0) {
    throw new Error(`ARTIFACT_NO_MATCH: ${input.outputVar} glob=${input.glob}`)
  }

  if (input.defaultStrategy === 'first-match') {
    const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name))
    return extract(sorted[0], input.valueFrom)
  }
  return extract(all[0], input.valueFrom)
}
