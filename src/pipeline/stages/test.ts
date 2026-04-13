import { sshExecWithLog, scpDownload } from '../ssh.js'
import type { TestParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'
import { mkdir } from 'fs/promises'

export async function executeTest(params: TestParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-test.log`)
  const server = servers[0]
  if (!server) return { status: 'failed', output: 'No test server assigned', error: 'missing server' }

  const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }

  try {
    // Clone test repo
    const cloneCmd = [
      `rm -rf ${params.workDir}`,
      `git clone --branch ${params.branch} --depth 1 '${params.gitRepo}' ${params.workDir}`,
    ].join(' && ')
    const cloneResult = await sshExecWithLog(sshCfg, cloneCmd, logFile, 120000)
    if (cloneResult.code !== 0) {
      return { status: 'failed', output: 'Failed to clone test repo', error: `exit code ${cloneResult.code}` }
    }

    // Install Python dependencies if requirements.txt exists
    const depsCmd = `cd ${params.workDir} && [ -f requirements.txt ] && pip install -r requirements.txt || true`
    await sshExecWithLog(sshCfg, depsCmd, logFile, 300000)

    // Execute pytest
    const testCmd = `cd ${params.workDir} && ${params.command}`
    const testResult = await sshExecWithLog(sshCfg, testCmd, logFile, 600000)

    // Collect artifacts via SCP
    const artifactDir = join(ctx.logDir, 'test-results')
    await mkdir(artifactDir, { recursive: true })
    const collectedArtifacts: string[] = []
    for (const artifact of params.collectArtifacts) {
      const remotePath = `${params.workDir}/${artifact}`
      const localPath = join(artifactDir, artifact.replace(/\//g, '_'))
      try {
        await scpDownload(sshCfg, remotePath, localPath)
        collectedArtifacts.push(localPath)
      } catch {
        // Artifact might not exist if tests crashed
      }
    }

    const status = testResult.code === 0 ? 'success' : 'failed'
    return { status, output: `Tests completed with exit code ${testResult.code}`, artifacts: collectedArtifacts }
  } catch (err) {
    return { status: 'failed', output: 'Test execution error', error: String(err) }
  }
}
