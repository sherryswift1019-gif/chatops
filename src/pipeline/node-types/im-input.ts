import { registerNodeType } from './registry.js'

/**
 * Phase 3 stub —— im_input 节点是 LangGraph interrupt-bound + 多轮循环节点，
 * 由 graph-builder.ts:649 switch dispatch 通过 buildImInputNode 调起。
 * 内部 while(true) loop：interrupt({type:'im_input', prompt, ...}) 挂起，
 * graph-runner 注册 ImWaiter + notifyImGroup 推 prompt 到群，IM 消息
 * resumeRun(Command({resume:<userMessage>|TIMEOUT_SENTINEL|CANCEL_SENTINEL}))
 * 恢复，consultImInputAgent 判定 done/aborted/continue，未 done 则下一轮 interrupt。
 *
 * standalone 化双重卡点：
 *   1. interrupt() 抛 GraphInterrupt 必须在 LangGraph runtime 内 catch
 *      （NodeExecutor v1 接口没有 interrupt 语义）；
 *   2. 多轮 interrupt 循环依赖 LangGraph checkpointer 跨 stream 持久化闭包
 *      变量（collected 参数 + nextPrompt 在恢复时重放）—— 没 LangGraph 这套
 *      恢复机制，标准 NodeExecutor 无法做多轮 interrupt。
 *
 * 待 NodeExecutor 接口扩展支持 interrupt-class（spec §4.7 / phase 3 之后）
 * 才能切 standalone。当前 throw 仅用于满足 registry 一致性检查。
 *
 * Production execution 路径：src/pipeline/graph-builder.ts buildImInputNode。
 */
registerNodeType({
  key: 'im_input',
  async execute() {
    throw new Error(
      'im_input executor is interrupt-bound + multi-turn-loop: must be invoked via graph-builder switch (buildImInputNode), not standalone NodeExecutor.execute. See src/pipeline/node-types/im-input.ts header.',
    )
  },
})
