// src/e2e/pipeline-b/nodes/await-human-review.ts
//
// 场景失败后等用户决策：approve（同意进 e2e-fix-agent）/ retry（重跑场景，
// 怀疑 flaky）/ reject（标记 unfixable，跳过）。
//
// 决策来源（按 imContext 是否存在二选一）：
//  - 有 imContext：复用 pipeline/im-param-collector.ts:waitForImMessage 等下条
//    IM 消息（schema-v19 起的 chatops 通用 IM 等待机制）。
//  - 无 imContext（admin Web UI 触发，trigger_type=manual_draft / api）：
//    走 web-review-waiter，等 admin POST /e2e-runs/:runId/review-decision。
//
// process restart 会丢 waiter—— 跟 pipeline-b 现状一致（startup-recovery 把
// in-flight runs 当 aborted 处理）。后续如要持久化，统一加 LangGraph Checkpointer。
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { waitForImMessage } from '../../../pipeline/im-param-collector.js'
import { notifyAwaitHumanReview, type ImNotifyOptions } from '../im-notifier.js'
import { waitForWebReviewDecision } from '../web-review-waiter.js'
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
  const { imContext, currentManifest, currentScenario, currentScenarioRunId, runId } = state

  // 缺 scenario → 兜底 reject（理论不会发生，run_scenario fail 后才进本节点）
  if (!currentScenario) {
    console.log(
      `[PipelineB:awaitHumanReview] runId=${runId} 缺 scenario → 默认 reject`,
    )
    return { humanReviewDecision: 'reject' }
  }

  // 注意：currentManifest 可能是 null（host Claude 跑挂或没写 manifest.json）。
  // 历史代码在此情况直接 reject，会写出"human reviewer rejected"的误导文案。
  // 实际 manifest 缺失只影响 IM 通知里能展示的失败摘要，不影响人审决策能力——
  // 让用户自己看 scenarioRunnerError 决定 approve/retry/reject 才正确。

  // 无 imContext + 无 scenarioRunId → 既无 IM 也无 web waiter 锚点，兜底 reject
  if (!imContext && !currentScenarioRunId) {
    console.log(
      `[PipelineB:awaitHumanReview] runId=${runId} 无 imContext/scenarioRunId → 默认 reject`,
    )
    return { humanReviewDecision: 'reject' }
  }

  await updateE2eRunStatus(runId, 'awaiting_human_review')

  let decision: HumanReviewDecision
  try {
    if (imContext) {
      const notifyOpts: ImNotifyOptions = {
        adapter: imContext.adapter,
        groupId: imContext.groupId,
        runId,
      }
      // manifest 缺失时 IM 通知里少一段失败摘要，但不阻塞决策
      if (currentManifest) {
        await notifyAwaitHumanReview(notifyOpts, currentScenario.id, currentManifest)
      }
      const text = await waitForImMessage(
        imContext.platform,
        imContext.groupId,
        HUMAN_REVIEW_TIMEOUT_MS,
      )
      decision = parseDecision(text)
      console.log(
        `[PipelineB:awaitHumanReview] runId=${runId} scenario=${currentScenario.id} via=im text="${text.slice(0, 80)}" → ${decision}`,
      )
    } else {
      // currentScenarioRunId 已在前面 guard 中保证非空
      decision = await waitForWebReviewDecision(
        runId,
        currentScenarioRunId!,
        HUMAN_REVIEW_TIMEOUT_MS,
      )
      console.log(
        `[PipelineB:awaitHumanReview] runId=${runId} scenario=${currentScenario.id} via=web → ${decision}`,
      )
    }
  } catch (err) {
    // 24h 超时 / waiter 异常 → 默认 reject
    console.warn(
      `[PipelineB:awaitHumanReview] runId=${runId} 超时或等待失败，默认 reject:`,
      (err as Error).message,
    )
    decision = 'reject'
  }

  await updateE2eRunStatus(runId, 'running')
  return { humanReviewDecision: decision }
}
