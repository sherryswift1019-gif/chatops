// E2E pipeline-b 实时进度事件总线（in-memory，单进程）
//
// 用法：
//   - emit(runId, event)                场景/修复 runner 通过 bridge 推流式事件
//   - subscribe(runId, cb): unsubscribe  SSE handler 订阅；cb 内可调 unsubscribe
//   - getHistory(runId)                 SSE handler 连上时 replay 历史
//   - ensureRun(runId)                  admin POST 入口同步预创建 bus，消除 race
//   - clearRun(runId)                   runPipelineB finally setTimeout(5min) 后清
//
// 设计要点见 plan：
//   - bus 不存在时 subscribe 立即异步 fire 'closed' 给 cb（防止已 clearRun
//     或不存在 runId 的连接永久挂）
//   - emit 迭代 listeners 用 [...] 快照，避免 cb 内 unsubscribe 改 Set 引发歧义
//   - listener cb 抛错被 try/catch 隔离，不污染其他订阅者
//   - history 上限 MAX_HISTORY，超过 shift 旧事件
//
// 多 worker 部署会失效（in-memory）— 当前 chatops 单进程，docker-compose.yml
// 单 service。规模化时换 redis pub/sub。

export type ScenarioEvent =
  | { type: 'scenario_start'; runId: string; scenarioRunId: string; scenarioId: string; attemptNumber: number; ts: number }
  | { type: 'tool_use'; runId: string; phase: 'scenario' | 'fix'; step: number; toolName: string; argsSummary: string; ts: number }
  | { type: 'assistant_text'; runId: string; phase: 'scenario' | 'fix'; text: string; ts: number }
  | { type: 'scenario_end'; runId: string; scenarioRunId: string; result: string; ts: number }
  | { type: 'fix_start'; runId: string; scenarioRunId: string; scenarioId: string; ts: number }
  | { type: 'fix_end'; runId: string; scenarioRunId: string; success: boolean; verdict: string; ts: number }
  | { type: 'agent_error'; runId: string; phase: 'scenario' | 'fix'; message: string; ts: number }
  | { type: 'closed'; runId: string; ts: number }

type Listener = (event: ScenarioEvent) => void

interface RunBus {
  listeners: Set<Listener>
  history: ScenarioEvent[]
}

const MAX_HISTORY = 1000

const runs = new Map<string, RunBus>()

function keyOf(runId: bigint): string {
  return runId.toString()
}

function getOrCreate(runId: bigint): RunBus {
  const key = keyOf(runId)
  let bus = runs.get(key)
  if (!bus) {
    bus = { listeners: new Set(), history: [] }
    runs.set(key, bus)
  }
  return bus
}

export function ensureRun(runId: bigint): void {
  if (!runId || runId === 0n) return
  getOrCreate(runId)
}

export function emit(runId: bigint, event: ScenarioEvent): void {
  if (!runId || runId === 0n) return
  const bus = getOrCreate(runId)
  bus.history.push(event)
  if (bus.history.length > MAX_HISTORY) bus.history.shift()
  // 快照迭代：防止 listener 内调 unsubscribe 在迭代中删除 Set 元素引发歧义
  for (const cb of [...bus.listeners]) {
    try {
      cb(event)
    } catch (e) {
      console.warn('[scenario-event-bus] listener threw:', e)
    }
  }
}

export function subscribe(runId: bigint, cb: Listener): () => void {
  // 无效 / 已 clearRun / 从未存在的 runId → 立即（next tick）通知 closed
  // setImmediate 避免在 subscribe 调用栈内 synchronous 触发 cb
  if (!runId || runId === 0n) {
    setImmediate(() => {
      try {
        cb({ type: 'closed', runId: keyOf(runId), ts: Date.now() })
      } catch { /* ignore */ }
    })
    return () => { /* noop */ }
  }
  const key = keyOf(runId)
  const bus = runs.get(key)
  if (!bus) {
    setImmediate(() => {
      try {
        cb({ type: 'closed', runId: key, ts: Date.now() })
      } catch { /* ignore */ }
    })
    return () => { /* noop */ }
  }
  bus.listeners.add(cb)
  return () => {
    bus.listeners.delete(cb)
  }
}

export function getHistory(runId: bigint): ScenarioEvent[] {
  if (!runId || runId === 0n) return []
  const bus = runs.get(keyOf(runId))
  return bus ? [...bus.history] : []
}

export function clearRun(runId: bigint): void {
  if (!runId || runId === 0n) return
  runs.delete(keyOf(runId))
}

export function __resetForTesting(): void {
  runs.clear()
}
