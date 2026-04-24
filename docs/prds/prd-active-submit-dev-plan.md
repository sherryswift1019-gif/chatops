# PRD 主动提交 MR Pipeline — 开发计划

> **关联 PRD**: [prd-active-submit.md](prd-active-submit.md)（v3，2026-04-24：标题派生 + Draft 闸门）
> **负责人**: zhangshanshan
> **目标分支**: `feature/prd-active-submit`（fork 自 `origin/main`）
> **估算总量**: **2.8 人日**（M0 ~ M4a，上线必须项）；M4b（passive 合入后 label 短路）**可选**，+0.2d
> **创建时间**: 2026-04-24

---

## 0. 前置发现与决策

基于 `main` HEAD (`2749a0e`) 实地勘察。

### 0.1 可以直接复用的现成基建（来自 bug-fix 链路）

| 能力 | 已有实现 | 本方案复用方式 |
|------|---------|----------------|
| IM 接入（钉钉 / 飞书） | [src/adapters/im/dingtalk.ts](src/adapters/im/dingtalk.ts) / [feishu.ts](src/adapters/im/feishu.ts) | 直接用，不改 |
| `@agent` 消息接收 + intent 识别 | [src/agent/claude-runner.ts](src/agent/claude-runner.ts) | **仅需**在 L374 `HANDLER_CAPABILITIES` 加 `'prd_submit'` |
| Capability 注册 + 路由 | [src/agent/coordinator.ts](src/agent/coordinator.ts) `registerCapabilityHandler / triggerCapability` | 直接调用，不改 |
| DM 单聊 API | [src/adapters/im/types.ts](src/adapters/im/types.ts) `IMAdapter.sendDirectMessage` | 直接调用（同 `notify_bug` 模式） |
| Pipeline 引擎（stage 调度 + triggerParams 传递 + onFailure） | [src/pipeline/executor.ts](src/pipeline/executor.ts) / [graph-builder.ts](src/pipeline/graph-builder.ts) / [executor-hooks.ts](src/pipeline/executor-hooks.ts) | `runPipeline(id, {}, imTrigger(...))` 直接调用 |
| Capability → Pipeline 配置 | `capabilities` / `test_pipelines` 表 | schema-v28 追加行，沿用结构 |
| 事件审计表模式 | [src/db/repositories/bug-fix-events.ts](src/db/repositories/bug-fix-events.ts) | 新建 `prd_submit_events` 表 + repository 一比一同构 |
| MR 创建 API 封装 | [src/agent/mr/gitlab-mr.ts](src/agent/mr/gitlab-mr.ts) `gitlabCreateMr` | 直接调用 |
| MR note 回写 | [src/agent/review/gitlab-mr-note.ts](src/agent/review/gitlab-mr-note.ts) `gitlabPostMrNote` | 直接调用 |
| Claude CLI 执行器 | [src/agent/claude-executor.ts](src/agent/claude-executor.ts) | 直接用（仅传新 prompt） |

**结论**：本方案的实际增量只有两类——**新 schema** + **新 handler + 一个 url-parser + 一个 mr-api helper**。所有跨模块交互都是调现成 API，**不引入任何新的"IM ↔ 后端"通路**。

### 0.2 与原 plan 假设的偏差（必须修正）

| 假设 | 实际情况 | 影响 |
|------|------|------|
| `dingtalk_users.email` 列已存在 | main 的 [schema-v2.sql:61-67](src/db/schema-v2.sql#L61-L67) **无 email 列** | schema-v28 自行补齐 `ADD COLUMN IF NOT EXISTS email TEXT` + 函数式索引 |
| `prd_submit` 通过 `default_pipeline_id` 触发 pipeline + handler 做解析 | [coordinator.ts:145](src/agent/coordinator.ts#L145) 对有 `defaultPipelineId` 的 capability **直接 runPipeline，跳过 handler** | `prd_submit` **不设** `default_pipeline_id`；handler 内显式 `runPipeline(...)` |
| IM `TaskContext` 有 `senderEmail` 字段 | 只有 `initiatorId / groupId / platform`；邮箱只能由 `dingtalk_users.user_id → email` 反查 | §3.1 单一路径反查 |
| `prd_submit` intent 命中后自动走 handler | [claude-runner.ts:374](src/agent/claude-runner.ts#L374) 白名单未含 `prd_submit` → 掉通用对话模式 → `toolNames=[]` 报错 | 白名单加 `'prd_submit'` |
| `gitlabCreateMr.labels` 接受数组 | [gitlab-mr.ts:14](src/agent/mr/gitlab-mr.ts#L14) `labels?: string` 是 CSV 字符串 | labels 用 `'prd-active-review'` |
| 原 plan 让 agent 搬 draft 到 `docs/prds/` | PM 自己 push 到正式路径，agent 只开 MR | **`prd_commit` stage 不做** |
| 原 plan 指令入参用 projectPath + 源分支 + 目标分支（技术字段） | PM 视角不友好 | 改 URL 式入参（工作地址 / MR 地址 / MR 文件 + 可选标题） |
| 原 plan 不做 Merge 闸门 | 需要"review 不通过则 Merge 不可点" | **Draft MR 做闸门**；Stage 1 置 Draft、Stage 2 pass 才解除 |

### 0.3 关键决策汇总（PM 已确认）

1. **`prd_submit` handler-path（方案 A）**，不设 `default_pipeline_id`（与 `analyze_bug → handleAnalysisComplete → runPipeline` 同构）
2. **Pipeline 3 stage**：`prd_create_mr → prd_ai_review_mr → prd_notify`（不含 `prd_commit`）
3. **入口指令**：`@agent 提交PRD MR 工作地址=<URL> MR地址=<URL> MR文件=<path> [标题="<title>"]`
4. **MR 标题**：`标题=` 可选；缺省时由 stage 1 从 commit log 派生；最终格式 `[PRD] <title>`
5. **Draft 闸门**：新建自带 `Draft:` 前缀；复用 existing 强制 PUT 回 Draft；stage 2 pass 才解除
6. **幂等**：同 `source_branch + target_branch` 已有 open MR → 复用 `mrIid`
7. **MR 文件路径**：正则 `^docs/prds/.+\.md$` 限制；不支持跨 repo MR

---

## 1. 任务粒度约定

- 每个任务 ≤ 半日，单个可交付单元
- 任务 ID 格式：`M{阶段}-T{序号}`
- **新增**文件标 ➕、**修改**文件标 ✏️
- 验证手段：`unit`（单测）/ `smoke`（手动冒烟）/ `compile`（`pnpm build` 过）/ `migrate`（`pnpm migrate` 过）

---

## 2. M1 — DB 基建 + Capability 注册（0.4d）

**目标**：schema + capability + pipeline 三块地基，`pnpm migrate` 验证。

### M1-T1 · 写 schema-v28.sql

➕ [src/db/schema-v28.sql](src/db/schema-v28.sql)

内容：
1. `CREATE TABLE prd_submit_events` + 2 个索引（字段参考 PRD §4.1，**`code` 枚举不含 `prd_commit`**）
2. `ALTER TABLE dingtalk_users ADD COLUMN IF NOT EXISTS email TEXT`
3. **函数式索引**：`CREATE INDEX IF NOT EXISTS idx_dingtalk_users_email_lower ON dingtalk_users (LOWER(email))`
4. 4 条 `INSERT INTO capabilities ... ON CONFLICT (key) DO NOTHING`（key: `prd_submit` / `prd_create_mr` / `prd_ai_review_mr` / `prd_notify`，全部 `tool_names='[]'::jsonb`）
5. 1 条 `INSERT INTO test_pipelines ... ON CONFLICT (id) DO NOTHING`（id=1893000001，**3 个 stage**，全部 `onFailure:continue`）
6. **不 UPDATE `prd_submit.default_pipeline_id`**（方案 A：handler 内显式 runPipeline）

**依赖**：无

**验证**：本地 pg 跑 `pnpm migrate`，查：
- `\d prd_submit_events` 表结构
- `\d dingtalk_users` 看到 `email` 列
- `\di idx_dingtalk_users_email_lower` 看到函数式索引
- `SELECT key, default_pipeline_id FROM capabilities WHERE key LIKE 'prd_%'` → 4 行，`prd_submit.default_pipeline_id` 应为 `NULL`
- `SELECT id, jsonb_array_length(stages) FROM test_pipelines WHERE id = 1893000001` → `3`

**估算**：0.2d

### M1-T2 · migrate.ts 追加 v28

✏️ [src/db/migrate.ts](src/db/migrate.ts)

改动：
- L107 后追加 `schemaV28` 读入 + `pool.query(schemaV28)` + log
- L146 尾部 log 字符串追加 `+ PRD active submit MR v28`

**依赖**：M1-T1
**验证**：`pnpm migrate` 输出 `schema-v28 applied` 字样
**估算**：0.05d

### M1-T3 · prompts.ts 常量 + system_prompt 注入

➕ [src/agent/prd-submit/prompts.ts](src/agent/prd-submit/prompts.ts) — `export const PRD_REVIEW_SYSTEM_PROMPT = '...'`（占位即可，M3-T3 填实）

✏️ [src/db/migrate.ts](src/db/migrate.ts) — L142 后仿 `create_prd` / `review_prd` 模式追加 `prd_ai_review_mr` 的两段式 UPDATE（见 migrate.ts:113-142 现有 pattern）

**依赖**：M1-T1, M1-T2
**验证**：`pnpm migrate` → `SELECT key, left(system_prompt, 60) FROM capabilities WHERE key='prd_ai_review_mr'` 非空
**估算**：0.1d

### M1-T4 · prd-submit-events repository

➕ [src/db/repositories/prd-submit-events.ts](src/db/repositories/prd-submit-events.ts)

对照 [bug-fix-events.ts](src/db/repositories/bug-fix-events.ts)（106 行）一比一同构，四个函数：
- `createEvent(input)` — `submissionId / projectPath / code / status / durationMs / data`
- `findBySubmission(submissionId)` — 按时间升序
- `findBySubmissionCode(submissionId, code)` — 同 code 全部
- `findLatest(submissionId, code)` — `ORDER BY id DESC LIMIT 1`

**依赖**：M1-T1
**验证**：`compile` + `src/__tests__/unit/prd-submit-events.test.ts` 跑 CRUD
**估算**：0.1d

**M1 验证出口**：`pnpm migrate` 全绿；`pnpm test prd-submit-events` 全绿；管理后台手动查 capabilities 列表含 4 个 `prd_*`。

---

## 3. M2 — Handler 骨架（1.0d）

**目标**：4 个 handler 注册到 capability registry + URL 解析模块，走完 pipeline 能在 `prd_submit_events` 表里落 4 行（review 是 placeholder）。

### M2-T1 · prd-submit 目录骨架 + index.ts

➕ [src/agent/prd-submit/index.ts](src/agent/prd-submit/index.ts)

```ts
export { registerPrdSubmitHandler } from './submit-handler.js'
export { registerPrdCreateMrHandler } from './create-mr-handler.js'
export { registerPrdAiReviewHandler } from './review-handler.js'
export { registerPrdNotifyHandler } from './notify-handler.js'
```

**依赖**：无
**估算**：0.05d

### M2-T2 · url-parser（URL → projectPath + branch）

➕ [src/agent/prd-submit/url-parser.ts](src/agent/prd-submit/url-parser.ts)

```ts
export interface ParsedGitlabTree {
  projectPath: string   // 例: 'PAM/devops/chatops'
  branch: string        // 例: 'prd-smoke' 或 'feat/docreview'
}

// 入: http://code.paraview.cn/PAM/devops/chatops/-/tree/prd-smoke
// 入: https://.../PAM/x/-/tree/feat/docreview?ref_type=heads
export function parseGitlabTreeUrl(url: string): ParsedGitlabTree
```

正则草案：`^https?:\/\/[^/]+\/(.+?)\/-\/tree\/(.+?)(?:[/?#].*)?$`

**单测覆盖**（`src/__tests__/unit/prd-url-parser.test.ts`）：
- ✅ 基本路径 `http://.../PAM/devops/chatops/-/tree/prd-smoke`
- ✅ 含 `/` 的分支名 `/-/tree/feat/docreview`
- ✅ 带 query `?ref_type=heads` 被剥掉
- ✅ 子组嵌套 `/PAM/group1/group2/repo/-/tree/branch`
- ❌ 非 tree URL（如 `/blob/`）→ 抛错
- ❌ 无 `/-/` 分段 → 抛错

**依赖**：无
**估算**：0.2d

### M2-T3 · submit-handler（入口）

➕ [src/agent/prd-submit/submit-handler.ts](src/agent/prd-submit/submit-handler.ts)

职责（对应 PRD §3.1）：

1. **两级解析指令**：
   - 正则：`工作地址=(\S+)\s+MR地址=(\S+)\s+MR文件=(\S+)(?:\s+标题=["""](.+?)["""])?`（`标题` 捕获组**可选**）
   - 失败 → Claude fallback 抽 JSON `{workUrl, mrUrl, mrFile, title?}`（title 允许缺）

2. **URL 解析**（调 `parseGitlabTreeUrl`）：
   - 工作地址 → `{projectPathA, sourceBranch}`
   - MR地址 → `{projectPathB, targetBranch}`
   - **跨 repo 断言**：`projectPathA !== projectPathB` → 群回"工作地址与 MR 地址必须是同一个仓库"

3. **MR文件校验**：`/^docs\/prds\/.+\.md$/.test(mrFilePath)` → 失败群回错

4. **slug / submissionId**：`slug=basename(mrFile).replace(/\.md$/,'')`；`submissionId='prd-mr-'+slug+'-'+Date.now()+'-'+nanoid(4)`

5. **authorEmail 反查**（单一路径）：
   ```sql
   SELECT email FROM dingtalk_users WHERE user_id = $1
   ```
   缺失 → 群回"未识别到你的企业邮箱"，return `{success:false}`

6. **落入口事件**：`prd_submit_requested(success, {...})`

7. **显式启动 pipeline**（`title` 可为 null）：
   ```ts
   const { runPipeline, imTrigger } = await import('../../pipeline/executor.js')
   await runPipeline(1893000001, {}, imTrigger({
     triggeredBy: opts.context.initiatorId,
     platform: opts.context.platform,
     groupId: opts.context.groupId,
     userId: opts.context.initiatorId,
     params: {
       submissionId, projectPath: projectPathA, sourceBranch, targetBranch,
       mrFilePath, title: title ?? null,   // null → stage 1 从 commit log 派生
       authorEmail,
     },
   }))
   return { success: true, output: 'PRD MR 提交中，结果将通过 DM 发送给你' }
   ```

**依赖**：M1-T4, M2-T1, M2-T2
**验证**：unit test 覆盖 a) 带标题命中 b) 不带标题命中（title 为 null）c) 正则失败→fallback 成功 d) 跨 repo 回错 e) 路径不匹配回错 f) authorEmail 缺失回错 g) runPipeline 收到 params 完整
**估算**：0.35d

### M2-T4 · create-mr-handler（stage 1：标题派生 + Draft 闸门 + 幂等复用）

➕ [src/agent/prd-submit/create-mr-handler.ts](src/agent/prd-submit/create-mr-handler.ts)
➕ [src/agent/prd-submit/mr-api.ts](src/agent/prd-submit/mr-api.ts)

**先抽 mr-api.ts 三个 helper**（供 handler + review-handler 共用）：

```ts
// 从 commit log 派生 MR 标题；失败回退 slug
export async function resolveMrTitle(
  projectPath: string,
  sourceBranch: string,
  targetBranch: string,
  override: string | null,
  slug: string,
): Promise<{ title: string; source: 'override' | 'commit' | 'fallback' }>

// 查是否已有 open MR
export async function findOpenMr(
  projectPath: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<{ iid: number; web_url: string } | null>

// 切换 Draft 状态（PUT title 加/去 'Draft: ' 前缀）
export async function setMrDraft(
  projectPath: string,
  mrIid: number,
  baseTitle: string,
  isDraft: boolean,
): Promise<void>
```

**resolveMrTitle 实现要点**：
- `override != null` → 返回 `{title:'[PRD] '+override, source:'override'}`
- 否则调 `GET /projects/{urlEncode}/repository/compare?from={targetBranch}&to={sourceBranch}`；**从尾端**找最新一个**非 fixup** 的 `title`（GitLab 返回的 commits 是时间正序——`git log from..to` 的顺序；正则过滤 `^(fixup!|squash!|wip:|WIP:)`）
- 都没有 → `{title:'[PRD] '+slug, source:'fallback'}`

**handler 流程**（对应 PRD §3.2）：

```ts
const baseTitle = (await resolveMrTitle(...)).title   // e.g. '[PRD] docs(prd): 邮箱登录方案初稿'
const existing = await findOpenMr(projectPath, sourceBranch, targetBranch)

let mrIid: number, mrUrl: string, reused: boolean, wasForceDrafted: boolean
if (existing) {
  mrIid = existing.iid
  mrUrl = existing.web_url
  reused = true
  // 关键闸门：复用时强制重置 Draft
  await setMrDraft(projectPath, mrIid, baseTitle, true)
  wasForceDrafted = true
} else {
  const mr = await gitlabCreateMr({
    projectPath, sourceBranch, targetBranch,
    title: `Draft: ${baseTitle}`,     // 新建自带 Draft 前缀
    description: `提交者: ${authorEmail}\n文件: ${mrFilePath}\nsubmissionId: ${submissionId}`,
    labels: 'prd-active-review',      // CSV 字符串
  })
  mrIid = mr.iid; mrUrl = mr.url
  reused = false; wasForceDrafted = false
}

await createEvent({
  submissionId, projectPath,
  code: 'prd_create_mr', status: 'success',
  data: { mrIid, mrUrl, reused, baseTitle, wasForceDrafted, titleSource: resolvedTitle.source },
})
```

**依赖**：M1-T4, M2-T3（数据流）
**验证**：unit 覆盖 a) 新建（Draft 前缀）b) 复用 existing + 强制 Draft PUT c) 标题派生 commit 命中 d) 标题降级到 slug e) 标题 override 生效 f) target branch 不存在 → failed
**估算**：0.3d

### M2-T5 · review-handler（stage 2，placeholder）

➕ [src/agent/prd-submit/review-handler.ts](src/agent/prd-submit/review-handler.ts)

⚠️ **M2 只做骨架**：读 `mrIid`、发一条占位评论 `🤖 AI review placeholder`，落事件 `decision: 'pass'`。真正的 Claude review 放到 M3。

**依赖**：M1-T4
**估算**：0.05d

### M2-T6 · notify-handler（stage 3）

➕ [src/agent/prd-submit/notify-handler.ts](src/agent/prd-submit/notify-handler.ts)

职责（对应 PRD §3.4）：

1. `findBySubmission(submissionId)` 拿全量事件
2. **场景判定**（passed / blocked / failed）—— **不复用** `notify_bug` 的 `shouldNotifyOwners`（三种场景全发 DM）
3. `triggerParams.authorEmail → dingtalk_users.email (LOWER) → user_id`：
   ```sql
   SELECT user_id FROM dingtalk_users WHERE LOWER(email) = LOWER($1) LIMIT 1
   ```
4. `buildPrdMessage(kind, ctx)` 生成 Markdown（参考 PRD §3.4 三份模板；含 sourceBranch/targetBranch/mrFilePath 行）
5. `PipelineApprovalManager.getInstance().adapters[0].sendDirectMessage(userId, {text})`（与 [notify-handler.ts:510-513](src/agent/notify/notify-handler.ts#L510) 的私有字段访问 hack 同模式）
6. 每步 try/catch 落事件 `prd_notify(success|failed, ...)`

**依赖**：M1-T4, M2-T1
**估算**：0.25d

### M2-T7 · 注册 handler + 扩充白名单

✏️ [src/server.ts](src/server.ts)

- L65 后追加 `import { registerPrdSubmitHandler, registerPrdCreateMrHandler, registerPrdAiReviewHandler, registerPrdNotifyHandler } from './agent/prd-submit/index.js'`
- L214 后追加 4 次 `register*Handler()` 调用

✏️ [src/agent/claude-runner.ts](src/agent/claude-runner.ts)

- L374 `HANDLER_CAPABILITIES` 集合加 `'prd_submit'`

**依赖**：M2-T3 / T4 / T5 / T6
**验证**：
- `compile` 过
- `pnpm dev` 启动后 capability registry 含 4 个 `prd_*`
- IM 手动发 `@agent 提交PRD MR ...` → 日志出现 `[Runner] Agent capability: prd_submit, routing to handler`
**估算**：0.1d

**M2 验证出口**：本地 DB + test 仓库跑一次指令，`prd_submit_events` 按序出现 4 行 status=success（review 是 placeholder），DM 到达。

---

## 4. M3 — AI Review 内核（0.7d）

**目标**：把 M2-T5 的 placeholder 替换成真 Claude review。

### M3-T1 · claude-prd-review runner

➕ [src/agent/prd-submit/claude-prd-review.ts](src/agent/prd-submit/claude-prd-review.ts)

参考 [claude-review.ts](src/agent/review/claude-review.ts) 同构，但**不 acquire worktree**（MVP 仅看 diff）：
- 入参：`{ mrDiff, systemPrompt }`
- 调 Claude CLI（`src/agent/claude-cli.ts`），**600s timeout**（stage 层 `timeoutSeconds:900` 留 300s buffer）
- **输出解析两段式**：
  1. 尝试 JSON parse → 抽取 `decision / findings / markdown`
  2. 失败 → 启发式 fallback：关键词判定 `pass|blocked`，`findings: []`，`parseFailed: true`
- 返回类型：`{ decision: 'pass'|'blocked', findings: [...], markdown: string, parseFailed?: boolean }`

**依赖**：无
**估算**：0.3d

### M3-T2 · review-handler 接真实现（含 Draft 解除）

✏️ [src/agent/prd-submit/review-handler.ts](src/agent/prd-submit/review-handler.ts)（M2-T5 的 placeholder 升级）

1. GitLab `GET /projects/{encodeURIComponent(projectPath)}/merge_requests/{mrIid}/changes` 拉 diff
2. 读 `capability.systemPrompt`（从 `capabilities` 表查 `prd_ai_review_mr.system_prompt`）
3. `runClaudePrdReview({ mrDiff, systemPrompt })`
4. 结果回写 MR 评论（复用 [gitlab-mr-note.ts](src/agent/review/gitlab-mr-note.ts) `gitlabPostMrNote`）
5. **Draft 闸门切换**（关键）：
   ```ts
   let draftCleared = false
   if (review.decision === 'pass') {
     try {
       await setMrDraft(projectPath, mrIid, baseTitle, false)   // 去 Draft 前缀
       draftCleared = true
     } catch (err) {
       console.error('[PRD review] un-draft PUT failed:', err)
       // 不抛，事件落 draftCleared=false，DM 文案会告知
     }
   }
   ```
6. 落 `prd_ai_review_mr(success, { decision, findings, noteId, parseFailed?, draftCleared })`

**依赖**：M3-T1
**估算**：0.3d（+0.05 vs v2，因为加了 un-draft 逻辑）

### M3-T3 · PRD_REVIEW_SYSTEM_PROMPT 内容

✏️ [src/agent/prd-submit/prompts.ts](src/agent/prd-submit/prompts.ts)（M1-T3 的占位换成完整 prompt）

要点：
- 输入是 MR unified diff（**不是** PRD 全文；MVP 不做跨文档一致性校验）
- **强约束输出 JSON schema**：
  ```json
  {
    "decision": "pass" | "blocked",
    "findings": [{"severity":"blocker|warning|info","title":"...","detail":"..."}],
    "markdown": "MR 评论正文（Markdown）"
  }
  ```
- prompt 首段明确"只返回裸 JSON，不要代码块围栏，不要前后文"
- `blocked` 触发条件写明：至少一条 `severity=blocker`

**依赖**：M1-T3
**估算**：0.15d

**M3 验证出口**：重跑 M2 冒烟，MR 评论显示结构化 review，`decision` 与 `findings` 能正确解析（`parseFailed` 字段正常命中 JSON 时 false）。

---

## 5. M4a — 主体冒烟（0.2d）

### M4a-T1 · 正向冒烟

**准备**：
- GitLab 仓库 `PAM/devops/chatops` 有 `prd-smoke`、`feat/docreview` 分支
- `prd-smoke` 分支 `docs/prds/test.md` 存在，最近一次 commit 信息明确（如 `docs(prd): smoke 测试`）
- 钉钉群绑定，`UPDATE dingtalk_users SET email='<提交者邮箱>' WHERE user_id='<钉钉 userId>'`

**跑**（**不带 `标题=`** 测自动派生）：
```
@agent 提交PRD MR
  工作地址=http://code.paraview.cn/PAM/devops/chatops/-/tree/prd-smoke
  MR地址=http://code.paraview.cn/PAM/devops/chatops/-/tree/feat/docreview
  MR文件=docs/prds/test.md
```

**观察**：
- `prd_submit_events` 4 行 status=success
- GitLab：MR 开出，标题**先**是 `Draft: [PRD] docs(prd): smoke 测试`，AI review pass 后**自动变成** `[PRD] docs(prd): smoke 测试`
- **Merge 按钮**：先灰（"Can't merge — this merge request is still a draft"），review pass 后变可点
- `prd-active-review` label 就位，AI review 评论就位
- 提交者钉钉单聊收到 DM，文案含 "已解除 Draft，可以合并"
- 群里不收到任何机器人消息

**估算**：0.15d

### M4a-T2 · 负向 + Draft 闸门验证

1. `MR文件=docs/other/xx.md` → 群回"MR 文件必须在 docs/prds/ 路径下..."
2. 工作地址 projectPath A / MR地址 projectPath B 不同 → 群回"必须是同一个仓库"
3. 临时删 email → 群回"未识别到你的企业邮箱"
4. `工作地址` 填不存在分支 → stage 1 failed → DM `prd_submit_failed`
5. **标题 override**：带 `标题="自定义标题"` → MR 标题 `Draft: [PRD] 自定义标题`
6. **重复提交 blocked 验证（核心闸门场景）**：
   1. 第一次跑 → review pass → MR 标题 `[PRD] ...`，Merge 可点
   2. 模拟 blocker：往 `prd-smoke` push 一个明显有问题的 commit（比如删空整个 PRD 正文），`git push`
   3. 再次 @agent → 观察：
      - MR 标题**重新**加上 `Draft:` 前缀（事件 `data.wasForceDrafted=true`）
      - Merge 按钮**再次**变灰
      - 本次 review 返回 blocked → MR 保持 Draft
   4. 再次把内容改回通过 → 第三次 @agent → MR 再次 un-draft
7. **commit log 派生降级**：把 `prd-smoke` 最近 3 个 commit 都改成 `fixup! xxx` → MR 标题回退 `[PRD] test`（slug），事件 `data.titleSource='fallback'`
8. **un-draft PUT 失败容错**：临时撤掉 GITLAB_TOKEN 的 "Maintainer" 权限 → review pass 但 PUT 失败 → 事件 `draftCleared=false`；DM 含"review 通过但解除 Draft 失败"文案

**估算**：0.15d

---

## 6. M4b — passive 合入后的可选增强（仅当 passive PRD review 未来合入 main 时触发）

**触发时机**：未来某个时刻，`src/adapters/gitlab/doc-review-handler.ts`（passive PRD review）合入 main。**在此之前本任务不做**——passive handler 不存在，就不会对本方案的 MR 产生双重 review。

### M4b-T1 · rebase 到最新 main（如有冲突）

常规 rebase；若 passive 也改了 `dingtalk_users.email` 相关 schema，靠 `IF NOT EXISTS` 的 DDL 幂等保证运行时 OK，人工确认无逻辑冲突即可。

### M4b-T2 · 补 label 短路

✏️ `src/adapters/gitlab/doc-review-handler.ts`

在 `mr.state !== 'opened'` 判定之后、`getMrChanges` 之前插 3 行：

```ts
if (mr.labels?.includes('prd-active-review')) {
  console.log(`[doc-review] MR ${projectPath}!${mrIid} 带 prd-active-review label（主动提交流程），跳过 passive review`)
  return
}
```

前置确认 `MergeRequest` 类型含 `labels: string[]`；缺失则在 `src/adapters/gitlab/mr-api.ts` 补。

### M4b-T3 · 双路径回归冒烟

1. 带 label MR：passive 早退，只主动链路 review
2. 不带 label MR：passive 照常 review
3. bug-fix 全链路重跑一次

**估算**：0.2d（可选；不影响主功能上线）

---

## 7. 任务依赖图

```
M1-T1 (schema-v28.sql)
  ├── M1-T2 (migrate.ts 追加 v28)
  │     └── M1-T3 (prompts.ts 占位 + system_prompt 注入)
  │           └── M3-T3
  └── M1-T4 (prd-submit-events repo)
        ├── M2-T3 (submit-handler)  ─┐
        ├── M2-T4 (create-mr-handler) ┤
        ├── M2-T5 (review placeholder)┤
        └── M2-T6 (notify-handler) ──┤
                                      └── M2-T7 (server.ts + 白名单)
                                            └── M4a (主体冒烟)

M2-T1 (index.ts)  # 被 M2-T7 import
M2-T2 (url-parser) ─→ M2-T3

M3-T1 (claude-prd-review) ─→ M3-T2 (review-handler 真实现)
                                  └── M4a 再跑一次

M4a 通过 → 合并 feature/prd-active-submit
passive 合入 main → M4b
```

**可并行批次**：
- A（可并行）：M1-T1、M2-T2
- B（M1-T1 后并行）：M2-T3、M2-T4、M2-T5、M2-T6
- C（串行）：M3-T1 → M3-T2

---

## 8. 提交粒度

| Commit | 对应任务 | Message |
|--------|---------|---------|
| C1 | M1-T1..T4 | `feat(prd-submit): schema-v28 + 4 capabilities + 3-stage pipeline + events repo` |
| C2 | M2-T1..T7 | `feat(prd-submit): url-parser + 4 handlers (submit/create-mr/review-placeholder/notify) + wiring` |
| C3 | M3-T1..T3 | `feat(prd-submit): claude-prd-review core + PRD_REVIEW_SYSTEM_PROMPT` |
| C4 | M4a | `docs(prd-submit): smoke manual + verification log` |
| C5 | M4b-T2 | `fix(doc-review): bypass active submission MRs via prd-active-review label` |

---

## 9. 风险检查清单（与 PRD §6 对照的开发侧）

- [ ] M1-T1 `ADD COLUMN IF NOT EXISTS email` 是幂等 DDL；若未来 passive 合入 main 引入同列，`IF NOT EXISTS` 保证无冲突（不用现在提前协调）
- [ ] M1-T1 `idx_dingtalk_users_email_lower` 是**函数式索引**（`(LOWER(email))`），普通 `(email)` 索引在 `WHERE LOWER(email)=$1` 查询里**不命中**
- [ ] M1-T1 **不能** `UPDATE capabilities SET default_pipeline_id = 1893000001 WHERE key = 'prd_submit'`（方案 A）
- [ ] M2-T2 url-parser 必须覆盖"分支名含 `/`"（如 `feat/docreview`）的用例，否则分支名被截断
- [ ] M2-T3 跨 repo / 路径正则 / email 反查三条兜底必须在 handler 内完成，不能放到 pipeline stage（stage 内拿不到 IM groupId，无法回群）
- [ ] M2-T4 `labels` 必须 CSV 字符串 `'prd-active-review'`，**不是**数组
- [ ] M2-T4 幂等复用时的 existing MR 查询只看第一页（同 source/target 不会有多个 open MR，GitLab 禁止）；**必须**加 `state=opened` 过滤
- [ ] **M2-T4 Draft 闸门核心不变量**：本 stage 结束时 MR 一定是 Draft 状态（新建默认 Draft；复用强制 PUT 回 Draft）——绝不可以跳过复用路径下的强制 Draft 逻辑
- [ ] **M2-T4 标题派生**：commit 过滤正则 `^(fixup!|squash!|wip:|WIP:)` 要测试命中；commits[] 为空时走 slug 回退；API 本身失败（非 2xx）时也走 slug 回退并记 `titleSource: 'fallback'`
- [ ] **M3-T2 un-draft 失败容错**：PUT 失败 **不抛异常**让 stage 变 failed（因为 review 本身成功），而是落 `draftCleared=false` 让 DM 告知
- [ ] M2-T6 的 `PipelineApprovalManager.getInstance().adapters[0]` 在单测环境拿不到 adapter → 单测需 mock 整个 manager
- [ ] M3-T1 Claude CLI 600s timeout 错误路径务必落 `prd_ai_review_mr(failed)`，否则 stage 3 拿不到 decision 会走 `prd_submit_failed` 分支
- [ ] M3-T3 prompt 要求 Claude 输出**裸 JSON**，不能带围栏代码块
- [ ] **confirmed before M1**: 手测 `SELECT id FROM test_pipelines WHERE id=1893000001` 返回空
- [ ] **confirmed before M2-T6**: grep `retryCount` 在 capability stage 路径是否生效；若不生效 stage 3 `retryCount:2` 承诺要降级
- [ ] **confirmed before M2-T4**: 在目标 GitLab 实例（`code.paraview.cn`）上手测 `PUT /projects/:id/merge_requests/:iid { title: 'Draft: xxx' }` 确认 MR 确实变成 Draft 且 Merge 按钮被禁用；GitLab CE 版本号记录在 dev 手记

---

## 10. 前置手检清单（开工前 30 分钟）

- [ ] `git fetch origin && git checkout -b feature/prd-active-submit origin/main`
- [ ] `pnpm install && pnpm build` 绿
- [ ] 本地 pg 有 `chatops` database；`pnpm migrate` 跑到 v26 成功
- [ ] `SELECT id FROM test_pipelines WHERE id >= 1893000001 ORDER BY id LIMIT 5` 确认号段无占用
- [ ] `grep -n "HANDLER_CAPABILITIES" src/agent/claude-runner.ts` 确认行号未变（若变动，M2-T7 的 L374 注释需更新）
- [ ] GitLab test repo 和 `GITLAB_TOKEN` / `GITLAB_URL` 就绪（M4a 需要）
- [ ] test 仓库上已推好两个分支作为 source/target，source 分支的 `docs/prds/test.md` 已提交（M4a 需要）
- [ ] 钉钉 test 群 + adapter 已配置；提交者 `dingtalk_users.email` 已回填（M4a 需要）
- [ ] **GitLab 实例 Draft 语义确认**：对 `code.paraview.cn` 版本手测一次 `PUT /projects/:id/merge_requests/:iid { title: 'Draft: xxx' }` → MR UI 显示 Draft 徽标 + Merge 按钮变灰（见 §9 最后一条）
