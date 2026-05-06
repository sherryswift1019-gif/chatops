// src/e2e/pipeline-b/types.ts
import { Annotation } from '@langchain/langgraph'
import type { IMAdapter } from '../../adapters/im/types.js'
import type { Manifest } from './playbook/manifest.js'
import type { Playbook } from './playbook/types.js'

export type HumanReviewDecision = 'approve' | 'retry' | 'reject'

export interface ImContext {
  adapter: IMAdapter
  groupId: string
  platform: string
}

export interface ScenarioInfo {
  id: string
  name: string
  tags: string[]
}

export interface GovernorState {
  perScenarioAttempts: Record<string, number>
  totalElapsedMs: number
  totalAttempts: number
  runStartedAt: number
  limits: {
    maxPerScenarioAttempts: number
    maxRunHours: number
    maxTotalAttempts: number
    maxQueuedRuns: number
  }
}

export interface AiDiagnosis {
  verdict: 'product_bug' | 'test_flakiness' | 'infra_issue' | 'uncertain'
  rootCauseSummary: string
  fixCommitSha: string | null
  fixedFiles: string[]
  success: boolean
  failureReason: string
}

export interface SandboxHandle {
  envId: string
  kind: string
  endpoints: Record<string, string>
  internalRefs: Record<string, unknown>
  containerId?: string
  workdir?: string
}

export const PipelineBState = Annotation.Root({
  runId: Annotation<bigint>(),
  sandboxId: Annotation<bigint | null>({ default: () => null, reducer: (_, v) => v }),
  targetProjectId: Annotation<string>(),
  sourceBranch: Annotation<string>(),
  iterationBranch: Annotation<string>(),
  scenarioFilter: Annotation<{ ids?: string[]; tags?: string[] } | null>({ default: () => null, reducer: (_, v) => v }),
  sandboxHandle: Annotation<SandboxHandle | null>({ default: () => null, reducer: (_, v) => v }),
  projectScripts: Annotation<{ build: string; deploy: string; test: string; fix?: string }>({
    default: () => ({ build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' }),
    reducer: (_, v) => v,
  }),
  pendingScenarios: Annotation<ScenarioInfo[]>({ default: () => [], reducer: (_, v) => v }),
  currentScenario: Annotation<ScenarioInfo | null>({ default: () => null, reducer: (_, v) => v }),
  currentScenarioRunId: Annotation<bigint | null>({ default: () => null, reducer: (_, v) => v }),
  lastScenarioResult: Annotation<'pass' | 'fail' | 'error' | 'timeout' | null>({ default: () => null, reducer: (_, v) => v }),
  lastFixResult: Annotation<AiDiagnosis | null>({ default: () => null, reducer: (_, v) => v }),
  evidenceDirTemp: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  humanReviewDecision: Annotation<HumanReviewDecision | null>({ default: () => null, reducer: (_, v) => v }),
  currentManifest: Annotation<Manifest | null>({ default: () => null, reducer: (_, v) => v }),
  playbooks: Annotation<Record<string, Playbook>>({ default: () => ({}), reducer: (_, v) => v }),
  governorState: Annotation<GovernorState>({
    default: () => ({
      perScenarioAttempts: {},
      totalElapsedMs: 0,
      totalAttempts: 0,
      runStartedAt: Date.now(),
      limits: {
        maxPerScenarioAttempts: 3,
        maxRunHours: 4,
        maxTotalAttempts: 30,
        maxQueuedRuns: 2,
      },
    }),
    reducer: (_, v) => v,
  }),
  summaryMrUrl: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  errorMessage: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  // 标记最近被打成 unfixable 的 scenario id，用于 finalize-failed 区分
  // “真预算超限”vs“某个 scenario 不可修”两条到达 finalize_failed 的路径。
  lastUnfixableScenario: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  imContext: Annotation<ImContext | null>({ default: () => null, reducer: (_, v) => v }),
  playbookDraftId: Annotation<bigint | undefined>({ default: () => undefined, reducer: (_, v) => v }),
})

export type PipelineBStateType = typeof PipelineBState.State
