// src/e2e/pipeline-b/evidence/storage.ts
import { mkdir, cp, rm } from 'fs/promises'
import { dirname, join } from 'path'

export const E2E_EVIDENCE_ROOT_DEFAULT = '/var/chatops/e2e-evidence'
export const E2E_EVIDENCE_RETENTION_DAYS = 30

// Resolve evidence root in priority order:
//   1. E2E_EVIDENCE_ROOT env (explicit override)
//   2. TEST_DATA_DIR/e2e-evidence (docker-compose 已挂载且 chatops 可写)
//   3. /var/chatops/e2e-evidence (legacy host default)
export function getEvidenceRoot(): string {
  if (process.env.E2E_EVIDENCE_ROOT) return process.env.E2E_EVIDENCE_ROOT
  if (process.env.TEST_DATA_DIR) return join(process.env.TEST_DATA_DIR, 'e2e-evidence')
  return E2E_EVIDENCE_ROOT_DEFAULT
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

  // 用 cp + rm 替代 rename：tempDir 通常在 /tmp（tmpfs），persistedDir 在 TEST_DATA_DIR
  // (mounted volume)；rename 跨 mount 抛 EXDEV。先确保父目录存在，再递归拷贝，最后清 temp。
  await mkdir(dirname(persistedDir), { recursive: true })
  await cp(tempDir, persistedDir, { recursive: true })
  await rm(tempDir, { recursive: true, force: true })

  return { persistedDir, evidenceDirUri }
}
