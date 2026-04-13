import { sshExecWithLog } from '../ssh.js'
import type { CleanupParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'

export async function executeCleanup(params: CleanupParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-cleanup.log`)
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    try {
      if (params.preCommands?.length) {
        const preCmd = params.preCommands.join(' && ')
        const pre = await sshExecWithLog(sshCfg, preCmd, logFile)
        if (pre.code !== 0) {
          return { status: 'failed', output: `Pre-command failed on ${server.host}`, error: `exit code ${pre.code}` }
        }
      }
      const args = params.args?.join(' ') ?? ''
      const cmd = `${params.script} ${args}`.trim()
      const result = await sshExecWithLog(sshCfg, cmd, logFile)
      if (result.code !== 0) {
        return { status: 'failed', output: `Cleanup failed on ${server.host}`, error: `exit code ${result.code}` }
      }
      outputs.push(`${server.host}: cleanup ok`)
    } catch (err) {
      return { status: 'failed', output: `Cleanup error on ${server.host}`, error: String(err) }
    }
  }
  return { status: 'success', output: outputs.join('\n') }
}
