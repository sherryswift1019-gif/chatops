import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver } from '@langchain/langgraph'
import {
  buildGraphFromPipeline,
  type StageHooks,
} from '../../pipeline/graph-builder.js'
import type {
  StageDefinition,
  StageContext,
  StageExecutionResult,
  ServerInfo,
  ServerExecutionDetail,
  PipelineGraph,
} from '../../pipeline/types.js'
import type { DockerExecutor } from '../../pipeline/executors/docker.js'

/**
 * Down-stream coverage for buildScriptNode → state.stepOutputs[<id>].
 *
 * Pre-fix: buildScriptNode 只 return { currentStageIndex, stageResults }，
 * 下游 capability 节点用 `{{steps.<script_id>.output.stderr}}` 拿到 undefined，
 * 整值匹配未命中保留字面 `{{...}}`，LLM 拿到字面占位符直接拒绝（PAM Proxy
 * 诊断修复 capability 失败的实际症状）。
 *
 * 这个文件锁定 buildScriptNode 完成后必须写入的 stepOutput 形状：
 *   { status, output: { host, port, role, stdout, stderr, exitCode, success, servers: [...] } }
 *
 * 顶层快捷字段语义（PAM Proxy 诊断修复用例）：
 *   - 单 server：第一台
 *   - 多 server 全成功：第一台 success
 *   - 多 server 含失败：第一台失败的 server
 */

function makeStage(
  partial: Partial<StageDefinition> & Pick<StageDefinition, 'name' | 'stageType'>,
): StageDefinition {
  return {
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    ...partial,
  }
}

const sshServer1: ServerInfo = {
  id: 1,
  host: '10.0.0.1',
  port: 22,
  username: 'ops',
  password: 'x',
  role: 'app',
}

const sshServer2: ServerInfo = {
  id: 2,
  host: '10.0.0.2',
  port: 22,
  username: 'ops',
  password: 'x',
  role: 'app',
}

function singleScriptGraph(stageId = 'install'): PipelineGraph {
  return {
    nodes: [
      {
        ...makeStage({ name: 'install', stageType: 'script', targetRoles: ['app'] }),
        id: stageId,
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  }
}

function singleDockerScriptGraph(stageId = 'install'): PipelineGraph {
  return {
    nodes: [
      {
        ...makeStage({
          name: 'install',
          stageType: 'script',
          script: 'echo hi',
          // no targetRoles → Docker path
        }),
        id: stageId,
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  }
}

async function runOnce(
  graph: PipelineGraph,
  hooks: StageHooks,
  stageContext: Parameters<typeof buildGraphFromPipeline>[0]['stageContext'],
  triggerParams?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const builder = buildGraphFromPipeline({ graph, stageContext, hooks, triggerParams })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = (builder as any).compile({ checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: randomUUID() } }
  let last: Record<string, unknown> = {}
  for await (const chunk of await app.stream({ runId: 42 }, config)) {
    last = chunk as Record<string, unknown>
  }
  // The final graph state is the last chunk's combined value; instead of
  // hunting through superstep chunks, fetch the persisted state.
  const finalState = await app.getState(config)
  return finalState.values as Record<string, unknown>
}

describe('buildScriptNode stepOutput — SSH path, single server success', () => {
  it('writes stepOutputs[<id>] with structured host/stdout/stderr/exitCode/success/role + servers[]', async () => {
    const graph = singleScriptGraph('install')

    const hooks: StageHooks = {
      async runScript(_stage, _ctx, servers): Promise<StageExecutionResult> {
        const detail: ServerExecutionDetail = {
          host: servers[0].host,
          port: servers[0].port,
          role: servers[0].role,
          stdout: 'install ok\nv1.2.3 ready',
          stderr: '',
          exitCode: 0,
          success: true,
        }
        return {
          status: 'success',
          output: '=== 10.0.0.1 ===\n[stdout]\ninstall ok',
          servers: [detail],
        }
      },
    }

    const finalState = await runOnce(
      graph,
      hooks,
      { runId: 42, servers: { app: [sshServer1] }, logDir: '/tmp/chatops-test' },
    )

    const stepOutputs = finalState.stepOutputs as Record<
      string,
      { status: string; output: Record<string, unknown> }
    >
    expect(stepOutputs).toBeDefined()
    expect(stepOutputs.install).toBeDefined()
    expect(stepOutputs.install.status).toBe('success')

    const out = stepOutputs.install.output
    // Top-level shortcut fields mirror servers[0] (single-server case)
    expect(out.host).toBe('10.0.0.1')
    expect(out.port).toBe(22)
    expect(out.role).toBe('app')
    expect(out.stdout).toBe('install ok\nv1.2.3 ready')
    expect(out.stderr).toBe('')
    expect(out.exitCode).toBe(0)
    expect(out.success).toBe(true)

    // servers array has the same single record
    expect(Array.isArray(out.servers)).toBe(true)
    const serversArr = out.servers as ServerExecutionDetail[]
    expect(serversArr).toHaveLength(1)
    expect(serversArr[0].host).toBe('10.0.0.1')
    expect(serversArr[0].stdout).toBe('install ok\nv1.2.3 ready')
    expect(serversArr[0].success).toBe(true)
  })
})

describe('buildScriptNode stepOutput — SSH path, single server failure', () => {
  it('exitCode != 0 → success=false, stepOutput.status="failed"', async () => {
    const graph = singleScriptGraph('install')

    const hooks: StageHooks = {
      async runScript(_stage, _ctx, servers): Promise<StageExecutionResult> {
        const detail: ServerExecutionDetail = {
          host: servers[0].host,
          port: servers[0].port,
          role: servers[0].role,
          stdout: 'partial output',
          stderr: 'fatal: cannot bind port 8080',
          exitCode: 1,
          success: false,
        }
        return {
          status: 'failed',
          output: 'fail log',
          error: `exit code 1 on ${servers[0].host}`,
          servers: [detail],
        }
      },
    }

    const finalState = await runOnce(
      graph,
      hooks,
      { runId: 42, servers: { app: [sshServer1] }, logDir: '/tmp/chatops-test' },
    )

    const stepOutputs = finalState.stepOutputs as Record<
      string,
      { status: string; output: Record<string, unknown> }
    >
    expect(stepOutputs.install.status).toBe('failed')
    const out = stepOutputs.install.output
    expect(out.success).toBe(false)
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toBe('fatal: cannot bind port 8080')
  })
})

describe('buildScriptNode stepOutput — SSH path, timeout/connect error', () => {
  it('SSH error (timeout/refused) → exitCode=-1, success=false, error string set', async () => {
    const graph = singleScriptGraph('install')

    const hooks: StageHooks = {
      async runScript(_stage, _ctx, servers): Promise<StageExecutionResult> {
        const detail: ServerExecutionDetail = {
          host: servers[0].host,
          port: servers[0].port,
          role: servers[0].role,
          stdout: '',
          stderr: '',
          exitCode: -1,
          success: false,
          error: 'Error: SSH command timed out after 300000ms',
        }
        return {
          status: 'failed',
          output: 'timeout',
          error: 'Error: SSH command timed out after 300000ms',
          servers: [detail],
        }
      },
    }

    const finalState = await runOnce(
      graph,
      hooks,
      { runId: 42, servers: { app: [sshServer1] }, logDir: '/tmp/chatops-test' },
    )

    const stepOutputs = finalState.stepOutputs as Record<
      string,
      { status: string; output: Record<string, unknown> }
    >
    const out = stepOutputs.install.output
    expect(out.exitCode).toBe(-1)
    expect(out.success).toBe(false)
    const serversArr = out.servers as ServerExecutionDetail[]
    expect(serversArr[0].error).toMatch(/timed out/)
  })
})

describe('buildScriptNode stepOutput — SSH path, multi-server all success', () => {
  it('top-level shortcuts mirror first server', async () => {
    const graph = singleScriptGraph('install')

    const hooks: StageHooks = {
      async runScript(_stage, _ctx, servers): Promise<StageExecutionResult> {
        const details: ServerExecutionDetail[] = servers.map((s) => ({
          host: s.host,
          port: s.port,
          role: s.role,
          stdout: `ok on ${s.host}`,
          stderr: '',
          exitCode: 0,
          success: true,
        }))
        return {
          status: 'success',
          output: details.map((d) => `=== ${d.host} ===\n${d.stdout}`).join('\n'),
          servers: details,
        }
      },
    }

    const finalState = await runOnce(
      graph,
      hooks,
      { runId: 42, servers: { app: [sshServer1, sshServer2] }, logDir: '/tmp/chatops-test' },
    )

    const stepOutputs = finalState.stepOutputs as Record<
      string,
      { status: string; output: Record<string, unknown> }
    >
    const out = stepOutputs.install.output
    // top-level = first server (10.0.0.1)
    expect(out.host).toBe('10.0.0.1')
    expect(out.stdout).toBe('ok on 10.0.0.1')
    expect(out.success).toBe(true)

    const serversArr = out.servers as ServerExecutionDetail[]
    expect(serversArr).toHaveLength(2)
    expect(serversArr.map((s) => s.host)).toEqual(['10.0.0.1', '10.0.0.2'])
  })
})

describe('buildScriptNode stepOutput — SSH path, multi-server first-failure picked', () => {
  it('top-level shortcuts mirror the FIRST FAILED server (PAM Proxy 诊断修复用例)', async () => {
    const graph = singleScriptGraph('install')

    const hooks: StageHooks = {
      async runScript(_stage, _ctx, servers): Promise<StageExecutionResult> {
        // Server 1 succeeds, server 2 fails. Top-level should reflect server 2.
        const details: ServerExecutionDetail[] = [
          {
            host: servers[0].host,
            port: servers[0].port,
            role: servers[0].role,
            stdout: 'ok on s1',
            stderr: '',
            exitCode: 0,
            success: true,
          },
          {
            host: servers[1].host,
            port: servers[1].port,
            role: servers[1].role,
            stdout: 'partial',
            stderr: 'fatal: bind failed',
            exitCode: 1,
            success: false,
          },
        ]
        return {
          status: 'failed',
          output: 'mixed log',
          error: `exit code 1 on ${servers[1].host}`,
          servers: details,
        }
      },
    }

    const finalState = await runOnce(
      graph,
      hooks,
      { runId: 42, servers: { app: [sshServer1, sshServer2] }, logDir: '/tmp/chatops-test' },
    )

    const stepOutputs = finalState.stepOutputs as Record<
      string,
      { status: string; output: Record<string, unknown> }
    >
    expect(stepOutputs.install.status).toBe('failed')
    const out = stepOutputs.install.output
    // top-level = first FAILED server (10.0.0.2)
    expect(out.host).toBe('10.0.0.2')
    expect(out.stdout).toBe('partial')
    expect(out.stderr).toBe('fatal: bind failed')
    expect(out.exitCode).toBe(1)
    expect(out.success).toBe(false)

    const serversArr = out.servers as ServerExecutionDetail[]
    expect(serversArr).toHaveLength(2)
    expect(serversArr[0].success).toBe(true)
    expect(serversArr[1].success).toBe(false)
  })
})

describe('buildScriptNode stepOutput — Docker path', () => {
  it('servers[0] virtual entry: host="", role="docker"; top-level mirrors it', async () => {
    const graph = singleDockerScriptGraph('install')

    const dockerExec = {
      async exec(_command: string) {
        return { stdout: 'docker hi', stderr: '', exitCode: 0 }
      },
    }

    // hooks.runScript not used in Docker path — no targetRoles
    const hooks: StageHooks = {
      async runScript(): Promise<StageExecutionResult> {
        return { status: 'failed', output: 'should-not-be-called' }
      },
    }

    const finalState = await runOnce(
      graph,
      hooks,
      {
        runId: 42,
        servers: {},
        logDir: '/tmp/chatops-test',
        dockerExecutor: dockerExec as unknown as DockerExecutor,
      },
    )

    const stepOutputs = finalState.stepOutputs as Record<
      string,
      { status: string; output: Record<string, unknown> }
    >
    expect(stepOutputs.install).toBeDefined()
    expect(stepOutputs.install.status).toBe('success')

    const out = stepOutputs.install.output
    expect(out.host).toBe('')
    expect(out.role).toBe('docker')
    expect(out.stdout).toBe('docker hi')
    expect(out.stderr).toBe('')
    expect(out.exitCode).toBe(0)
    expect(out.success).toBe(true)

    const serversArr = out.servers as ServerExecutionDetail[]
    expect(serversArr).toHaveLength(1)
    expect(serversArr[0].host).toBe('')
    expect(serversArr[0].role).toBe('docker')
    expect(serversArr[0].port).toBe(0)
  })

  it('Docker path, exitCode != 0 → success=false, status=failed', async () => {
    const graph = singleDockerScriptGraph('install')

    const dockerExec = {
      async exec(_command: string) {
        return { stdout: 'partial', stderr: 'oops', exitCode: 2 }
      },
    }
    const hooks: StageHooks = {
      async runScript(): Promise<StageExecutionResult> {
        return { status: 'failed', output: 'should-not-be-called' }
      },
    }

    const finalState = await runOnce(
      graph,
      hooks,
      {
        runId: 42,
        servers: {},
        logDir: '/tmp/chatops-test',
        dockerExecutor: dockerExec as unknown as DockerExecutor,
      },
    )

    const stepOutputs = finalState.stepOutputs as Record<
      string,
      { status: string; output: Record<string, unknown> }
    >
    expect(stepOutputs.install.status).toBe('failed')
    const out = stepOutputs.install.output
    expect(out.exitCode).toBe(2)
    expect(out.success).toBe(false)
    expect(out.stderr).toBe('oops')
  })
})
