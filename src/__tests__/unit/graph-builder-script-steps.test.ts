import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver } from '@langchain/langgraph'
import {
  buildGraphFromStages,
  type StageHooks,
} from '../../pipeline/graph-builder.js'
import type {
  StageDefinition,
  StageContext,
  StageExecutionResult,
  ServerInfo,
} from '../../pipeline/types.js'
import type { DockerExecutor } from '../../pipeline/executors/docker.js'

/**
 * Regression coverage for the `{{steps.<id>.output.x}}` template in script
 * nodes. buildScriptNode used to drop `state` on the floor, so the SSH and
 * Docker paths both built a VariableContext without `steps`, leaving
 * `{{steps.*}}` unresolved. The fix forwards state.stepOutputs to both
 * paths via StageContext.stepOutputs (SSH) and an extra arg
 * (runScriptInDocker).
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

const sshServer: ServerInfo = {
  id: 1,
  host: '10.0.0.1',
  port: 22,
  username: 'ops',
  password: 'x',
  role: 'app',
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // drain
  }
}

describe('buildScriptNode — triggerParams.* template forwarding', () => {
  it('SSH path: ctx.triggerParams is forwarded to hooks.runScript', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 's1-script',
        stageType: 'script',
        targetRoles: ['app'],
        script: 'PAM_ADDRESS={{triggerParams.pam_address}} ./install.sh',
      }),
    ]

    let receivedCtx: StageContext | undefined
    const hooks: StageHooks = {
      async runScript(_stage, ctx): Promise<StageExecutionResult> {
        receivedCtx = ctx
        return { status: 'success', output: 'ok' }
      },
    }

    const builder = buildGraphFromStages({
      stages,
      stageContext: {
        runId: 42,
        servers: { app: [sshServer] },
        logDir: '/tmp/chatops-test',
      },
      hooks,
      triggerParams: { pam_address: 'https://pam-dev.paraview.cn', branch: 'main' },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))

    expect(receivedCtx).toBeDefined()
    const triggerParams = (receivedCtx as StageContext & {
      triggerParams?: Record<string, unknown>
    }).triggerParams
    expect(triggerParams).toEqual({
      pam_address: 'https://pam-dev.paraview.cn',
      branch: 'main',
    })
  })

  it('Docker path: {{triggerParams.x}} resolves against triggerParams in script', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 's1-script',
        stageType: 'script',
        // no targetRoles → Docker path
        script: 'PAM_ADDRESS={{triggerParams.pam_address}} ./install.sh',
      }),
    ]

    let receivedScript: string | undefined
    const dockerExec = {
      async exec(command: string) {
        receivedScript = command
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }

    const hooks: StageHooks = {
      async runScript(): Promise<StageExecutionResult> {
        return { status: 'success', output: 'ssh-not-used' }
      },
    }

    const builder = buildGraphFromStages({
      stages,
      stageContext: {
        runId: 42,
        servers: {},
        logDir: '/tmp/chatops-test',
        dockerExecutor: dockerExec as unknown as DockerExecutor,
      },
      hooks,
      triggerParams: { pam_address: 'https://pam-dev.paraview.cn' },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))

    expect(receivedScript).toBeDefined()
    // Pre-fix: 字面 "{{triggerParams.pam_address}}"
    // Post-fix: 替换为实际值
    expect(receivedScript).toBe(
      'PAM_ADDRESS=https://pam-dev.paraview.cn ./install.sh',
    )
  })
})

describe('buildScriptNode — steps.* template forwarding', () => {
  it('SSH path: ctx.stepOutputs is forwarded to hooks.runScript', async () => {
    // s1 = capability that emits a stepOutput keyed by node id.
    // s2 = script targeting role=app (SSH path) — assert that the hook
    //      receives ctx.stepOutputs containing s1's output.
    const stages: StageDefinition[] = [
      makeStage({
        name: 's1-cap',
        stageType: 'llm_agent',
        capabilityKey: 'load',
        outputFormat: 'json',
      }),
      makeStage({
        name: 's2-script',
        stageType: 'script',
        targetRoles: ['app'],
        script: 'echo {{steps.n1.output.downloadUrl}}',
      }),
    ]

    let receivedCtx: StageContext | undefined
    const hooks: StageHooks = {
      async runScript(_stage, ctx): Promise<StageExecutionResult> {
        receivedCtx = ctx
        return { status: 'success', output: 'ok' }
      },
      async runCapability(): Promise<StageExecutionResult> {
        // capability node populates state.stepOutputs[node.id] when
        // outputFormat=json — the node id under buildGraphFromStages
        // linearization is `n0`, `n1`, ...
        return { status: 'success', output: '{"downloadUrl":"https://example.com/pkg.tgz"}' }
      },
    }

    const builder = buildGraphFromStages({
      stages,
      stageContext: {
        runId: 42,
        servers: { app: [sshServer] },
        logDir: '/tmp/chatops-test',
      },
      hooks,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))

    expect(receivedCtx).toBeDefined()
    // The bug: buildScriptNode previously did not forward state to ctx,
    // so ctx.stepOutputs was undefined / missing s1's output entry.
    const stepOutputs = (receivedCtx as StageContext & {
      stepOutputs?: Record<string, { output?: Record<string, unknown> }>
    }).stepOutputs
    expect(stepOutputs).toBeDefined()
    // capability stage id under linearization is `n0` (first stage)
    expect(stepOutputs?.n0?.output).toEqual({
      downloadUrl: 'https://example.com/pkg.tgz',
    })
  })

  it('Docker path: {{steps.<id>.output.x}} resolves against state.stepOutputs in script', async () => {
    // No target roles, dockerExecutor configured → buildScriptNode runs
    // runScriptInDocker. Assert the resolved script handed to docker.exec
    // has the {{steps.*}} placeholder replaced.
    const stages: StageDefinition[] = [
      makeStage({
        name: 's1-cap',
        stageType: 'llm_agent',
        capabilityKey: 'load',
        outputFormat: 'json',
      }),
      makeStage({
        name: 's2-script',
        stageType: 'script',
        // no targetRoles → Docker path
        script: 'curl -fSL "{{steps.n0.output.downloadUrl}}" -o /tmp/pkg.tgz',
      }),
    ]

    let receivedScript: string | undefined
    const dockerExec = {
      async exec(command: string) {
        receivedScript = command
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }

    const hooks: StageHooks = {
      async runScript(): Promise<StageExecutionResult> {
        return { status: 'success', output: 'ssh-not-used' }
      },
      async runCapability(): Promise<StageExecutionResult> {
        return { status: 'success', output: '{"downloadUrl":"https://example.com/pkg.tgz"}' }
      },
    }

    const builder = buildGraphFromStages({
      stages,
      stageContext: {
        runId: 42,
        servers: {}, // empty → Docker path
        logDir: '/tmp/chatops-test',
        dockerExecutor: dockerExec as unknown as DockerExecutor,
      },
      hooks,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))

    expect(receivedScript).toBeDefined()
    // Pre-fix this is the literal "{{steps.n0.output.downloadUrl}}",
    // post-fix it's the resolved URL.
    expect(receivedScript).toBe(
      'curl -fSL "https://example.com/pkg.tgz" -o /tmp/pkg.tgz',
    )
  })
})

/**
 * Integration: assert the *graph state* exposes the script node's stepOutput
 * via state.stepOutputs[<id>] after the run finishes. This is the "writing
 * end" of the round-trip — the prior block proved the "reading end" (a
 * downstream script can read upstream stepOutputs); this block proves a
 * downstream node can read THIS script's stepOutputs.
 */
describe('buildScriptNode — graph state.stepOutputs[<scriptId>] (downstream consumption)', () => {
  it('SSH path: state.stepOutputs[stageId] populated with structured server detail', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 'install',
        stageType: 'script',
        targetRoles: ['app'],
        script: 'install.sh',
      }),
    ]

    const hooks: StageHooks = {
      async runScript(_stage, _ctx, servers): Promise<StageExecutionResult> {
        return {
          status: 'success',
          output: 'log',
          servers: [{
            host: servers[0].host,
            port: servers[0].port,
            role: servers[0].role,
            stdout: 'install ok',
            stderr: '',
            exitCode: 0,
            success: true,
          }],
        }
      },
    }

    const builder = buildGraphFromStages({
      stages,
      stageContext: {
        runId: 42,
        servers: { app: [sshServer] },
        logDir: '/tmp/chatops-test',
      },
      hooks,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))

    // 读最终 graph state — id 在 buildGraphFromStages linearize 后是 "n0"
    const finalState = (await app.getState(config)).values
    const stepOutputs = finalState.stepOutputs as Record<
      string,
      { status: string; output: Record<string, unknown> }
    > | undefined
    expect(stepOutputs).toBeDefined()
    expect(stepOutputs!.n0).toBeDefined()
    expect(stepOutputs!.n0.status).toBe('success')
    const out = stepOutputs!.n0.output
    expect(out.host).toBe(sshServer.host)
    expect(out.stdout).toBe('install ok')
    expect(out.exitCode).toBe(0)
    expect(out.success).toBe(true)
    expect(Array.isArray(out.servers)).toBe(true)
  })
})
