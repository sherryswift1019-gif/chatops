import { registerNodeType } from './registry.js'

/**
 * Phase 3 stub —— approval 节点是 LangGraph interrupt-bound 节点，
 * 必须由 graph-builder.ts:649 switch dispatch 通过 buildApprovalNode 调起，
 * 内部用 interrupt(payload) 挂起 + Command({resume}) 恢复。
 *
 * 标准 NodeExecutor.execute(params, ctx) 没有 LangGraph runtime，
 * interrupt() 抛出的 GraphInterrupt 没有 supergraph 接住——直接调用会死。
 *
 * 待 spec §4.7 / phase 3 之后 NodeExecutor 接口扩展支持 interrupt-class
 * 节点（增加 `interruptable: true` flag + RunnableConfig 入参）后，
 * 才能把这里的 throw 替换为真实实现。当前 throw 仅用于满足 registry
 * 一致性检查（DB enabled keys ↔ code registered keys）。
 *
 * Production execution 路径：src/pipeline/graph-builder.ts buildApprovalNode。
 */
registerNodeType({
  key: 'approval',
  async execute() {
    throw new Error(
      'approval executor is interrupt-bound: must be invoked via graph-builder switch (buildApprovalNode), not standalone NodeExecutor.execute. See src/pipeline/node-types/approval.ts header.',
    )
  },
})
