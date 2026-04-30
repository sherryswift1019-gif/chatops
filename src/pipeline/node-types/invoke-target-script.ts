import { spawn } from 'child_process'
import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'

registerNodeType({
  key: 'invoke_target_script',
  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const scriptPath = params.scriptPath as string | undefined
    if (!scriptPath) {
      return { status: 'failed', output: {}, error: 'invoke_target_script: scriptPath is required' }
    }
    const args = (params.args as string[]) ?? []
    const env = params.env as Record<string, string> | undefined
    const timeoutSeconds = (params.timeoutSeconds as number | undefined) ?? 300
    const workingDir = params.workingDir as string | undefined

    return new Promise((resolve) => {
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let timedOut = false
      let settled = false

      const child = spawn(scriptPath, args, {
        env: { ...process.env, ...env },
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* already dead */ }
        }, 5000)
      }, timeoutSeconds * 1000)

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const stdoutStr = Buffer.concat(stdout).toString('utf8')
        const stderrStr = Buffer.concat(stderr).toString('utf8')
        const exitCode = timedOut ? -2 : (code ?? -1)

        const parsed = parseLastJsonLine(stdoutStr)

        if (exitCode !== 0) {
          return resolve({
            status: 'failed',
            output: { exitCode, stdout: stdoutStr, stderr: stderrStr, parsed },
            error: timedOut
              ? `Script timed out after ${timeoutSeconds}s`
              : `Script exited with code ${exitCode}`,
          })
        }
        resolve({ status: 'success', output: { exitCode: 0, stdout: stdoutStr, stderr: stderrStr, parsed } })
      })

      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: 'failed', output: { exitCode: -1, stdout: '', stderr: err.message, parsed: null }, error: err.message })
      })
    })
  },
})

function parseLastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('{')) {
      try { return JSON.parse(line) } catch { /* skip */ }
    }
  }
  return null
}
