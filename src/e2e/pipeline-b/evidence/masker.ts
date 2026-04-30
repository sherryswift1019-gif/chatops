// src/e2e/pipeline-b/evidence/masker.ts
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { mask } from '../../../agent/masking/sensitive-info.js'
import type { EvidenceManifest } from './types.js'

export async function maskTextArtifacts(evidenceDir: string, manifest: EvidenceManifest): Promise<void> {
  for (const artifact of manifest.artifacts) {
    if (!artifact.mimeType.startsWith('text/')) continue
    const filePath = join(evidenceDir, artifact.path)
    const content = await readFile(filePath, 'utf8')
    const masked = mask(content)
    await writeFile(filePath, masked, 'utf8')
  }
}
