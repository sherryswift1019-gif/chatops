import type { IMAdapter } from '../../adapters/im/types.js'

export interface ImNotifyOptions {
  adapter: IMAdapter
  groupId: string
  runId: bigint
}

function adminUrl(): string {
  return process.env.CHATOPS_ADMIN_URL ?? 'http://localhost:3000'
}

async function send(opts: ImNotifyOptions, text: string): Promise<void> {
  try {
    await opts.adapter.sendMessage({ type: 'group', id: opts.groupId }, { text })
  } catch (err) {
    console.warn(`[e2e-im-notifier] sendMessage failed runId=${opts.runId}:`, err)
  }
}

export async function notifyRunStarted(opts: ImNotifyOptions, totalScenarios: number): Promise<void> {
  const scenariosText = totalScenarios > 0 ? ` · 跑 ${totalScenarios} 个场景` : ''
  const url = `${adminUrl()}/e2e-runs/${opts.runId}`
  await send(opts, `✅ 已启动 Run #${opts.runId}${scenariosText} · ▶ ${url}`)
}

export async function notifyScenarioFailed(opts: ImNotifyOptions, scenarioId: string): Promise<void> {
  await send(opts, `📊 Run #${opts.runId} · ${scenarioId} 失败 · 启动 AI 修复`)
}

export async function notifyBugfixComplete(opts: ImNotifyOptions, scenarioId: string): Promise<void> {
  await send(opts, `🔧 Run #${opts.runId} · ${scenarioId} 已修复，重新部署沙盒并重试中`)
}

export async function notifyRunPassed(opts: ImNotifyOptions, fixedCount: number, mrUrl: string | null): Promise<void> {
  const fixText = fixedCount > 0 ? ` · 共修复 ${fixedCount} 个 bug` : ''
  const mrText = mrUrl ? `\n   汇总 MR ▶ ${mrUrl}` : ''
  await send(opts, `✅ Run #${opts.runId} PASSED · 沙盒已销毁${fixText}${mrText}`)
}

export async function notifyRunFailed(opts: ImNotifyOptions, reason: string): Promise<void> {
  await send(opts, `❌ Run #${opts.runId} FAILED · ${reason}`)
}

export async function notifyRunAborted(opts: ImNotifyOptions, reason: string): Promise<void> {
  await send(opts, `❌ Run #${opts.runId} 已中止 · ${reason}`)
}

export async function notifyGovernorUnfixable(opts: ImNotifyOptions, scenarioId: string): Promise<void> {
  await send(opts, `⚠️ Run #${opts.runId} · ${scenarioId} 无法修复（已重试 3 次），继续其他场景`)
}
