import { sshExecWithLog } from '../ssh.js'
import type { DownloadParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'

export async function executeDownload(params: DownloadParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-download.log`)
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    try {
      const commands: string[] = [
        `mkdir -p ${params.destPath}`,
        `cd ${params.destPath}`,
        `curl -fSL -o package.tar.gz '${params.sourceUrl}'`,
      ]
      if (params.checksum) {
        const [algo, hash] = params.checksum.split(':')
        commands.push(`echo '${hash}  package.tar.gz' | ${algo}sum -c -`)
      }
      if (params.extract) {
        commands.push('tar xzf package.tar.gz')
      }
      const result = await sshExecWithLog(sshCfg, commands.join(' && '), logFile)
      if (result.code !== 0) {
        return { status: 'failed', output: `Download failed on ${server.host}`, error: `exit code ${result.code}` }
      }
      outputs.push(`${server.host}: download ok`)
    } catch (err) {
      return { status: 'failed', output: `Download error on ${server.host}`, error: String(err) }
    }
  }
  return { status: 'success', output: outputs.join('\n') }
}
