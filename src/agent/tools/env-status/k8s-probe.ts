// SSH exec helper duplicated from docker-probe.ts — that file is the source of truth.
import { Client } from 'ssh2'
import type { SSHTarget } from '../ssh-utils.js'

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

export interface K8sDeploymentStatus {
  ready: number
  replicas: number
  image: string   // the raw image string, e.g. "harbor.example.com/proj/svc:develop_abc"
  error?: string
}

export async function probeK8sDeployment(
  target: SSHTarget,
  deploymentName: string,
  namespace: string,
): Promise<K8sDeploymentStatus> {
  const cmd = `timeout 15 kubectl get deployment ${deploymentName} -n ${namespace} -o json 2>/dev/null || echo '{}'`

  try {
    const result = await sshExec(target, cmd)
    const raw = result.stdout.trim()

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw || '{}') as Record<string, unknown>
    } catch {
      return { ready: 0, replicas: 0, image: '', error: 'not found' }
    }

    // Empty object or missing required fields
    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
      return { ready: 0, replicas: 0, image: '', error: 'not found' }
    }

    const status = parsed.status as Record<string, unknown> | undefined
    const spec = parsed.spec as Record<string, unknown> | undefined

    const ready = (status?.readyReplicas as number | undefined) ?? 0
    const replicas = (status?.replicas as number | undefined) ?? 0

    const template = (spec?.template as Record<string, unknown> | undefined)
    const podSpec = (template?.spec as Record<string, unknown> | undefined)
    const containers = (podSpec?.containers as Array<Record<string, unknown>> | undefined) ?? []
    const image = (containers[0]?.image as string | undefined) ?? ''

    return { ready, replicas, image }
  } catch (err) {
    return { ready: 0, replicas: 0, image: '', error: `ssh: ${String(err)}` }
  }
}
