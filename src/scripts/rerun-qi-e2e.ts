// src/scripts/rerun-qi-e2e.ts
//
// 临时脚本：在 requirement #1 已有 worktree + dev commit 的基础上，
// 单独跑 qi_e2e_runner 节点验证 target 配置生效（sherryswift1019-group/chatops 已登记）。
// 不走 graph，不动 LangGraph checkpoint。
//
// 跑：pnpm exec tsx src/scripts/rerun-qi-e2e.ts
import 'dotenv/config'
import { getExecutor } from '../pipeline/node-types/registry.js'
import '../pipeline/node-types/qi-e2e-runner.js'
import type { ExecutionContext } from '../pipeline/node-types/types.js'

const REQ_ID = Number(process.env.REQ_ID ?? 1)
const WORKTREE = process.env.WORKTREE ?? `/tmp/quick-impl/qi-${REQ_ID}`
const BRANCH = process.env.BRANCH ?? `feat/qi-${REQ_ID}`
const BARE = process.env.BARE ?? '/Users/zhangshanshan/.chatops-repos-qi-bare/sherryswift1019-group-chatops.git'

async function main(): Promise<void> {
  const executor = getExecutor('qi_e2e_runner')
  if (!executor) throw new Error('qi_e2e_runner not registered')

  const ctx: ExecutionContext = {
    runId: -1,
    pipelineId: -1,
    nodeId: 'qi_e2e_runner',
    triggerParams: { requirementId: REQ_ID },
    vars: {},
    steps: {},
  }

  const params = {
    requirementId: REQ_ID,
    worktreePath: WORKTREE,
    branch: BRANCH,
    bareRepoPath: BARE,
    maxAttempts: 2,
  }

  console.log('[rerun-qi-e2e] params:', JSON.stringify(params))
  const startMs = Date.now()
  const result = await executor.execute(params, ctx)
  const elapsedMs = Date.now() - startMs

  console.log(`\n[rerun-qi-e2e] DONE in ${(elapsedMs / 1000).toFixed(1)}s`)
  console.log(`  status: ${result.status}`)
  console.log(`  error: ${result.error ?? '-'}`)
  console.log('  output:')
  console.log(JSON.stringify(result.output, null, 2))

  process.exit(result.status === 'success' ? 0 : 1)
}

main().catch(err => {
  console.error('[rerun-qi-e2e] FATAL:', err)
  process.exit(2)
})
