import { Client } from 'ssh2'
import type { SSHTarget } from '../ssh-utils.js'
import { findDeployedTag, type DeployedTag } from './tag-parser.js'

export interface ContainerStatus {
  exists: boolean
  state?: 'running' | 'exited' | 'restarting' | 'paused' | 'created' | 'dead' | 'removing'
  startedAt?: string
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none'
  exitCode?: number
  actualName?: string
}

export interface DockerProbeResult {
  container: ContainerStatus
  deployed: DeployedTag | null
  error?: string
  composeFile?: string
  serviceName?: string
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

export function buildProbeCommand(serviceName: string, composeFile?: string): string {
  const safeServiceName = serviceName.replace(/'/g, `'\\''`)
  if (composeFile) {
    const safeComposeFile = composeFile.replace(/'/g, `'\\''`)
    return [
      `COMPOSE_FILE='${safeComposeFile}'`,
      `SERVICE_NAME='${safeServiceName}'`,
      `if [ ! -f "$COMPOSE_FILE" ]; then echo '__CHATOPS_ERROR__:compose_file_missing'; exit 12; fi`,
      `COMPOSE_CMD=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")`,
      `$COMPOSE_CMD -f "$COMPOSE_FILE" config --services 2>/dev/null | grep -Fx -- "$SERVICE_NAME" >/dev/null || { echo '__CHATOPS_ERROR__:service_not_found'; exit 13; }`,
      `CID=$($COMPOSE_CMD -f "$COMPOSE_FILE" ps -q "$SERVICE_NAME" 2>/dev/null | head -n 1)`,
      `if [ -z "$CID" ]; then CID=$($COMPOSE_CMD -f "$COMPOSE_FILE" ps -a -q "$SERVICE_NAME" 2>/dev/null | head -n 1); fi`,
      `if [ -z "$CID" ]; then echo '[]'; echo '${SEP}'; echo '[]'; exit 0; fi`,
      `timeout 15 docker inspect "$CID" 2>/dev/null || echo '[]'`,
      `echo '${SEP}'`,
      `IMG=$(timeout 5 docker inspect --format '{{.Image}}' "$CID" 2>/dev/null)`,
      `if [ -n "$IMG" ]; then timeout 15 docker image inspect "$IMG" 2>/dev/null || echo '[]'; else echo '[]'; fi`,
    ].join('; ')
  }
  return [
    `SERVICE_NAME='${safeServiceName}'`,
    `timeout 15 docker inspect "$SERVICE_NAME" 2>/dev/null || echo '[]'`,
    `echo '${SEP}'`,
    `IMG=$(timeout 5 docker inspect --format '{{.Image}}' "$SERVICE_NAME" 2>/dev/null)`,
    `if [ -n "$IMG" ]; then timeout 15 docker image inspect "$IMG" 2>/dev/null || echo '[]'; else echo '[]'; fi`,
  ].join('; ')
}

export async function probeContainer(
  target: SSHTarget,
  composeFile: string | undefined,
  serviceName: string,
  registryHost: string,
  harborProject: string,
): Promise<DockerProbeResult> {
  const cmd = buildProbeCommand(serviceName, composeFile)

  try {
    const result = await sshExec(target, cmd)
    const errorMarker = result.stdout.trim()
    if (result.code === 12 || errorMarker === '__CHATOPS_ERROR__:compose_file_missing') {
      return {
        container: { exists: false },
        deployed: null,
        error: `compose file not found: ${composeFile}`,
        composeFile,
        serviceName,
      }
    }
    if (result.code === 13 || errorMarker === '__CHATOPS_ERROR__:service_not_found') {
      return {
        container: { exists: false },
        deployed: null,
        error: `service not found in compose: ${serviceName}`,
        composeFile,
        serviceName,
      }
    }
    const [containerPart, imagePart] = result.stdout.split(SEP).map(s => s.trim())

    const containerArr = JSON.parse(containerPart || '[]') as Array<Record<string, unknown>>
    if (containerArr.length === 0) {
      return {
        container: { exists: false },
        deployed: null,
        composeFile,
        serviceName,
      }
    }
    const c = containerArr[0] as {
      Name?: string
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
      actualName: typeof c.Name === 'string' ? c.Name.replace(/^\/+/, '') : undefined,
    }

    const imageArr = JSON.parse(imagePart || '[]') as Array<{ RepoTags?: string[] }>
    const repoTags = imageArr[0]?.RepoTags ?? []
    const deployed = findDeployedTag(repoTags, registryHost, harborProject)

    return { container, deployed, composeFile, serviceName }
  } catch (err) {
    return {
      container: { exists: false },
      deployed: null,
      error: `ssh: ${String(err)}`,
      composeFile,
      serviceName,
    }
  }
}
