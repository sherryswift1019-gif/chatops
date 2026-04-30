// src/e2e/pipeline-b/evidence/types.ts

export interface EvidenceArtifact {
  kind: 'stderr' | 'stdout' | 'log' | 'screenshot' | 'har' | string
  module: string | null
  mimeType: string
  path: string
  description: string
}

export interface AiDiagnosis {
  rootCause: string
  fixHint: string
  confidence: 'high' | 'medium' | 'low'
}

export interface EvidenceManifest {
  summary: string
  contextHint: string
  artifacts: EvidenceArtifact[]
  aiDiagnosis?: AiDiagnosis
}
