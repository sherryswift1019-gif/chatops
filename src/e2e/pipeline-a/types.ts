// src/e2e/pipeline-a/types.ts
import { Annotation } from '@langchain/langgraph'

export interface SpecWorkItem {
  specId: bigint
  specPath: string
  title: string
  contentHash: string
  targetProjectId: string
  scriptPath?: string       // 生成出来的 .spec.ts 路径
  generatedContent?: string // LLM 输出的脚本文本
}

export interface BaselineSandboxHandle {
  envId: string
  kind: string
  endpoints: Record<string, string>
  internalRefs: Record<string, unknown>
  sandboxId: bigint
  containerId?: string
  workdir?: string
}

export type DiagnosisVerdict = 'script_bug' | 'product_bug'

export interface BaselineResult {
  specId: bigint
  passed: boolean
  verdict?: DiagnosisVerdict
  evidenceDir?: string
  evidenceSummary?: string
}

export const PipelineAState = Annotation.Root({
  // 输入
  targetProjectId: Annotation<string>({ default: () => '', reducer: (_, v) => v }),
  specPaths: Annotation<string[]>({ default: () => [], reducer: (_, v) => v }),
  baseBranch: Annotation<string>({ default: () => 'main', reducer: (_, v) => v }),

  // 工作列表
  specs: Annotation<SpecWorkItem[]>({ default: () => [], reducer: (_, v) => v }),
  currentSpecIndex: Annotation<number>({ default: () => 0, reducer: (_, v) => v }),

  // 沙盒
  sandboxHandle: Annotation<BaselineSandboxHandle | null>({ default: () => null, reducer: (_, v) => v }),

  // 当前 spec 处理中间状态
  staticCheckAttempts: Annotation<number>({ default: () => 0, reducer: (_, v) => v }),
  staticCheckResult: Annotation<'pass' | 'fail' | null>({ default: () => null, reducer: (_, v) => v }),
  baselineAttempts: Annotation<number>({ default: () => 0, reducer: (_, v) => v }),
  lastBaselineResult: Annotation<BaselineResult | null>({ default: () => null, reducer: (_, v) => v }),
  diagnosisVerdict: Annotation<DiagnosisVerdict | null>({ default: () => null, reducer: (_, v) => v }),

  // 结果
  completedSpecs: Annotation<Array<{ specId: bigint; status: string; prUrl?: string }>>({
    default: () => [],
    reducer: (prev, v) => [...prev, ...v],
  }),

  // governor 限制
  maxStaticCheckAttempts: Annotation<number>({ default: () => 2, reducer: (_, v) => v }),
  maxBaselineAttempts: Annotation<number>({ default: () => 3, reducer: (_, v) => v }),

  // 错误暂存
  lastError: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
})

export type PipelineAStateType = typeof PipelineAState.State
