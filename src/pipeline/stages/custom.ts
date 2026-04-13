import { sshExecWithLog } from '../ssh.js'
import type { CustomParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'

export async function executeCustom(params: CustomParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-custom.log`)
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    try {
      const result = await sshExecWithLog(sshCfg, params.command, logFile)
      if (result.code !== 0) {
        return { status: 'failed', output: `Custom command failed on ${server.host}`, error: `exit code ${result.code}` }
      }
      outputs.push(`${server.host}: ok`)
    } catch (err) {
      return { status: 'failed', output: `Custom command error on ${server.host}`, error: String(err) }
    }
  }
  return { status: 'success', output: outputs.join('\n') }
}
