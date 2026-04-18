/**
 * Per-test 辅助：每个 spec 在 beforeEach 调用，清理上一个用例留下的状态。
 *
 * 仅清理「会在用例间串扰」的表（test_runs、analysis/fix 事件等），
 * 保留 base.sql 中 fixture 级别的数据（产品线 / 流水线 / 项目 / 用户）。
 */
import type { APIRequestContext } from '@playwright/test'
import { getTestPool } from '../../helpers/db.js'

/**
 * 清后端 e2e store + GitLab mock 状态 + 业务表。
 *
 * @param ctx         Playwright APIRequestContext（baseURL 指向后端）
 * @param mockBaseURL GitLab mock 根 URL（例如 http://localhost:4001）
 */
export async function resetPerTest(
  ctx: APIRequestContext,
  mockBaseURL: string,
): Promise<void> {
  // 1) 后端 e2e store（claude mock 队列 + 发送消息记录）
  const r1 = await ctx.post('/admin/_e2e/reset')
  if (!r1.ok()) throw new Error(`[e2e] reset backend store failed: ${r1.status()}`)

  // 2) GitLab mock 状态
  const r2 = await ctx.post(`${mockBaseURL}/_control/reset`)
  if (!r2.ok()) throw new Error(`[e2e] reset gitlab mock failed: ${r2.status()}`)

  // 3) 业务表
  const pool = getTestPool()
  await pool.query(`
    TRUNCATE bug_fix_events CASCADE;
    TRUNCATE bug_analysis_reports CASCADE;
    TRUNCATE test_runs CASCADE;
    TRUNCATE test_run_stage_results CASCADE;
  `)
}

/** 往 e2e store 塞一条 Claude mock 响应。 */
export async function seedClaudeMock(
  ctx: APIRequestContext,
  key: string,
  response: unknown,
): Promise<void> {
  const r = await ctx.post('/admin/_e2e/claude', {
    data: { key, response },
  })
  if (!r.ok()) throw new Error(`[e2e] seed claude mock failed: ${r.status()}`)
}

/** 往 GitLab mock 塞一条响应覆盖。 */
export async function seedGitLabOverride(
  mockBaseURL: string,
  ctx: APIRequestContext,
  opts: { method: string; path: string; iid?: number; response: unknown },
): Promise<void> {
  const r = await ctx.post(`${mockBaseURL}/_control/override`, {
    data: opts,
  })
  if (!r.ok()) throw new Error(`[e2e] seed gitlab override failed: ${r.status()}`)
}
