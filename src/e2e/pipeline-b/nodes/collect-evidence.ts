// src/e2e/pipeline-b/nodes/collect-evidence.ts
//
// @deprecated 在 playbook-driven 模式下，evidence 持久化 + manifest 写库由 run-scenario
// 节点直接完成，本节点只做 noop 占位以维持当前 graph 拓扑。下一 commit（await_human_review
// 改造）会从 graph 拓扑里移除该节点。
import type { PipelineBStateType } from '../types.js'

export interface CollectEvidenceInput {
  context: unknown
}

export async function collectEvidenceNode(_input: CollectEvidenceInput): Promise<Partial<PipelineBStateType>> {
  return {}
}
