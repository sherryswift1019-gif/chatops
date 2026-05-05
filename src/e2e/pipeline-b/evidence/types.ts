// src/e2e/pipeline-b/evidence/types.ts
//
// @deprecated 这个 EvidenceManifest schema 是旧 pipeline-b（test.sh 脚本路径）写出的格式。
// 新版 playbook-driven 流程的 manifest 在 src/e2e/pipeline-b/playbook/manifest.ts:Manifest
// （含 claudeTrace + acceptanceResults + result 等）。本文件保留是为了 collect-evidence.ts
// 和老 fixture 仍能编译；新代码请直接用 playbook/manifest.ts 的 Manifest。

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
