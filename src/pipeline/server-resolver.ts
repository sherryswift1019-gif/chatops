/**
 * server-resolver — webhook / admin manual / api / scheduler 触发路径在「调用方
 * 未显式指定服务器分配」时按 role 自动分配 test_servers 的兜底逻辑。
 *
 * 历史背景：admin 手动 / api 路径在 routes/test-runs.ts 里有内联实现，但
 * webhook-router.ts 漏抄了同一兜底，导致用 webhook 触发依赖 server_roles 的
 * pipeline 时 ctx.servers 为空、graph-builder 报 no_executor。本模块抽出来共用，
 * 行为保持与原 routes/test-runs.ts 等价。scheduler.ts cron 触发路径同样接入了
 * 这个 helper（pipeline_schedules 目前无显式 servers 字段，相当于"调用方未指定"）。
 *
 * 故意不动的路径（业务语义上故意传 {}，不需要兜底）：
 *   - coordinator.ts (internal capability pipeline，按 binding 显式分配)
 *   - submit-handler.ts (PRD submit internal pipeline，serverless)
 *   - autotest.ts (自带 host 模式的 by-role 自动分配，旧路径)
 *   - executor-legacy.ts (legacy 引擎)
 */

import { listTestServers } from '../db/repositories/test-servers.js'

/**
 * 按 role 把所有 test_servers 分组，返回 `{ <role>: [<id_string>...] }`。
 * id 转 string 是为了和 webhook payload `_servers` / pipeline_bindings.server_role_assignments
 * 的 JSONB 形状（Record<string, string[]>）对齐。
 *
 * 没有任何带 role 的 server 时返回 `{}`，调用方按需决定是否继续触发
 * （runPipeline 见 servers={} 直接跳过 hydrateServerAssignments，serverless
 * pipeline 仍可正常跑）。
 */
export async function autoResolveServersByRole(): Promise<Record<string, string[]>> {
  const allServers = await listTestServers()
  const byRole: Record<string, string[]> = {}
  for (const s of allServers) {
    if (s.role) {
      if (!byRole[s.role]) byRole[s.role] = []
      byRole[s.role].push(String(s.id))
    }
  }
  return byRole
}
