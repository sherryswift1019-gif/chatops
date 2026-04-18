import { Client } from 'ssh2'
import type { SSHTarget } from '../ssh-utils.js'
import { findDeployedTag, type DeployedTag } from './tag-parser.js'

export interface ContainerStatus {
  exists: boolean
  state?: 'running' | 'exited' | 'restarting' | 'paused' | 'created' | 'dead' | 'removing'
  startedAt?: string
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none'
  exitCode?: number
}

export interface DockerProbeResult {
  container: ContainerStatus
  deployed: DeployedTag | null
  error?: string
}

function sshExec(target: SSHTarget, command: string, timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { conn.end(); reject(new Error('ssh exec timeout')) }, timeoutMs)
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err) }
        stream.on('close', (code: number) => {
          clearTimeout(timer); conn.end()
          resolve({ stdout, stderr, code: code ?? 0 })
        })
        stream.on('data', (d: Buffer) => { stdout += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      })
    })
    conn.on('error', (e) => { clearTimeout(timer); conn.end(); reject(e) })
    conn.connect({
      host: target.host, port: target.port, username: target.username, password: target.password,
      readyTimeout: 10000,
    })
  })
}

const SEP = '---CHATOPS-SEP---'

export async function probeContainer(
  target: SSHTarget,
  containerName: string,
  registryHost: string,
  harborProject: string,
): Promise<DockerProbeResult> {
  const cmd = [
    `timeout 15 docker inspect ${containerName} 2>/dev/null || echo '[]'`,
    `echo '${SEP}'`,
    `IMG=$(timeout 5 docker inspect --format '{{.Image}}' ${containerName} 2>/dev/null)`,
    `if [ -n "$IMG" ]; then timeout 15 docker image inspect "$IMG" 2>/dev/null || echo '[]'; else echo '[]'; fi`,
  ].join('; ')

  try {
    const result = await sshExec(target, cmd)
    const [containerPart, imagePart] = result.stdout.split(SEP).map(s => s.trim())

    const containerArr = JSON.parse(containerPart || '[]') as Array<Record<string, unknown>>
    if (containerArr.length === 0) {
      return { container: { exists: false }, deployed: null }
    }
    const c = containerArr[0] as {
      State?: { Status?: string; StartedAt?: string; ExitCode?: number; Health?: { Status?: string } }
    }
    const state = (c.State?.Status ?? 'dead') as ContainerStatus['state']
    const health = (c.State?.Health?.Status ?? 'none') as ContainerStatus['health']

    const container: ContainerStatus = {
      exists: true,
      state,
      startedAt: c.State?.StartedAt,
      health,
      exitCode: c.State?.ExitCode,
    }

    const imageArr = JSON.parse(imagePart || '[]') as Array<{ RepoTags?: string[] }>
    const repoTags = imageArr[0]?.RepoTags ?? []
    const deployed = findDeployedTag(repoTags, registryHost, harborProject)

    return { container, deployed }
  } catch (err) {
    return {
      container: { exists: false },
      deployed: null,
      error: `ssh: ${String(err)}`,
    }
  }
}
