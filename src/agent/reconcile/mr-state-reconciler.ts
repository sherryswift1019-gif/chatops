/**
 * MR 状态定时对账（Reconciliation Job）
 *
 * 背景：
 *   现有实现靠 GitLab webhook 被动同步 MR merged/closed 到 bug_analysis_reports.status。
 *   webhook 漏发时报告会永远停在 pipeline_success。本模块是双轨制的兜底路径。
 *
 * 机制：
 *   - reconcileOnce()：扫描 pipeline_success 态报告（最近 N 天），查 GitLab MR API 真实 state，
 *     补齐 lifecycle_sync 事件并更新 status。
 *   - startMrReconciler() / stopMrReconciler()：setInterval 调度器。
 *
 * 幂等：lifecycle_sync 事件按 (mrIid, mrAction) 去重，webhook 与 reconciler 两路径不冲突。
 *   - data.source='webhook'   issue-handler 写入
 *   - data.source='reconciler' 本模块写入
 *
 * 相关文档：docs/superpowers/plans/2026-04-20-mr-state-reconciliation.md
 */
import pLimit from 'p-limit'
import { getPool } from '../../db/client.js'
import {
  updateReportStatus,
  type ReportStatus,
} from '../../db/repositories/bug-analysis-reports.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import { gitlabGetMr } from '../analysis/gitlab-mr.js'

// ────────────────────────────────────────────────────────────────
// 配置（默认值 + 环境变量覆盖；均做边界防御）
// ────────────────────────────────────────────────────────────────
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000 // 5 min
const DEFAULT_WINDOW_DAYS = 7
const DEFAULT_CONCURRENCY = 1 // 默认串行
const MIN_INTERVAL_MS = 60_000 // 最小 60s，防误配高频

function readConfig(): {
  intervalMs: number
  windowDays: number
  concurrency: number
} {
  const rawInterval = Number(process.env.MR_RECONCILE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
  const rawWindow = Number(process.env.MR_RECONCILE_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS)
  const rawConcurrency = Number(process.env.MR_RECONCILE_CONCURRENCY ?? DEFAULT_CONCURRENCY)
  return {
    intervalMs: rawInterval >= MIN_INTERVAL_MS ? rawInterval : DEFAULT_INTERVAL_MS,
    windowDays: rawWindow > 0 ? rawWindow : DEFAULT_WINDOW_DAYS,
    concurrency: rawConcurrency > 0 ? rawConcurrency : DEFAULT_CONCURRENCY,
  }
}

// ────────────────────────────────────────────────────────────────
// 核心对账逻辑
// ────────────────────────────────────────────────────────────────
export interface ReconcileStats {
  scanned: number
  mergedSynced: number
  closedSynced: number
  skipped: number // 已有 lifecycle_sync / state=opened / multi-project 未全终态
  failures: Array<{ reportId: number; projectPath: string; mrIid: number; error: string }>
}

interface MrRow {
  reportId: number
  projectPath: string
  mrIid: number
}

export async function reconcileOnce(opts?: {
  windowDays?: number
  concurrency?: number
}): Promise<ReconcileStats> {
  const cfg = readConfig()
  const windowDays = opts?.windowDays ?? cfg.windowDays
  const concurrency = opts?.concurrency ?? cfg.concurrency
  const validConcurrency = concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY
  const limit = pLimit(validConcurrency)

  const stats: ReconcileStats = {
    scanned: 0,
    mergedSynced: 0,
    closedSynced: 0,
    skipped: 0,
    failures: [],
  }

  // 扫描：pipeline_success 且在窗口内的报告，join create_mr 成功事件拿 (projectPath, mrIid)
  const pool = getPool()
  const { rows } = await pool.query<{
    report_id: number
    project_path: string
    mr_iid: number
  }>(
    `SELECT r.id AS report_id, e.project_path, (e.data->>'mrIid')::int AS mr_iid
     FROM bug_analysis_reports r
     JOIN bug_fix_events e
       ON e.report_id = r.id
       AND e.code = 'create_mr'
       AND e.status = 'success'
     WHERE r.status = 'pipeline_success'
       AND r.created_at > now() - ($1 || ' days')::interval
     ORDER BY r.id ASC, e.id ASC`,
    [String(windowDays)],
  )

  const mrRows: MrRow[] = rows
    .filter(r => r.project_path && r.mr_iid)
    .map(r => ({
      reportId: r.report_id,
      projectPath: r.project_path,
      mrIid: r.mr_iid,
    }))
  stats.scanned = mrRows.length

  // 按 reportId 分组，用于多 project 场景下的"全终态才更新 status"语义（D5）
  const byReport = new Map<number, MrRow[]>()
  for (const row of mrRows) {
    const arr = byReport.get(row.reportId) ?? []
    arr.push(row)
    byReport.set(row.reportId, arr)
  }

  await Promise.all(
    Array.from(byReport.entries()).map(([reportId, rowsInReport]) =>
      limit(() => handleReport(reportId, rowsInReport, stats)),
    ),
  )

  return stats
}

/**
 * 处理单个 report 的所有 MR：
 *   1. 查每个 MR 的当前 state
 *   2. 写 lifecycle_sync 事件（幂等）
 *   3. 仅当所有 MR 都终态（merged/closed）时才更新 report.status（D5）
 *      - 全 merged → completed
 *      - 任一 closed → aborted（即使有 merged 也视为异常）
 *      - 还有 opened/locked → 本轮不更新 status，继续等
 */
async function handleReport(
  reportId: number,
  mrs: MrRow[],
  stats: ReconcileStats,
): Promise<void> {
  const existingSync = await findByReportCode(reportId, 'lifecycle_sync')
  const existingMergedMrs = new Set<number>()
  const existingClosedMrs = new Set<number>()
  for (const ev of existingSync) {
    const d = ev.data as { mrAction?: string; mrIid?: number }
    if (d.mrIid) {
      if (d.mrAction === 'merge') existingMergedMrs.add(d.mrIid)
      else if (d.mrAction === 'close') existingClosedMrs.add(d.mrIid)
    }
  }

  // 第 1 轮：查每个 MR 的 state（记入结果集合；已 synced 的用事件状态）
  const mrStates = new Map<number, 'merged' | 'closed' | 'open'>()
  for (const mr of mrs) {
    if (existingMergedMrs.has(mr.mrIid)) {
      mrStates.set(mr.mrIid, 'merged')
      continue
    }
    if (existingClosedMrs.has(mr.mrIid)) {
      mrStates.set(mr.mrIid, 'closed')
      continue
    }
    try {
      const remoteMr = await gitlabGetMr({
        projectPath: mr.projectPath,
        mrIid: mr.mrIid,
      })
      if (remoteMr.state === 'merged') {
        await createEvent({
          reportId,
          projectPath: mr.projectPath,
          code: 'lifecycle_sync',
          status: 'success',
          data: {
            mrAction: 'merge',
            mrIid: mr.mrIid,
            targetStatus: 'completed',
            mergedBy: remoteMr.merged_by?.username ?? null,
            source: 'reconciler',
          },
        })
        mrStates.set(mr.mrIid, 'merged')
        stats.mergedSynced++
      } else if (remoteMr.state === 'closed') {
        await createEvent({
          reportId,
          projectPath: mr.projectPath,
          code: 'lifecycle_sync',
          status: 'success',
          data: {
            mrAction: 'close',
            mrIid: mr.mrIid,
            targetStatus: 'aborted',
            closedBy: remoteMr.closed_by?.username ?? null,
            source: 'reconciler',
          },
        })
        mrStates.set(mr.mrIid, 'closed')
        stats.closedSynced++
      } else {
        // opened / locked：不动
        mrStates.set(mr.mrIid, 'open')
        stats.skipped++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      stats.failures.push({
        reportId,
        projectPath: mr.projectPath,
        mrIid: mr.mrIid,
        error: msg,
      })
      console.error(
        `[mr-reconciler] report ${reportId} MR ${mr.projectPath}#${mr.mrIid} query failed:`,
        msg,
      )
      // 当前 MR 查询失败，视作未终态，本轮不更新 report.status
      mrStates.set(mr.mrIid, 'open')
    }
  }

  // 第 2 轮：按 D5 语义决定是否更新 report.status
  const states = Array.from(mrStates.values())
  const allTerminal = states.every(s => s === 'merged' || s === 'closed')
  if (!allTerminal) {
    // 还有 opened/locked 的 MR，本轮不更新
    return
  }

  const anyClosed = states.some(s => s === 'closed')
  const targetStatus: ReportStatus = anyClosed ? 'aborted' : 'completed'

  // 仅当旧 status 仍是 pipeline_success 时更新（防止和 webhook 路径/重复执行竞争）
  await updateReportStatus(reportId, targetStatus)
}

// ────────────────────────────────────────────────────────────────
// 调度器（参照 worktree/cleanup-scheduler.ts 的 setInterval 模式）
// ────────────────────────────────────────────────────────────────
let intervalId: ReturnType<typeof setInterval> | null = null

export function startMrReconciler(): void {
  if (intervalId) return // 幂等启动
  const { intervalMs } = readConfig()
  intervalId = setInterval(async () => {
    try {
      const stats = await reconcileOnce()
      console.log('[mr-reconciler] scan done:', stats)
    } catch (err) {
      console.error('[mr-reconciler] reconcileOnce failed:', err)
    }
  }, intervalMs)
  console.log(`[mr-reconciler] started (interval: ${intervalMs}ms)`)
}

export function stopMrReconciler(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
  console.log('[mr-reconciler] stopped')
}
