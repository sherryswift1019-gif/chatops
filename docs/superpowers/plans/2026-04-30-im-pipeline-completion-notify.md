# IM Pipeline Completion Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过 IM 触发流水线后，在流水线执行完成（成功或失败）时，将结果回复到对应的 IM 群。

**Architecture:** 在 `coordinator.ts` 的 IM pipeline 触发路径中，给 `runPipeline` 的 `onComplete` 参数传入一个回调；该回调利用现有的 `notifyImGroup` 函数将结果消息发到触发群，格式与参数采集失败时的通知风格一致。

**Tech Stack:** TypeScript, Fastify 5, Vitest, `notifyImGroup` (已有), `PipelineRunResult` (已有类型)

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/coordinator.ts` | 修改 | 给 IM 触发路径的 `runPipeline` 补 `onComplete` 回调 |
| `src/__tests__/unit/coordinator.test.ts` | 修改 | 新增两个测试：success 通知 / failed 通知 |

---

## Task 1: 补 onComplete 回调（主改动）

**Files:**
- Modify: `src/agent/coordinator.ts:182-209`

### 背景

当前代码（`coordinator.ts:196-201`）：

```typescript
await runPipeline(
  pipelineId,
  {},
  imTriggerCtx({ triggeredBy: initiatorId, platform, groupId, userId: initiatorId, params }),
  {},
  undefined,   // ← onComplete 未传，流水线结束后无任何 IM 回复
)
```

`platform` 和 `groupId` 在同一 IIFE 的 closure 里（第 178-179 行），可以直接用。
`notifyImGroup` 已在同文件上方通过动态 import 引入（第 206 行的错误处理分支用到了）。

- [ ] **Step 1: 修改 coordinator.ts 的 IM 触发块**

将 `src/agent/coordinator.ts` 第 196-202 行替换为：

```typescript
          const { notifyImGroup } = await import('../pipeline/im-notifier.js')

          await runPipeline(
            pipelineId,
            {},
            imTriggerCtx({ triggeredBy: initiatorId, platform, groupId, userId: initiatorId, params }),
            {},
            (result) => {
              const icon = result.status === 'success' ? '✅' : '❌'
              const lines = [`${icon} 流水线「${result.pipelineName}」${result.status === 'success' ? '执行成功' : '执行失败'}`]
              if (result.status === 'failed' && result.errorMessage) {
                lines.push(`原因：${result.errorMessage}`)
              }
              lines.push(`耗时：${Math.round(result.durationMs / 1000)}s`)
              void notifyImGroup(platform, groupId, lines.join('\n')).catch(() => {})
            },
          )
```

注意：`notifyImGroup` 的 import 须提前到 `collectImParams` 之前（或与它同级），避免重复动态 import。最终整段 IIFE 的结构如下：

```typescript
      void (async () => {
        try {
          const { runPipeline, imTrigger: imTriggerCtx } = await import('../pipeline/executor.js')
          const { getTestPipelineById } = await import('../db/repositories/test-pipelines.js')
          const { collectImParams } = await import('../pipeline/im-param-collector.js')
          const { notifyImGroup } = await import('../pipeline/im-notifier.js')

          const pipeline = await getTestPipelineById(pipelineId)
          if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`)

          let params: Record<string, unknown> = opts.extraParams ?? {}
          if (pipeline.paramSchema) {
            params = await collectImParams(platform, groupId, pipeline.paramSchema, pipeline.imPrompt)
          }

          await runPipeline(
            pipelineId,
            {},
            imTriggerCtx({ triggeredBy: initiatorId, platform, groupId, userId: initiatorId, params }),
            {},
            (result) => {
              const icon = result.status === 'success' ? '✅' : '❌'
              const lines = [`${icon} 流水线「${result.pipelineName}」${result.status === 'success' ? '执行成功' : '执行失败'}`]
              if (result.status === 'failed' && result.errorMessage) {
                lines.push(`原因：${result.errorMessage}`)
              }
              lines.push(`耗时：${Math.round(result.durationMs / 1000)}s`)
              void notifyImGroup(platform, groupId, lines.join('\n')).catch(() => {})
            },
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[AgentCoordinator] pipeline start failed for ${opts.capabilityKey}:`, msg)
          const { notifyImGroup } = await import('../pipeline/im-notifier.js')
          await notifyImGroup(platform, groupId, `❌ 流水线启动失败：${msg}`).catch(() => {})
        }
      })()
```

> **注意**：catch 块里保留独立的动态 import（因为它在 try 外，无法复用 try 块的 `notifyImGroup`）。

- [ ] **Step 2: 确认 TypeScript 类型检查通过**

```bash
cd /Users/yan/code/chatops && ./test.sh --typecheck
```

期望：零错误退出。

---

## Task 2: 新增单元测试

**Files:**
- Modify: `src/__tests__/unit/coordinator.test.ts`

现有测试文件已有完整的 mock 框架，包括：
- `vi.mock('../../pipeline/executor.js')` — 已有，`runPipeline` 是 `vi.fn()`
- `vi.mock('../../db/repositories/im-triggers.js')` — 已有，返回 null（handler 路径）

需要**新增**对 `notifyImGroup` 的 mock，并新增两个用例覆盖 IM 触发路径的完成回调。

- [ ] **Step 3: 在 coordinator.test.ts 顶部 mock 块添加 im-notifier mock**

在文件顶部现有的 `vi.mock(...)` 列表中追加：

```typescript
vi.mock('../../pipeline/im-notifier.js', () => ({
  notifyImGroup: vi.fn(async () => {}),
}))
```

- [ ] **Step 4: 新增 describe 块 —— IM 触发 pipeline 完成回调**

在文件末尾（最后一个 `describe` 块之后）追加：

```typescript
describe('AgentCoordinator - IM 触发 pipeline 完成回调', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pipeline 成功 → notifyImGroup 收到成功消息', async () => {
    const { getIMTrigger } = await import('../../db/repositories/im-triggers.js')
    const { runPipeline, getTestPipelineById } = await import('../../pipeline/executor.js') as any
    const { notifyImGroup } = await import('../../pipeline/im-notifier.js')

    ;(getIMTrigger as any).mockResolvedValueOnce({
      key: 'deploy', pipelineId: 10, capabilityKey: null, enabled: true,
    })

    // mock getTestPipelineById — coordinator 通过动态 import 调用
    // 注意：coordinator.ts 动态 import test-pipelines，需 mock 对应模块
    const { getTestPipelineById: getPipelineMock } =
      await import('../../db/repositories/test-pipelines.js')
    ;(getPipelineMock as any).mockResolvedValueOnce({ id: 10, name: '部署流水线', paramSchema: null, imPrompt: null })

    let capturedOnComplete: ((r: any) => void) | undefined
    ;(runPipeline as any).mockImplementation(
      async (_id: number, _sa: any, _trigger: any, _rv: any, onComplete: any) => {
        capturedOnComplete = onComplete
        return 55
      }
    )

    await triggerCapability({
      capabilityKey: 'deploy',
      context: { taskId: 't-im1', groupId: 'g-deploy', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
    })

    // 等 async IIFE 完成
    await new Promise((r) => setTimeout(r, 0))

    expect(capturedOnComplete).toBeDefined()
    capturedOnComplete!({
      runId: 55,
      pipelineName: '部署流水线',
      status: 'success',
      errorMessage: '',
      stageResults: [],
      durationMs: 5000,
    })

    await new Promise((r) => setTimeout(r, 0))

    expect(notifyImGroup).toHaveBeenCalledWith(
      'dingtalk',
      'g-deploy',
      expect.stringContaining('✅'),
    )
    expect(notifyImGroup).toHaveBeenCalledWith(
      'dingtalk',
      'g-deploy',
      expect.stringContaining('部署流水线'),
    )
  })

  it('pipeline 失败 → notifyImGroup 收到失败消息含错误原因', async () => {
    const { getIMTrigger } = await import('../../db/repositories/im-triggers.js')
    const { runPipeline } = await import('../../pipeline/executor.js') as any
    const { notifyImGroup } = await import('../../pipeline/im-notifier.js')
    const { getTestPipelineById: getPipelineMock } =
      await import('../../db/repositories/test-pipelines.js')

    ;(getIMTrigger as any).mockResolvedValueOnce({
      key: 'deploy', pipelineId: 10, capabilityKey: null, enabled: true,
    })
    ;(getPipelineMock as any).mockResolvedValueOnce({ id: 10, name: '部署流水线', paramSchema: null, imPrompt: null })

    let capturedOnComplete: ((r: any) => void) | undefined
    ;(runPipeline as any).mockImplementation(
      async (_id: number, _sa: any, _trigger: any, _rv: any, onComplete: any) => {
        capturedOnComplete = onComplete
        return 56
      }
    )

    await triggerCapability({
      capabilityKey: 'deploy',
      context: { taskId: 't-im2', groupId: 'g-deploy', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
    })

    await new Promise((r) => setTimeout(r, 0))

    capturedOnComplete!({
      runId: 56,
      pipelineName: '部署流水线',
      status: 'failed',
      errorMessage: 'SSH 连接超时',
      stageResults: [],
      durationMs: 3000,
    })

    await new Promise((r) => setTimeout(r, 0))

    expect(notifyImGroup).toHaveBeenCalledWith(
      'dingtalk',
      'g-deploy',
      expect.stringContaining('❌'),
    )
    expect(notifyImGroup).toHaveBeenCalledWith(
      'dingtalk',
      'g-deploy',
      expect.stringContaining('SSH 连接超时'),
    )
  })
})
```

> **注意**：`coordinator.ts` 中 `getTestPipelineById` 是通过动态 import `'../db/repositories/test-pipelines.js'` 来调的，所以需要 mock 该模块。在已有的 `vi.mock` 列表末尾加：
>
> ```typescript
> vi.mock('../../db/repositories/test-pipelines.js', () => ({
>   getTestPipelineById: vi.fn(async () => null),
> }))
> ```

- [ ] **Step 5: 运行新增测试验证通过**

```bash
cd /Users/yan/code/chatops && npx vitest run src/__tests__/unit/coordinator.test.ts
```

期望：全部 PASS，无 TypeScript 编译报错。

- [ ] **Step 6: 运行全套测试确认无回归**

```bash
cd /Users/yan/code/chatops && ./test.sh --filter coordinator
```

期望：coordinator 相关测试全部通过。

- [ ] **Step 7: Commit**

```bash
git add src/agent/coordinator.ts src/__tests__/unit/coordinator.test.ts
git commit -m "feat(coordinator): notify IM group on pipeline completion (success/failed)"
```

---

## 自我检查

### Spec Coverage
- [x] IM 触发流水线成功 → 发成功通知到群
- [x] IM 触发流水线失败 → 发失败通知到群，包含错误原因
- [x] 不影响已有的启动失败通知（catch 块保持不变）
- [x] 不影响 handleAnalysisComplete 的 onComplete 路径（独立代码块）

### 边界条件
- `notifyImGroup` 内部已做 try/catch + 无 sender 时只打 log 不抛错，onComplete 里的 `.catch(() => {})` 是双重保险
- `durationMs` 用 `Math.round(.../ 1000)s` 显示，避免毫秒数太长
- 回调是同步调用（`(result) => { ... }`），`notifyImGroup` 通过 `void ... .catch()` 非阻塞执行
