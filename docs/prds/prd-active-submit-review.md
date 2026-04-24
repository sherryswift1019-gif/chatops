# PRD 主动提交 Pipeline — 基于代码的 PRD 漏洞审查

> **被审 PRD**: [prd-active-submit.md](prd-active-submit.md)
> **基准代码**: `main` @ `2749a0e`
> **审查日期**: 2026-04-24
> **审查方式**: 对 PRD 每一节的假设在 main 代码中逐条验证

---

## 摘要

一共发现 **22 条漏洞**，按严重度：
- **P0（致命，不改开发就起不来）**：6 条 —— 集中在"`prd_submit` 入口如何被触发"、API 签名错误
- **P1（设计关键分歧）**：8 条 —— 集中在 review decision 模型、notify 通道复用、pipeline 模板能力
- **P2（实现细节/推荐改进）**：8 条

最核心的结论：**PRD §3.1 + §4.3 描述的 "`prd_submit` handler 解析指令 → runPipeline" 与现有 `triggerCapability` 路由机制冲突**——如果按 PRD 给 `prd_submit` 设 `default_pipeline_id`，handler 根本不会被调用。这是必须先解的架构级分歧。

---

## P0 · 致命漏洞

### P0-1 · `default_pipeline_id` 与 handler 互斥

**PRD 假设**（§3.1 + §4.3）：`prd_submit` capability 既有 handler（负责解析 IM 指令）、又有 `default_pipeline_id = 1893000001`。handler 在内部调 `runPipeline(pipelineId, ..., triggerParams)`。

**代码现状**（[coordinator.ts:145-175](src/agent/coordinator.ts#L145-L175)）：

```ts
// 如果该 capability 绑定了默认 pipeline，走 pipeline 驱动路径
if (capability.defaultPipelineId) {
  const runId = await runPipeline(capability.defaultPipelineId, {}, imTrigger({ ... }), ...)
  return { success: true, ... }
}
// 降级：走原 handler 路径（capability 未绑定 pipeline）
const handler = handlers.get(opts.capabilityKey)
```

一旦 `prd_submit.default_pipeline_id` 设了值，`triggerCapability` **直接 runPipeline，跳过 handler**——PRD 里写的正则解析、Claude fallback、authorEmail 反查全部不执行，pipeline 收到的 `extraParams` 是 IM 传下来的原始 `{message, productLineId, version, project, images}`（见 [claude-runner.ts:389-395](src/agent/claude-runner.ts#L389-L395)），**没有 `submissionId / slug / srcMdPath / targetMdPath / authorEmail`**，后续 4 个 stage 的 `capabilityParams` 模板 `{{triggerParams.submissionId}}` 全部解析为 undefined。

**修复方向（需 PM 拍板）**：
- **方案 A（推荐）**：`prd_submit` **不设** `default_pipeline_id`。handler 走正常路径，handler 内部解析指令后显式 `runPipeline(1893000001, ..., imTrigger(...))`。与 bug-fix 路径一致（`analyze_bug` handler → `maybeCompleteAnalyze` → `handleAnalysisComplete` → `runPipeline`，见 [coordinator.ts:246, 258-291](src/agent/coordinator.ts#L246)）
- **方案 B**：在 `prd_submit` 的 pipeline 里加一个 "IM 解析" stage（用 `im-input-agent.ts`），第一个 stage 自己产出 `submissionId/slug/...` 写入事件表，后续 stage 从事件表读。比 A 更 pipeline-native 但改动大。

**影响 PRD 节**：§3.1 步骤 6、§4.2 第 1 行、§4.3 整段

---

### P0-2 · `HANDLER_CAPABILITIES` 白名单未扩充

**代码现状**（[claude-runner.ts:374](src/agent/claude-runner.ts#L374)）：

```ts
const HANDLER_CAPABILITIES = new Set([
  'analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3',
  'ai_review_mr', 'search_knowledge'
])
if (HANDLER_CAPABILITIES.has(intent.capability)) { ... 走 handler 路径 ... }
// 否则走 Step 6: 通用 capability → 加载工具走对话模式
```

IM 收到 `@agent 提交PRD ...`，intent 检测到 `prd_submit`，但白名单不包含 → **掉到通用对话模式**（[claude-runner.ts:425](src/agent/claude-runner.ts#L425)）。通用模式需要 `capability.toolNames` 非空，而 PRD §4.2 明确 `toolNames: '[]'::jsonb` → 代码直接回 "「PRD 提交（入口）」能力暂无可用工具"（[claude-runner.ts:430-435](src/agent/claude-runner.ts#L430-L435)）。

**修复**：PRD 必须明确要求把 `prd_submit` 加入 `HANDLER_CAPABILITIES` 白名单，此为 §3.1 的前置条件。

**影响 PRD 节**：§3.1、§5.2 "待修改现有文件"表（漏列 claude-runner.ts）

---

### P0-3 · `senderEmail` 字段在 IM 上下文里根本不存在

**PRD 假设**（§3.1 第 4 步）："author 邮箱确定：优先从 IM context 的 `senderEmail` 字段取；缺失则根据 IM userId 反查 `dingtalk_users.email`"

**代码现状**（[tools/types.ts:4-13](src/agent/tools/types.ts#L4)）：

```ts
export interface TaskContext {
  taskId: string
  groupId: string
  platform: string
  initiatorId: string
  initiatorRole: Role | null
  cwd?: string
  productLineId?: number
  originalPrompt?: string
}
```

**没有 `senderEmail`**。钉钉 webhook 也不回传邮箱（钉钉 API 回传的是加密的 senderStaffId）。PRD 的"优先级"第一顺位其实从不存在。

**修复**：PRD §3.1 第 4 步应改为单一路径 —— `initiatorId → dingtalk_users.user_id → email`，去掉 "senderEmail 优先" 的描述。

**影响 PRD 节**：§3.1

---

### P0-4 · MR labels 是 CSV 字符串，不是数组

**PRD 假设**（§3.3 + §4.3 pipeline seed）：`labels: ['prd-active-review']`

**代码现状**（[gitlab-mr.ts:8-15](src/agent/mr/gitlab-mr.ts#L8-L15)）：

```ts
export interface CreateMrInput {
  ...
  labels?: string      // ← 字符串，不是 string[]
}
// line 40
labels: input.labels ?? 'ai-generated',
```

GitLab REST API 的 labels 字段就是 CSV 字符串。PRD 写成数组会 TypeScript 报错，或者在 JSON payload 里序列化成字面量数组，GitLab 可能不识别。

**修复**：PRD §3.3 和 §5 所有出现 `labels: ['prd-active-review']` 的地方改成 `labels: 'prd-active-review'`。

**影响 PRD 节**：§3.3、§4.3、§5

---

### P0-5 · `dingtalk_users.email` 列 + 函数式索引前置条件缺失

**PRD 假设**（§3.5）：
```sql
SELECT user_id FROM dingtalk_users WHERE lower(email) = lower($1)
```

**代码现状**（[schema-v2.sql:61-67](src/db/schema-v2.sql#L61-L67)）：

```sql
CREATE TABLE IF NOT EXISTS dingtalk_users (
  user_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT DEFAULT '',
  department  TEXT DEFAULT '',
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**无 `email` 列**。PRD 的 `authorEmail → userId` 反查无法工作。

**修复**：PRD §4.1 必须增加一节"`dingtalk_users.email` 列补齐"，并明确：
- `ALTER TABLE dingtalk_users ADD COLUMN IF NOT EXISTS email TEXT`
- 因为查询用 `LOWER(email)`，索引必须是**函数式索引**：`CREATE INDEX IF NOT EXISTS idx_dingtalk_users_email_lower ON dingtalk_users (LOWER(email))` —— 普通 `(email)` 索引不会命中
- 运营 SOP：如何批量回填 email（钉钉 OpenAPI `user.get_by_mobile` / 管理后台手动）

**影响 PRD 节**：§3.5、§4（缺 4.x 小节）

---

### P0-6 · `worktree.acquire` 签名缺 `repoUrl`，`version` 语义未定义

**PRD 假设**（§3.2 第 2 步）：`worktree.acquire({ userId: 'prd-submit-agent', product, projectPath, version, sessionId })`

**代码现状**（[worktree/manager.ts:27-38, 105](src/agent/worktree/manager.ts#L27-L38)）：

```ts
export interface AcquireOptions {
  userId: string
  product: string
  version: string       // checkout 到哪个分支
  sessionId: string
  repoUrl: string       // ← 必传
  projectPath?: string
}
```

**两个问题**：
1. **`repoUrl` 必传** 但 PRD 没列。handler 里要调 `projectPathToGitUrl(projectPath)` 或等价函数（见 [claude-review.ts:82](src/agent/review/claude-review.ts#L82) 范例）
2. **`version` 是要 checkout 的分支名**。PRD 源 md 在 master 分支，应 `version: 'master'`；之后再 `git checkout -b prd/{slug}-{ts}` 建新分支。PRD 没写清楚起始分支

**修复**：PRD §3.2 第 2 步改写为：
```
worktree.acquire({
  userId: 'prd-submit-agent',
  product: `pl-${productLineId}`,
  projectPath,
  version: 'master',          // checkout 点；后续 createPrdBranch 再开新分支
  sessionId: submissionId,
  repoUrl: await projectPathToGitUrl(projectPath),
})
```

**影响 PRD 节**：§3.2

---

## P1 · 设计关键分歧

### P1-7 · Review 不用 worktree 的设计简化需要论证

**PRD 主张**（§3.4 第 2 步、§5.1 表格"不用 worktree，比 clone 快一个数量级"）

**代码现状**（[claude-review.ts:75-101](src/agent/review/claude-review.ts#L75)）：现有 `ai_review_mr` **反而**专门 acquire worktree，理由：
> "acquire fix 分支 worktree，让 Claude 能 Grep/Read 完整代码库（不只看 diff）"

**分歧**：PRD 想省 worktree 是为了速度；但 MR diff-only review 有盲点——比如 PRD 文档里引用了 `docs/architecture/*.md` 等其它文件的术语定义，Claude 只看 diff 不能验证这类引用。

**建议**：
- 接受简化，但 §3.4 要加一句"MVP 不做跨文档一致性校验，v2 视情况启用 worktree"
- 或保留 worktree 路径（`userId='prd-submit-review-agent'` 与 stage 1 的 `prd-submit-agent` 再做隔离）

**影响 PRD 节**：§3.4 + §5.1 表

---

### P1-8 · `decision: pass|blocked` 枚举需要新 prompt 强约束

**PRD 假设**（§3.4）：输出 `{ decision, findings, noteId }`，`decision ∈ {pass, blocked}`。

**代码现状**（[claude-review.ts:104-106](src/agent/review/claude-review.ts#L104)）：

```ts
const approved = summary.includes('ai-approved') || summary.includes('可以合并') || summary.includes('无高风险')
const label = approved ? 'ai-approved' : 'ai-needs-attention'
```

现有是**字符串启发式** + `ai-approved / ai-needs-attention` 二元 label。PRD 新域 `pass / blocked` 必须**在 prompt 里明确要求 Claude 输出 JSON**（形如 `{"decision":"pass","findings":[...]}`），否则落回启发式抽取，`findings[]` 拿不出来。

**修复**：PRD §3.4 和 §4.4 的 `PRD_REVIEW_SYSTEM_PROMPT` 应明确约束 JSON schema，`claude-prd-review.ts` 负责 JSON.parse + 校验。参考 [prd-agent.ts](src/agent/prd/prd-agent.ts) 或 `runClaudeReview` 的输出规范。

**影响 PRD 节**：§3.4、§4.4

---

### P1-9 · `notify-handler` 的"场景跳过"逻辑不能无脑复用

**代码现状**（[notify-handler.ts:99-101](src/agent/notify/notify-handler.ts#L99)）：

```ts
// 场景过滤：owner 只接收修复成功类消息；其他场景直接跳过发送
if (!shouldNotifyOwners(scenario.kind)) {
  return { success: true, output: `场景 ${scenario.kind}：无需发送 DM（信息由前端展示）` }
}
```

现有 `notify_bug` 有"部分场景不发 DM"的过滤（`approval_rejected / approval_timeout / fix_failed` 都跳过）。PRD `prd_notify` 的三种场景 (`passed / blocked / failed`) **全部都要发 DM**（PRD §7.1 第 5、7 步冒烟明确要求），**不能拷贝** `shouldNotifyOwners` 策略。

**修复**：PRD §3.5 应明确 "不复用 `shouldNotifyOwners`"、"三种场景全发"；独立实现 `decideScenario`。

**影响 PRD 节**：§3.5

---

### P1-10 · `getFirstAdapter` 是私有 API hack

**代码现状**（[notify-handler.ts:510-513](src/agent/notify/notify-handler.ts#L510)）：

```ts
function getFirstAdapter(mgr: PipelineApprovalManager): IMAdapter | undefined {
  const adapters = (mgr as unknown as { adapters?: IMAdapter[] }).adapters
  return adapters?.[0]
}
```

这是**跨模块的强制类型断言**访问 PipelineApprovalManager 的私有字段。PRD §3.5 第 5 步计划原样复制：

```ts
const mgr = PipelineApprovalManager.getInstance()
const adapter = (mgr as any).adapters?.[0]
```

风险：后续 `PipelineApprovalManager` 重构或改成异步初始化，两处 hack 同时坏。

**建议**：PRD 应要求在 `src/pipeline/approval-manager.ts` 暴露公共方法 `getFirstImAdapter(): IMAdapter | null`（一次抽象），新旧通知都走该 API。否则把这条记入 §6 风险表。

**影响 PRD 节**：§3.5、§6（风险表应新增）

---

### P1-11 · capabilityParams 模板只支持**整串单字段**替换

**代码现状**（[executor-legacy.ts:48](src/pipeline/executor-legacy.ts#L48)）：

```ts
const match = value.match(/^\{\{triggerParams\.(\w+)\}\}$/)
```

特征：
- `^...$` 整串匹配，不支持内嵌（`"PRD [${title}]"` 这种写法无效）
- `\w+` 只允许单层字段（不支持 `triggerParams.payload.title`）
- 非字符串类型（number/boolean/object）的 triggerParams 值原样透传

**对 PRD 影响**：
- PRD §4.3 的 pipeline seed 里所有 `{{triggerParams.xxx}}` 都是**整串替换**，没踩坑 ✅
- 但如果未来想拼 MR 标题 `"[PRD] {{triggerParams.title}}"` 在 pipeline 配置里，**不能工作**——必须在 handler 里拼完再放入事件表

**影响 PRD 节**：§4.3（应加一条说明："拼接类操作在 handler 侧完成，不在 pipeline 配置里用模板"）

---

### P1-12 · `onFailure: continue` 会让 pipeline run 整体显示 "failed"

**PRD 假设**（§4.3 + §5.5）：全 stage `continue` 保证 stage 4 跑到。

**代码现状**（确认逻辑 OK，[graph-builder.ts:167-168](src/pipeline/graph-builder.ts#L167)）：`shouldStopAfter` 仅在 `status==='failed' && onFailure==='stop'` 返回 true。`continue` 的 failed stage 不阻断 graph。

**但**：有任一 stage failed → 最终 `finishTestRun(runId, 'failed', ...)`。用户/管理员在"流水线运行"看板会看到**红色记录**，即便 stage 4 DM 已成功发出。

**修复建议**：PRD §6 风险表应新增："UI 看板显示红色"的心理成本，或约定"stage 4 `prd_notify` 也 failed 时才算真失败，否则整条 run 判为 `success`"——需改 `executor-legacy.ts` / `graph-runner.ts` 的 run finalize 逻辑（这超出"零改动"约束）。

**影响 PRD 节**：§5.5 通知对齐矩阵、§6 风险表

---

### P1-13 · `branch.ts` 并发保护只有 ts，同毫秒极端会撞

**PRD 假设**（§3.2 验收标准）："并发两次相同 slug → `prd/{slug}-{ts}` 因 ts 不同天然不撞"

**反驳**：两次提交在**同毫秒**内到达（Node 单线程下概率极低但非零），`Date.now()` 一致 → branch 名撞，push 时后者被拒。`submissionId` 已带 `nanoid(4)`，branch 没带。

**修复**：branch 改为 `prd/{slug}-{ts}-{nanoid(4)}`，或用 `submissionId` 当后缀的一部分（天然带 nonce）。

**影响 PRD 节**：§3.2

---

### P1-14 · Stage 内**无法访问**原 IM 上下文

**代码现状**（[executor-hooks.ts:171-179](src/pipeline/executor-hooks.ts#L171)）：

```ts
context: {
  taskId: `pipeline-${ctx.runId}-stage-${ctx.stageIndex}`,
  groupId: 'pipeline',
  platform: 'pipeline',
  initiatorId: 'pipeline-executor',
  initiatorRole: 'admin',
},
```

每个 stage 在调 `triggerCapability` 时用的是**合成 context**。真实 IM 信息（platform=dingtalk/feishu, groupId, userId）全部丢失。

**PRD 影响**：PRD §3.1 决定"只用 authorEmail 路由到 DM 不回群"——恰好规避了这个限制 ✅。但必须在 §4.4 或 §5.4 数据接力小节明确写："stage 内无法读 groupId / platform / userId，所有路由键必须放进 `triggerParams`"，否则实现者可能踩坑。

**影响 PRD 节**：§4.4 or §5.4（应加一段明确说明）

---

## P2 · 实现细节与改进建议

### P2-15 · `runPipeline` 签名应写准确

PRD 写 "启动 pipeline：`runPipeline(pipelineId, ..., triggerParams)`"。准确签名（[executor.ts:61-67](src/pipeline/executor.ts#L61)）：

```ts
runPipeline(
  pipelineId: number,
  serverAssignment: Record<string, string[]>,  // 通常 {} for IM 触发
  trigger: PipelineTrigger,                    // 用 imTrigger({...}) 构造
  runtimeVarsInput: Record<string, string> = {},
  onComplete?: (result: PipelineRunResult) => void,
)
```

`triggerParams` 不是位置参数，而是 `trigger.params`。handler 应当：

```ts
await runPipeline(1893000001, {}, imTrigger({
  triggeredBy: opts.context.initiatorId,
  platform: opts.context.platform,
  groupId: opts.context.groupId,
  userId: opts.context.initiatorId,
  params: { submissionId, projectPath, srcMdPath, targetMdPath, slug, title, authorEmail }
}))
```

**影响 PRD 节**：§3.1、§5.1 模块表

---

### P2-16 · GitLab 文件 raw API 路径编码

PRD §5.1 表 `gitlab-file.ts` 说 "走 GitLab /files/:path/raw"。但 URL 中 `path` 必须**整体 URL-encode**（斜杠也要编码成 `%2F`），例如 `drafts/auth-v2.md` → `drafts%2Fauth-v2.md`。[gitlab-mr.ts:34](src/agent/mr/gitlab-mr.ts#L34) 的 `encodeURIComponent(input.projectPath)` 模式可参考。

**影响 PRD 节**：§5.1

---

### P2-17 · IM 指令正则的引号支持范围

PRD §3.1 正则：`["""](.+?)["""]`。

实际 IM 场景中还需考虑：中文单引号 `''`、智能双引号、全角引号、用户漏引号（`标题=邮箱登录` 直接空格）。

**建议**：正则放宽 + Claude fallback 兜底（PRD 已有）；或单独列出支持/不支持的格式清单。

**影响 PRD 节**：§3.1

---

### P2-18 · Pipeline seed ID 1893000001 防撞

**代码现状**（[schema-v25.sql:70](src/db/schema-v25.sql) L1-Bug-Fix-Pipeline）：现有 pipeline id 约定大致是自增或时间戳。PRD 硬编码 `1893000001`，建议核查：
- `SELECT id FROM test_pipelines ORDER BY id DESC` 确认不撞
- 或改用 `ON CONFLICT (id) DO UPDATE SET ...` 做幂等（当前用 `DO NOTHING` 可能让后续 PRD 改不进去）

**影响 PRD 节**：§4.3

---

### P2-19 · Claude CLI 超时语义

PRD §3.4 说 "Claude CLI 超时（900s）"。现有 [claude-review.ts:97](src/agent/review/claude-review.ts#L97) 用 `10 * 60_000 = 600s`。Stage timeout（pipeline 层）与 Claude timeout（runner 层）是两层，PRD 应对齐：stage `timeoutSeconds: 900` > Claude runner `timeoutMs: 600000` 时以 Claude 先退出为准。

**影响 PRD 节**：§3.4、§4.3

---

### P2-20 · `stage retry` 由 graph-runner 实现，非 runCapability

**PRD 假设**（§4.3）：stage 4 配 `retryCount: 2`，就会自动重试。

**代码现状**：[executor-hooks.ts:158-197](src/pipeline/executor-hooks.ts#L158) 的 `runCapability` 本身**没**有重试循环，只有 timeout race。Retry 循环在 `runScriptOnServers` 路径（[executor-hooks.ts:151](src/pipeline/executor-hooks.ts#L151)）里明确写了，而 capability stage 的 retry 是不是在 graph-builder 层？需要确认。

**操作**：开发开工前 grep `retryCount` 在 capability stage 路径的使用，若未实现则 PRD §4.3 的 `retryCount:2` 承诺落空，必须手动实现或降级策略。

**影响 PRD 节**：§4.3（需加一条前置检查）

---

### P2-21 · `projects_repo` owner 路径与新 `dingtalk_users.email` 路径的职责分层

现有 `notify_bug` 经 `projects.owner_id` → `dingtalk_users.user_id`（[notify-handler.ts:166](src/agent/notify/notify-handler.ts#L166)）；PRD 新增路径经 `dingtalk_users.email`。两条路径并存，未来运营维护两套人员映射（project.owner_id 按"项目所有者"，dingtalk_users.email 按"本人邮箱"），应在 PRD §4.x 或附录**显式**说明双表分工，避免 DBA 误以为冗余。

**影响 PRD 节**：§4（附录）

---

### P2-22 · PRD `toolNames: '[]'` + handler 路径的一致性

5 个新 capability 都设 `tool_names: '[]'::jsonb`（§4.2）。这与 handler-path 路由一致（handler 不需要 toolNames）。但如果 P0-2 的修复没做 (`prd_submit` 不加白名单)，通用对话路径 [claude-runner.ts:430](src/agent/claude-runner.ts#L430) 会因 `toolNames.length === 0` 直接报错退出。

**影响 PRD 节**：§4.2 + §3.1（两处必须同时改）

---

## 建议修订顺序

1. **先拍板 P0-1**（default_pipeline_id 方案 A 还是 B）——这是整条链路的触发模型，其他 P0 都依赖它定了才能落实
2. 同步修 P0-2 / P0-3 / P0-6（入口路径、context、worktree 签名）
3. P0-4 / P0-5（schema / labels）是 schema-v28 内的小修正
4. P1 是功能行为分歧，建议 PM + 一起过一轮
5. P2 可在开发计划 §10 前置手检清单中落地

---

## 没有问题 / 已对齐的点（供心安）

- §1.3 成功指标度量方式（用 `prd_submit_events` 查询）可行
- §3.2 worktree userId 前缀隔离确实生效（`buildId` 前缀不同）
- §3.4 `getCapabilityByKey(...).systemPrompt` 读取方式与现有 `claude-review.ts:58` 一致
- §3.6 label 短路 3 行修改是等 passive 合入后的事，方向对
- §4.1 `prd_submit_events` 表结构与 `bug_fix_events` 同构，repository 层可一比一抄
- §4.4 system_prompt 两段式 UPDATE 与 `migrate.ts:113-142` 现有 `create_prd / review_prd` 模式一致
- §5.3 worktree 隔离论证成立（buildId 前缀不同 → 目录/锁隔离）
- §5.5 通知对齐矩阵整体方向对，只是个别单元格需补注

---

## 附录：本次审查对比清单

| PRD 节 | 审查依据文件 | 结论 |
|--------|-------------|------|
| §3.1 入口解析 | [claude-runner.ts](src/agent/claude-runner.ts), [coordinator.ts](src/agent/coordinator.ts), [tools/types.ts](src/agent/tools/types.ts) | P0-1 / P0-2 / P0-3 |
| §3.2 commit | [worktree/manager.ts](src/agent/worktree/manager.ts), [fix/fix-logic.ts](src/agent/fix/fix-logic.ts) | P0-6 / P1-13 |
| §3.3 create MR | [gitlab-mr.ts](src/agent/mr/gitlab-mr.ts) | P0-4 |
| §3.4 AI review | [claude-review.ts](src/agent/review/claude-review.ts), [reviewer.ts](src/agent/review/reviewer.ts) | P1-7 / P1-8 / P2-19 |
| §3.5 notify | [notify-handler.ts](src/agent/notify/notify-handler.ts), [schema-v2.sql](src/db/schema-v2.sql) | P0-5 / P1-9 / P1-10 |
| §4.3 pipeline | [executor.ts](src/pipeline/executor.ts), [executor-legacy.ts](src/pipeline/executor-legacy.ts), [graph-builder.ts](src/pipeline/graph-builder.ts), [executor-hooks.ts](src/pipeline/executor-hooks.ts) | P1-11 / P1-12 / P2-15 / P2-18 / P2-20 |
| §5 技术方案 | 同上 | P1-14 |
