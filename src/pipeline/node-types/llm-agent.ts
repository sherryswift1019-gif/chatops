import { registerNodeType } from './registry.js'

/**
 * Phase 3 stub —— llm_agent 节点（旧名 capability，T17 重命名）目前由
 * graph-builder.ts:649 switch dispatch 通过 buildCapabilityNode 调起。
 * relevant 实现 (executor-hooks.ts runCapability) 调用 triggerCapability(ClaudeRunner)，
 * 返回结构化 StageExecutionResult。
 *
 * standalone 化的关键卡点：buildCapabilityNode 在执行时读取 LangGraph
 * state.runtimeVars（im_input / wait_webhook 节点跨 stage 写入的运行时变量），
 * 与 stageContext.variables 合并后传给 capability 模板解析。
 *
 * 标准 NodeExecutor.execute(params, ctx) 只拿到 ctx.vars 这一份快照，
 * 无法反映 pipeline 进行中其他 stage 写入的最新 runtimeVars。要切到
 * standalone 路径，必须先把 LangGraph state.runtimeVars 同步进 ctx.vars
 * （graph-runner 在 dispatchInterrupt / handleChunk 时刷快照），见 spec §4.7。
 *
 * 当前 phase 3 v1 保留 switch 路径；仅做了 key 重命名（capability → llm_agent）,
 * 标准 NodeExecutor 化推迟到后续 phase。
 *
 * Production execution 路径：src/pipeline/graph-builder.ts buildCapabilityNode。
 */
registerNodeType({
  key: 'llm_agent',
  async execute() {
    throw new Error(
      'llm_agent executor is state-bound (reads LangGraph state.runtimeVars at exec time): must be invoked via graph-builder switch (buildCapabilityNode), not standalone NodeExecutor.execute. See src/pipeline/node-types/llm-agent.ts header.',
    )
  },
})
