import { spawn } from 'child_process'

interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

function spawnAsync(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }))
    proc.on('error', reject)
  })
}

export class DockerExecutor {
  private containerName = ''
  private ready = false

  constructor(private readonly image: string) {}

  /** Pull image and start a detached container that stays alive via `sleep infinity`. */
  async setup(containerName: string): Promise<void> {
    this.containerName = containerName

    const pull = await spawnAsync('docker', ['pull', this.image])
    if (pull.exitCode !== 0) {
      throw new Error(`Failed to pull image ${this.image}: ${pull.stderr.trim()}`)
    }

    const run = await spawnAsync('docker', [
      'run', '-d',
      '--name', this.containerName,
      '-w', '/workspace',
      this.image,
      'sleep', 'infinity',
    ])
    if (run.exitCode !== 0) {
      throw new Error(`Failed to start container ${this.containerName}: ${run.stderr.trim()}`)
    }

    this.ready = true
  }

  /** Execute a shell command inside the running container. */
  async exec(command: string): Promise<ExecResult> {
    if (!this.ready) throw new Error('DockerExecutor.setup() has not been called')
    return spawnAsync('docker', ['exec', this.containerName, 'sh', '-c', command])
  }

  /** Force-remove the container. Safe to call even if container does not exist. */
  async teardown(): Promise<void> {
    if (!this.containerName) return
    await spawnAsync('docker', ['rm', '-f', this.containerName]).catch(() => {})
    this.ready = false
  }
}
