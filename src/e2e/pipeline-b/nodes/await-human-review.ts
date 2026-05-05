// src/e2e/pipeline-b/nodes/await-human-review.ts
//
// 场景失败后等用户在 IM 里回复决策：approve（同意进 e2e-fix-agent）/ retry（重跑场景，
// 怀疑 flaky）/ reject（标记 unfixable，跳过）。
//
// 暂停机制：复用 pipeline/im-param-collector.ts:waitForImMessage 的 Promise + waiter
// 模式（schema-v19 起的 chatops 通用 IM 等待机制）。session-manager 已经把 IM 消息
// 路由给 waiter，本节点不需要碰路由层。
//
// process restart 会丢失 waiter—— 跟 pipeline-b 现状一致（startup-recovery 把
// in-flight runs 当 aborted 处理）。后续如要持久化，统一加 LangGraph Checkpointer。
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { waitForImMessage } from '../../../pipeline/im-param-collector.js'
import { notifyAwaitHumanReview, type ImNotifyOptions } from '../im-notifier.js'
import type { HumanReviewDecision, PipelineBStateType } from '../types.js'

const HUMAN_REVIEW_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * 把用户 IM 回复解析成决策。匹配关键词、忽略大小写。
 *
 * approve: approve / 批准 / 同意 / 修 / yes / ok / 确认
 * retry:   retry / 重跑 / 再试 / 重试
 * reject:  reject / 跳过 / 不修 / 拒绝 / no / cancel
 *
 * 没匹配上 → 默认 reject（保守不浪费 token，且让用户清晰知道措辞要求）。
 */
export function parseDecision(text: string): HumanReviewDecision {
  const lower = text.toLowerCase().trim()
  if (/(approve|批准|同意|^修$|^yes$|^ok$|确认)/i.test(lower)) return 'approve'
  if (/(retry|重跑|再试|重试)/i.test(lower)) return 'retry'
  if (/(reject|跳过|不修|拒绝|^no$|cancel)/i.test(lower)) return 'reject'
  return 'reject'
}

export async function awaitHumanReviewNode(
  state: PipelineBStateType,
): Promise<Partial<PipelineBStateType>> {
  const { imContext, currentManifest, currentScenario, runId } = state

  // 没 IM 上下文 / 没 manifest / 没 scenario → 默认 reject（API 触发的 run 没人能审）
  if (!imContext || !currentManifest || !currentScenario) {
    console.log(
      `[PipelineB:awaitHumanReview] runId=${runId} 没 imContext/manifest/scenario → 默认 reject`,
    )
    return { humanReviewDecision: 'reject' }
  }

  await updateE2eRunStatus(runId, 'awaiting_human_review')

  const notifyOpts: ImNotifyOptions = {
    adapter: imContext.adapter,
    groupId: imContext.groupId,
    runId,
  }
  await notifyAwaitHumanReview(notifyOpts, currentScenario.id, currentManifest)

  let decision: HumanReviewDecision
  try {
    const text = await waitForImMessage(
      imContext.platform,
      imContext.groupId,
      HUMAN_REVIEW_TIMEOUT_MS,
    )
    decision = parseDecision(text)
    console.log(
      `[PipelineB:awaitHumanReview] runId=${runId} scenario=${currentScenario.id} text="${text.slice(0, 80)}" → ${decision}`,
    )
  } catch (err) {
    // 24h 超时 → 默认 reject
    console.warn(
      `[PipelineB:awaitHumanReview] runId=${runId} 超时或 IM 等待失败，默认 reject:`,
      (err as Error).message,
    )
    decision = 'reject'
  }

  await updateE2eRunStatus(runId, 'running')
  return { humanReviewDecision: decision }
}
