import { readFile, readdir, writeFile, stat, mkdir } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join, basename } from 'path'
import archiver from 'archiver'
import type { StageResult } from '../db/repositories/test-runs.js'

interface ReportData {
  runId: number
  pipelineName: string
  triggerType: string
  triggeredBy: string
  triggeredByName?: string
  triggeredByAvatar?: string
  status: string
  servers: Record<string, string[]>
  startedAt: string
  finishedAt: string
  stageResults: StageResult[]
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function parseJunitXml(xml: string): { total: number; passed: number; failed: number; skipped: number; failures: { name: string; message: string }[] } {
  const total = Number(xml.match(/tests="(\d+)"/)?.[1] ?? 0)
  const failed = Number(xml.match(/failures="(\d+)"/)?.[1] ?? 0)
  const errors = Number(xml.match(/errors="(\d+)"/)?.[1] ?? 0)
  const skipped = Number(xml.match(/skipped="(\d+)"/)?.[1] ?? 0)
  const passed = total - failed - errors - skipped

  const failures: { name: string; message: string }[] = []
  const failureRegex = /<testcase[^>]*name="([^"]*)"[^>]*>[\s\S]*?<failure[^>]*message="([^"]*)"[\s\S]*?<\/testcase>/g
  let match
  while ((match = failureRegex.exec(xml)) !== null) {
    failures.push({ name: match[1], message: match[2] })
  }
  return { total, passed, failed: failed + errors, skipped, failures }
}

export async function generateHtmlReport(data: ReportData, logDir: string): Promise<string> {
  // Try to parse JUnit XML if available
  let junitHtml = ''
  try {
    const resultsDir = join(logDir, 'test-results')
    const files = await readdir(resultsDir).catch(() => [] as string[])
    const xmlFile = files.find(f => f.endsWith('.xml'))
    if (xmlFile) {
      const xml = await readFile(join(resultsDir, xmlFile), 'utf8')
      const junit = parseJunitXml(xml)
      junitHtml = `
        <div class="section">
          <h2>测试结果</h2>
          <div class="stats">
            <div class="stat"><span class="stat-num">${junit.total}</span><span class="stat-label">总计</span></div>
            <div class="stat success"><span class="stat-num">${junit.passed}</span><span class="stat-label">通过</span></div>
            <div class="stat ${junit.failed > 0 ? 'failed' : ''}"><span class="stat-num">${junit.failed}</span><span class="stat-label">失败</span></div>
            <div class="stat"><span class="stat-num">${junit.skipped}</span><span class="stat-label">跳过</span></div>
          </div>
          ${junit.failures.length > 0 ? `
            <h3>失败用例</h3>
            <table><tr><th>用例名称</th><th>错误信息</th></tr>
            ${junit.failures.map(f => `<tr><td>${escapeHtml(f.name)}</td><td class="error">${escapeHtml(f.message)}</td></tr>`).join('')}
            </table>
          ` : ''}
        </div>`
    }
  } catch { /* no junit results */ }

  // Read stage logs
  let stageLogsHtml = ''
  for (const sr of data.stageResults) {
    const logFileName = `${String(data.stageResults.indexOf(sr) + 1).padStart(2, '0')}-${sr.type}.log`
    let logContent = ''
    try {
      logContent = await readFile(join(logDir, logFileName), 'utf8')
    } catch { /* no log file */ }
    const statusClass = sr.status === 'success' ? 'success' : sr.status === 'failed' ? 'failed' : ''
    stageLogsHtml += `
      <div class="stage">
        <div class="stage-header">
          <span class="stage-name">${escapeHtml(sr.name)}</span>
          <span class="badge ${statusClass}">${sr.status}</span>
          ${sr.durationMs ? `<span class="duration">${formatDuration(sr.durationMs)}</span>` : ''}
        </div>
        ${sr.error ? `<div class="error">Error: ${escapeHtml(sr.error)}</div>` : ''}
        ${sr.aiAnalysis ? `<div style="background:#f0f5ff;border:1px solid #adc6ff;border-radius:4px;padding:8px 12px;margin-top:6px;font-size:12px"><strong>🤖 AI 分析：</strong><div style="white-space:pre-wrap;margin-top:4px">${escapeHtml(sr.aiAnalysis)}</div></div>` : ''}
        ${logContent ? `<details><summary>查看日志</summary><pre>${escapeHtml(logContent)}</pre></details>` : ''}
      </div>`
  }

  const totalDuration = data.finishedAt && data.startedAt
    ? formatDuration(new Date(data.finishedAt).getTime() - new Date(data.startedAt).getTime())
    : '-'

  const statusClass = data.status === 'success' ? 'success' : data.status === 'failed' ? 'failed' : ''

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>测试报告 #${data.runId}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#f5f5f5; color:#333; padding:24px; }
  .container { max-width:960px; margin:0 auto; }
  .header { background:#fff; border-radius:8px; padding:24px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,.1); }
  .header h1 { font-size:20px; margin-bottom:12px; }
  .header .download-btn { float:right; background:#1890ff; color:#fff; padding:8px 16px; border-radius:4px; text-decoration:none; font-size:14px; }
  .header .download-btn:hover { background:#40a9ff; }
  .meta { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; font-size:14px; color:#666; }
  .meta span { display:block; }
  .meta strong { color:#333; }
  .section { background:#fff; border-radius:8px; padding:24px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,.1); }
  .section h2 { font-size:16px; margin-bottom:16px; border-bottom:1px solid #f0f0f0; padding-bottom:8px; }
  .stats { display:flex; gap:24px; margin-bottom:16px; }
  .stat { text-align:center; }
  .stat-num { display:block; font-size:28px; font-weight:bold; }
  .stat-label { font-size:12px; color:#999; }
  .stat.success .stat-num { color:#52c41a; }
  .stat.failed .stat-num { color:#ff4d4f; }
  .badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:12px; font-weight:500; }
  .badge.success { background:#f6ffed; color:#52c41a; border:1px solid #b7eb8f; }
  .badge.failed { background:#fff2f0; color:#ff4d4f; border:1px solid #ffa39e; }
  .stage { border:1px solid #f0f0f0; border-radius:6px; padding:12px; margin-bottom:8px; }
  .stage-header { display:flex; align-items:center; gap:12px; }
  .stage-name { font-weight:500; }
  .duration { font-size:12px; color:#999; }
  .error { color:#ff4d4f; font-size:13px; margin-top:4px; }
  details { margin-top:8px; }
  summary { cursor:pointer; font-size:13px; color:#1890ff; }
  pre { background:#f5f5f5; padding:12px; border-radius:4px; overflow-x:auto; font-size:12px; max-height:400px; overflow-y:auto; margin-top:8px; white-space:pre-wrap; word-break:break-all; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { padding:8px 12px; text-align:left; border-bottom:1px solid #f0f0f0; }
  th { background:#fafafa; font-weight:500; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <a href="/api/test-runs/${data.runId}/report/download" class="download-btn">下载完整数据包</a>
    <h1>测试报告 #${data.runId}</h1>
    <div class="meta">
      <span><strong>状态:</strong> <span class="badge ${statusClass}">${data.status}</span></span>
      <span><strong>触发方式:</strong> ${data.triggerType}</span>
      <span><strong>触发人:</strong> ${data.triggeredByAvatar ? `<img src="${escapeHtml(data.triggeredByAvatar)}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:4px">` : ''}${escapeHtml(data.triggeredByName || data.triggeredBy || '-')}</span>
      <span><strong>开始时间:</strong> ${data.startedAt ? new Date(data.startedAt).toLocaleString('zh-CN') : '-'}</span>
      <span><strong>结束时间:</strong> ${data.finishedAt ? new Date(data.finishedAt).toLocaleString('zh-CN') : '-'}</span>
      <span><strong>总耗时:</strong> ${totalDuration}</span>
    </div>
  </div>

  <div class="section">
    <h2>服务器</h2>
    <table><tr><th>角色</th><th>服务器</th></tr>
    ${Object.entries(data.servers).map(([role, hosts]) => `<tr><td>${escapeHtml(role)}</td><td>${(hosts as string[]).join(', ')}</td></tr>`).join('')}
    </table>
  </div>

  ${junitHtml}

  <div class="section">
    <h2>执行阶段</h2>
    ${stageLogsHtml}
  </div>
</div>
</body></html>`

  const reportPath = join(logDir, 'report.html')
  await mkdir(logDir, { recursive: true })
  await writeFile(reportPath, html, 'utf8')
  return reportPath
}

export async function generateZipArchive(runId: number, logDir: string): Promise<string> {
  const zipPath = join(logDir, `test-run-${runId}.zip`)

  return new Promise(async (resolve, reject) => {
    const output = createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', () => resolve(zipPath))
    archive.on('error', reject)
    archive.pipe(output)

    // Add report.html
    try { archive.file(join(logDir, 'report.html'), { name: 'report.html' }) } catch { /* skip */ }

    // Add stage logs
    try {
      const files = await readdir(logDir)
      for (const f of files) {
        if (f.endsWith('.log')) {
          archive.file(join(logDir, f), { name: `stages/${f}` })
        }
      }
    } catch { /* skip */ }

    // Add test-results directory
    const resultsDir = join(logDir, 'test-results')
    try {
      const s = await stat(resultsDir)
      if (s.isDirectory()) {
        archive.directory(resultsDir, 'test-results')
      }
    } catch { /* skip */ }

    // Add configs directory
    const configsDir = join(logDir, 'configs')
    try {
      const s = await stat(configsDir)
      if (s.isDirectory()) {
        archive.directory(configsDir, 'configs')
      }
    } catch { /* skip */ }

    await archive.finalize()
  })
}
