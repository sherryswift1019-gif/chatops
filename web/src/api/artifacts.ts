import client from './client'

export interface ArtifactFile {
  name: string
  path: string
  size: number
  mtime: number
  downloadUrl: string
}

export const listArtifacts = (
  listUrl: string,
  glob?: string,
  authHeaders?: Record<string, string>,
) =>
  client
    .post<{ files: ArtifactFile[] }>('/artifacts/list', { listUrl, glob, authHeaders })
    .then(r => r.data.files)
