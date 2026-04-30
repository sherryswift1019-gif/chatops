// src/e2e/pipeline-b/nodes/collect-evidence.ts
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { maskTextArtifacts } from '../evidence/masker.js'
import { persistEvidenceDir } from '../evidence/storage.js'
import { finishScenarioRun } from '../../../db/repositories/e2e-scenario-runs.js'
import type { EvidenceManifest } from '../evidence/types.js'

export interface CollectEvidenceInput {
  context: {
    scenarioRunId: bigint
    evidenceDirTemp: string
    runId: bigint
    scenarioId: string
    attemptNumber: number
  }
}

export interface CollectEvidenceOutput {
  evidencePersisted: boolean
  evidenceManifest: EvidenceManifest
}

export async function collectEvidenceNode(state: CollectEvidenceInput): Promise<CollectEvidenceOutput> {
  const { scenarioRunId, evidenceDirTemp, runId, scenarioId, attemptNumber } = state.context

  const scenarioTempDir = join(evidenceDirTemp, scenarioId)
  const manifestPath = join(scenarioTempDir, 'manifest.json')
  const raw = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as EvidenceManifest

  await maskTextArtifacts(scenarioTempDir, manifest)

  const { persistedDir, evidenceDirUri } = await persistEvidenceDir({
    tempDir: scenarioTempDir,
    runId,
    scenarioId,
    attemptNumber,
  })

  const maskedManifestPath = join(persistedDir, 'manifest.json')
  await writeFile(maskedManifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  await finishScenarioRun(scenarioRunId, 'fail', {
    evidenceManifest: manifest as unknown as Record<string, unknown>,
    evidenceDirUri,
  })

  console.log(`[collectEvidence] run=${runId} scenario=${scenarioId} attempt=${attemptNumber} persisted → ${persistedDir}`)

  return { evidencePersisted: true, evidenceManifest: manifest }
}
