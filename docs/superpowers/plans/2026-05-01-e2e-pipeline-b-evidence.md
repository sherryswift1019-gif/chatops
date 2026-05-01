# E2E Pipeline B — Evidence 收集节点 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 collect_evidence 节点：收集测试失败证据、对 text/* 内容脱敏、持久化到本地 fs、内联 manifest 到 DB，并提供 Fastify 静态文件服务供前端查看。

**Architecture:** evidence 相关逻辑按 masker/storage/node 三层分离；节点读 manifest.json → mask text/* 内容 → mv 到持久目录 → 落 DB；Fastify 路由直接 sendFile 服务目录内容。

**Tech Stack:** TypeScript, Node.js fs/promises, Fastify 5, Vitest

**前置条件:** Pipeline A 基础设施计划全部完成（DB repositories、masking 工具）

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 新建 | `src/e2e/pipeline-b/evidence/types.ts` |
| 新建 | `src/e2e/pipeline-b/evidence/masker.ts` |
| 新建 | `src/e2e/pipeline-b/evidence/storage.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/collect-evidence.ts` |
| 新建 | `src/admin/routes/e2e-evidence.ts` |
| 修改 | `src/admin/index.ts` (注册新路由) |
| 新建 | `src/__tests__/unit/evidence-masker.test.ts` |
| 新建 | `src/__tests__/unit/evidence-storage.test.ts` |

---

### Task 1: EvidenceManifest / EvidenceArtifact 类型

**Files:**
- 新建: `src/e2e/pipeline-b/evidence/types.ts`

- [ ] **Step 1: 写类型定义**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/e2e/pipeline-b/evidence/types.ts
git commit -m "feat(e2e): Pipeline B evidence 类型定义"
```

---

### Task 2: evidence masker（单测先行）

**Files:**
- 新建: `src/e2e/pipeline-b/evidence/masker.ts`
- 新建: `src/__tests__/unit/evidence-masker.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/evidence-masker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../agent/masking/sensitive-info.js', () => ({
  mask: vi.fn((text: string) => text.replace(/secret/gi, '[MASKED]')),
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

import { readFile, writeFile } from 'fs/promises'
import { mask } from '../../agent/masking/sensitive-info.js'
import { maskTextArtifacts } from '../../e2e/pipeline-b/evidence/masker.js'
import type { EvidenceManifest } from '../../e2e/pipeline-b/evidence/types.js'

const BASE_DIR = '/tmp/evidence/scenario-1'

const manifest: EvidenceManifest = {
  summary: 'login failed',
  contextHint: 'auth flow',
  artifacts: [
    { kind: 'stderr', module: null, mimeType: 'text/plain', path: 'artifacts/stderr-1.txt', description: 'stderr output' },
    { kind: 'log', module: 'auth-svc', mimeType: 'text/plain', path: 'artifacts/auth-svc.log', description: 'auth service log' },
    { kind: 'screenshot', module: null, mimeType: 'image/png', path: 'artifacts/fail-moment.png', description: 'failure screenshot' },
  ],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(mask).mockImplementation((text: string) => text.replace(/secret/gi, '[MASKED]'))
  vi.mocked(readFile).mockResolvedValue('log line with secret token\n' as any)
  vi.mocked(writeFile).mockResolvedValue(undefined)
})

describe('maskTextArtifacts', () => {
  it('text/* artifact 被读取、mask 后写回', async () => {
    await maskTextArtifacts(BASE_DIR, manifest)

    expect(readFile).toHaveBeenCalledTimes(2)
    expect(readFile).toHaveBeenCalledWith(`${BASE_DIR}/artifacts/stderr-1.txt`, 'utf8')
    expect(readFile).toHaveBeenCalledWith(`${BASE_DIR}/artifacts/auth-svc.log`, 'utf8')

    expect(mask).toHaveBeenCalledTimes(2)

    expect(writeFile).toHaveBeenCalledTimes(2)
    expect(writeFile).toHaveBeenCalledWith(
      `${BASE_DIR}/artifacts/stderr-1.txt`,
      'log line with [MASKED] token\n',
      'utf8',
    )
  })

  it('image/png artifact 被跳过（不读不写）', async () => {
    await maskTextArtifacts(BASE_DIR, manifest)

    const readCalls = vi.mocked(readFile).mock.calls.map(c => c[0])
    expect(readCalls).not.toContain(`${BASE_DIR}/artifacts/fail-moment.png`)

    const writeCalls = vi.mocked(writeFile).mock.calls.map(c => c[0])
    expect(writeCalls).not.toContain(`${BASE_DIR}/artifacts/fail-moment.png`)
  })

  it('空 artifacts 列表 → 无 IO 调用', async () => {
    const emptyManifest: EvidenceManifest = { ...manifest, artifacts: [] }
    await maskTextArtifacts(BASE_DIR, emptyManifest)
    expect(readFile).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('readFile 抛错时 bubble up', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
    await expect(maskTextArtifacts(BASE_DIR, manifest)).rejects.toThrow('ENOENT')
  })
})
```

- [ ] **Step 2: 跑测试（预期失败）**

```bash
npx vitest run src/__tests__/unit/evidence-masker.test.ts
```

- [ ] **Step 3: 实现 masker**

```typescript
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
```

- [ ] **Step 4: 跑测试（预期通过）**

```bash
npx vitest run src/__tests__/unit/evidence-masker.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/e2e/pipeline-b/evidence/masker.ts src/__tests__/unit/evidence-masker.test.ts
git commit -m "feat(e2e): evidence masker — mask text/* artifacts + 单测"
```

---

### Task 3: evidence storage（单测先行）

**Files:**
- 新建: `src/e2e/pipeline-b/evidence/storage.ts`
- 新建: `src/__tests__/unit/evidence-storage.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/evidence-storage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  rename: vi.fn(),
}))

import { mkdir, rename } from 'fs/promises'
import { persistEvidenceDir } from '../../e2e/pipeline-b/evidence/storage.js'

const DEFAULT_ROOT = '/var/chatops/e2e-evidence'

beforeEach(() => {
  vi.resetAllMocks()
  delete process.env.E2E_EVIDENCE_ROOT
  vi.mocked(mkdir).mockResolvedValue(undefined)
  vi.mocked(rename).mockResolvedValue(undefined)
})

describe('persistEvidenceDir', () => {
  it('默认 root 路径正确', async () => {
    const result = await persistEvidenceDir({
      tempDir: '/tmp/e2e-evidence/scenario-login',
      runId: 42n,
      scenarioId: 'login',
      attemptNumber: 1,
    })

    expect(result.persistedDir).toBe(`${DEFAULT_ROOT}/42/login/1`)
    expect(result.evidenceDirUri).toBe('/admin/e2e-runs/42/evidence/login/1')
  })

  it('E2E_EVIDENCE_ROOT 环境变量覆盖默认 root', async () => {
    process.env.E2E_EVIDENCE_ROOT = '/custom/evidence'

    const result = await persistEvidenceDir({
      tempDir: '/tmp/e2e-evidence/scenario-login',
      runId: 5n,
      scenarioId: 'login',
      attemptNumber: 2,
    })

    expect(result.persistedDir).toBe('/custom/evidence/5/login/2')
    expect(result.evidenceDirUri).toBe('/admin/e2e-runs/5/evidence/login/2')
  })

  it('mkdir 以正确路径被调用（recursive: true）', async () => {
    await persistEvidenceDir({
      tempDir: '/tmp/evidence',
      runId: 1n,
      scenarioId: 'checkout',
      attemptNumber: 1,
    })

    expect(mkdir).toHaveBeenCalledWith(
      `${DEFAULT_ROOT}/1/checkout/1`,
      { recursive: true },
    )
  })

  it('rename 从 tempDir 到 persistedDir', async () => {
    await persistEvidenceDir({
      tempDir: '/tmp/evidence/checkout',
      runId: 1n,
      scenarioId: 'checkout',
      attemptNumber: 3,
    })

    expect(rename).toHaveBeenCalledWith(
      '/tmp/evidence/checkout',
      `${DEFAULT_ROOT}/1/checkout/3`,
    )
  })

  it('mkdir 失败时 bubble up', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(new Error('EPERM'))
    await expect(
      persistEvidenceDir({ tempDir: '/tmp/e', runId: 1n, scenarioId: 's', attemptNumber: 1 }),
    ).rejects.toThrow('EPERM')
  })

  it('rename 失败时 bubble up', async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error('EXDEV'))
    await expect(
      persistEvidenceDir({ tempDir: '/tmp/e', runId: 1n, scenarioId: 's', attemptNumber: 1 }),
    ).rejects.toThrow('EXDEV')
  })
})
```

- [ ] **Step 2: 跑测试（预期失败）**

```bash
npx vitest run src/__tests__/unit/evidence-storage.test.ts
```

- [ ] **Step 3: 实现 storage**

```typescript
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
```

- [ ] **Step 4: 跑测试（预期通过）**

```bash
npx vitest run src/__tests__/unit/evidence-storage.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/e2e/pipeline-b/evidence/storage.ts src/__tests__/unit/evidence-storage.test.ts
git commit -m "feat(e2e): evidence storage — persistEvidenceDir + 单测"
```

---

### Task 4: collect_evidence 节点

**Files:**
- 新建: `src/e2e/pipeline-b/nodes/collect-evidence.ts`

- [ ] **Step 1: 写节点实现**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/e2e/pipeline-b/nodes/collect-evidence.ts
git commit -m "feat(e2e): collect_evidence 节点 — mask + persist + DB update"
```

---

### Task 5: Fastify 路由 — 静态文件服务

**Files:**
- 新建: `src/admin/routes/e2e-evidence.ts`
- 修改: `src/admin/index.ts`

- [ ] **Step 1: 写路由文件**

```typescript
// src/admin/routes/e2e-evidence.ts
import type { FastifyInstance } from 'fastify'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { E2E_EVIDENCE_ROOT_DEFAULT } from '../../e2e/pipeline-b/evidence/storage.js'

function getEvidenceRoot(): string {
  return process.env.E2E_EVIDENCE_ROOT ?? E2E_EVIDENCE_ROOT_DEFAULT
}

export async function registerE2eEvidenceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { runId: string; scenarioId: string; attemptNumber: string; '*': string }
  }>('/e2e-runs/:runId/evidence/:scenarioId/:attemptNumber/*', async (req, reply) => {
    const { runId, scenarioId, attemptNumber } = req.params
    const filePath = req.params['*']

    if (!filePath) {
      return reply.status(400).send({ error: 'file path required' })
    }

    const root = getEvidenceRoot()
    const fullPath = join(root, runId, scenarioId, attemptNumber, filePath)

    try {
      const s = await stat(fullPath)
      if (!s.isFile()) return reply.status(404).send({ error: 'not found' })
    } catch {
      return reply.status(404).send({ error: 'not found' })
    }

    const ext = fullPath.split('.').pop()?.toLowerCase() ?? ''
    const mimeMap: Record<string, string> = {
      txt: 'text/plain',
      log: 'text/plain',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      har: 'application/json',
    }
    const contentType = mimeMap[ext] ?? 'application/octet-stream'

    return reply
      .type(contentType)
      .send(createReadStream(fullPath))
  })
}
```

- [ ] **Step 2: 在 `src/admin/index.ts` 注册路由**

在 `registerE2eSpecRoutes(app)` 后面追加：

```typescript
import { registerE2eEvidenceRoutes } from './routes/e2e-evidence.js'
```

并在函数体末尾 `registerE2eSpecRoutes(app)` 之后添加：

```typescript
  await registerE2eEvidenceRoutes(app)
```

完整的修改上下文（diff 视角）：

```diff
// src/admin/index.ts
+ import { registerE2eEvidenceRoutes } from './routes/e2e-evidence.js'

  // 在 adminPlugin 函数末尾
  await registerE2eTargetRoutes(app)
  await registerE2eSpecRoutes(app)
+ await registerE2eEvidenceRoutes(app)
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
./test.sh --typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/admin/routes/e2e-evidence.ts src/admin/index.ts
git commit -m "feat(e2e): e2e-evidence Fastify 路由 — GET /admin/e2e-runs/:runId/evidence/*"
```

---

### Task 6: 全套测试验证

- [ ] **Step 1: 跑两个单测文件确认全绿**

```bash
npx vitest run src/__tests__/unit/evidence-masker.test.ts
npx vitest run src/__tests__/unit/evidence-storage.test.ts
```

- [ ] **Step 2: typecheck**

```bash
./test.sh --typecheck
```

- [ ] **Step 3: 全套（可选，确认无回归）**

```bash
./test.sh
```
