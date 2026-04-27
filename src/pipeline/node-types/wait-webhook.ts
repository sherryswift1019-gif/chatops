import { registerNodeType } from './registry.js'

/**
 * Phase 3 stub —— wait_webhook 节点是 LangGraph interrupt-bound 节点，
 * 由 graph-builder.ts:649 switch dispatch 通过 buildWaitWebhookNode 调起。
 * 内部用 interrupt({type:'webhook', tag, ...}) 挂起，graph-runner 注册
 * WebhookWaiter，HTTP 端点收到 payload 后 resumeRun(new Command({resume})).
 *
 * 标准 NodeExecutor.execute(params, ctx) 没有 LangGraph runtime，
 * interrupt() 抛 GraphInterrupt 没有 supergraph 接住——直接调用会死。
 * 同时 Webhook 路由通过 interrupt payload 的 tag 字段映射回 (runId,
 * stageIndex)，离开 LangGraph 后这层路由也丢了。
 *
 * 待 NodeExecutor 接口扩展支持 interrupt-class（spec §4.7 / phase 3 之后）
 * 才能切 standalone。当前 throw 仅用于满足 registry 一致性检查。
 *
 * Production execution 路径：src/pipeline/graph-builder.ts buildWaitWebhookNode。
 */
registerNodeType({
  key: 'wait_webhook',
  async execute() {
    throw new Error(
      'wait_webhook executor is interrupt-bound: must be invoked via graph-builder switch (buildWaitWebhookNode), not standalone NodeExecutor.execute. See src/pipeline/node-types/wait-webhook.ts header.',
    )
  },
})
