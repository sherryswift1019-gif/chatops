import { sshExec } from '../ssh.js'
import type { HealthCheckParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { appendFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export async function executeHealthCheck(params: HealthCheckParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-health-check.log`)
  await mkdir(dirname(logFile), { recursive: true })
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    let lastError = ''
    let passed = false

    for (let attempt = 0; attempt < params.maxRetries; attempt++) {
      try {
        let cmd: string
        if (params.checkType === 'http') {
          cmd = `curl -sf -o /dev/null -w '%{http_code}' '${params.target}'`
        } else if (params.checkType === 'tcp') {
          const [host, port] = params.target.split(':')
          cmd = `bash -c 'echo > /dev/tcp/${host}/${port}' 2>/dev/null`
        } else {
          cmd = params.target
        }
        const result = await sshExec(sshCfg, cmd, 10000)
        await appendFile(logFile, `[${server.host}] attempt ${attempt + 1}: code=${result.code} stdout=${result.stdout.trim()}\n`)
        if (result.code === 0) { passed = true; break }
        lastError = result.stderr || result.stdout
      } catch (err) {
        lastError = String(err)
        await appendFile(logFile, `[${server.host}] attempt ${attempt + 1}: error=${lastError}\n`)
      }
      if (attempt < params.maxRetries - 1) await sleep(params.intervalSeconds * 1000)
    }

    if (!passed) {
      return { status: 'failed', output: `Health check failed on ${server.host} after ${params.maxRetries} attempts`, error: lastError }
    }
    outputs.push(`${server.host}: healthy`)
  }
  return { status: 'success', output: outputs.join('\n') }
}
