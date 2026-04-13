import { sshExecWithLog, sshExec } from '../ssh.js'
import type { InstallParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'

function resolveVariables(value: string, servers: Record<string, ServerInfo[]>): string {
  return value.replace(/\{\{servers\.(\w+)\[(\d+)\]\.(\w+)\}\}/g, (_match, role, index, field) => {
    const list = servers[role]
    if (!list || !list[Number(index)]) return _match
    const srv = list[Number(index)] as unknown as Record<string, unknown>
    return String(srv[field] ?? _match)
  })
}

function generateConfigContent(configValues: Record<string, string>, servers: Record<string, ServerInfo[]>): string {
  return Object.entries(configValues)
    .map(([key, val]) => `${key}=${resolveVariables(val, servers)}`)
    .join('\n')
}

export async function executeInstall(params: InstallParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-install.log`)
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    try {
      const configContent = generateConfigContent(params.configValues, ctx.servers)
      const configPath = `${params.workDir}/${params.configFile}`
      await sshExec(sshCfg, `mkdir -p ${params.workDir} && cat > ${configPath} << 'CHATOPS_EOF'\n${configContent}\nCHATOPS_EOF`)

      const cmd = `cd ${params.workDir} && ${params.script} ${params.silentFlag}`
      const result = await sshExecWithLog(sshCfg, cmd, logFile, 600000)
      if (result.code !== 0) {
        return { status: 'failed', output: `Install failed on ${server.host}`, error: `exit code ${result.code}` }
      }
      outputs.push(`${server.host}: install ok`)
    } catch (err) {
      return { status: 'failed', output: `Install error on ${server.host}`, error: String(err) }
    }
  }
  return { status: 'success', output: outputs.join('\n') }
}
