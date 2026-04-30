// src/e2e/pipeline-b/evidence/storage.ts
import { mkdir, rename } from 'fs/promises'
import { join } from 'path'

export const E2E_EVIDENCE_ROOT_DEFAULT = '/var/chatops/e2e-evidence'
export const E2E_EVIDENCE_RETENTION_DAYS = 30

function getEvidenceRoot(): string {
  return process.env.E2E_EVIDENCE_ROOT ?? E2E_EVIDENCE_ROOT_DEFAULT
}

export interface PersistEvidenceDirOptions {
  tempDir: string
  runId: bigint
  scenarioId: string
  attemptNumber: number
}

export interface PersistEvidenceDirResult {
  persistedDir: string
  evidenceDirUri: string
}

export async function persistEvidenceDir(opts: PersistEvidenceDirOptions): Promise<PersistEvidenceDirResult> {
  const { tempDir, runId, scenarioId, attemptNumber } = opts
  const root = getEvidenceRoot()
  const persistedDir = join(root, String(runId), scenarioId, String(attemptNumber))
  const evidenceDirUri = `/admin/e2e-runs/${runId}/evidence/${scenarioId}/${attemptNumber}`

  await mkdir(persistedDir, { recursive: true })
  await rename(tempDir, persistedDir)

  return { persistedDir, evidenceDirUri }
}
