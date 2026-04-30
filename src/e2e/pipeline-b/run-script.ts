// src/e2e/pipeline-b/run-script.ts
import { spawn } from 'child_process'

export interface RunScriptResult {
  exitCode: number
  stdout: string
  stderr: string
  parsed: Record<string, unknown> | null
}

export function parseLastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('{')) {
      try { return JSON.parse(line) } catch { /* skip */ }
    }
  }
  return null
}

export async function runScript(
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: Record<string, string>; cwd?: string } = {},
): Promise<RunScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    let settled = false
    const timer = opts.timeout
      ? setTimeout(() => {
          if (!settled) {
            settled = true
            child.kill('SIGTERM')
            setTimeout(() => child.kill('SIGKILL'), 3000)
            resolve({ exitCode: -1, stdout, stderr: stderr + '\n[timeout]', parsed: null })
          }
        }, opts.timeout)
      : null

    child.on('error', (err) => {
      if (!settled) {
        settled = true
        if (timer) clearTimeout(timer)
        reject(err)
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        if (timer) clearTimeout(timer)
        const exitCode = code ?? -1
        resolve({ exitCode, stdout, stderr, parsed: parseLastJsonLine(stdout) })
      }
    })
  })
}
