/**
 * 审批人 resolver 注册表。
 *
 * 动机：真实业务中审批人几乎都是上下文决定的（L3 主仓库 owner / 报销金额判定 /
 * 生产 OPS 产品线负责人 …），静态 `approverIds` 配置只适合少数固定流程场景。
 * Pipeline 定义时只声明"用哪个策略"，运行时由业务代码决定具体是谁。
 *
 * 设计目标：
 *   1. 解耦 pipeline 引擎 / 业务数据——graph-builder 不 import 任何 repo，
 *      业务 resolver 在 server.ts 启动时注册进来（同 capability handler 模式）
 *   2. 可测试——测试里可以注册 mock resolver 不碰 DB
 *   3. 可扩展——新审批场景加 resolver 即可，不用改 graph-builder
 *
 * 使用方式：
 *   业务侧（src/agent/approval/resolvers.ts）调 registerApprovalResolver(name, fn)
 *   pipeline 定义：{ stageType: 'approval', approverIdsResolver: 'xxx' }
 *   graph-builder 运行时调 resolveApprovers(name, triggerParams)
 */

export interface ApprovalResolverResult {
  /** 此次审批的审批人钉钉 user id 列表 */
  approverIds: string[]
  /** 可选：resolver 生成的 description（钉钉卡片 body）；不返回则用 stage.approvalDescription */
  description?: string
}

export type ApprovalResolverFn = (
  triggerParams: Record<string, unknown>,
) => Promise<ApprovalResolverResult>

const resolvers = new Map<string, ApprovalResolverFn>()

export function registerApprovalResolver(name: string, fn: ApprovalResolverFn): void {
  if (resolvers.has(name)) {
    console.warn(`[approval-resolver] 覆盖已注册的 resolver: ${name}`)
  }
  resolvers.set(name, fn)
  console.log(`[approval-resolver] registered: ${name}`)
}

export async function resolveApprovers(
  name: string,
  triggerParams: Record<string, unknown>,
): Promise<ApprovalResolverResult> {
  const fn = resolvers.get(name)
  if (!fn) {
    throw new Error(
      `Unknown approval resolver: "${name}". 请确认已通过 registerApprovalResolver 注册` +
      `（一般在 server.ts 启动时调 registerBuiltinApprovalResolvers）`,
    )
  }
  return fn(triggerParams)
}

/** 仅供单测：清空注册表避免跨用例污染 */
export function resetApprovalResolvers(): void {
  resolvers.clear()
}
