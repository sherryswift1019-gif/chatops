# PRD 主动提交 MR Pipeline 能力

> **状态**: drafting（v3 — 2026-04-24：标题自动从 commit log 派生 + Draft MR 做 merge 闸门）
> **PM**: zhangshanshan
> **产品线**: PAM
> **创建时间**: 2026-04-24

---

## 1. 愿景与目标

### 1.1 愿景

让产品经理在 IM 群里一条 `@agent 提交PRD MR` 指令，把**已经 push 到 GitLab 的 PRD 文件**开成 MR + 跑 AI review + DM 告知结果。

**一句话定义**：PM 不用点 GitLab UI 开 MR、不用等 passive review 被动触发、不用手动催 reviewer，一条 IM 指令走完"开 MR → AI 审查 → DM 回报"。

**与 bug-fix 三件套（`create_mr` / `ai_review_mr` / `notify_bug`）完全同构**，形成"Bug 修复 / PRD 提交"两条对称的主动链路。

### 1.2 目标

1. **主动触发**：IM 群里 `@agent` 一条结构化指令即可启动全链路
2. **架构同构**：复用 bug-fix 的 capability + pipeline + handler + event 表四件套模式
3. **零回归**：对 bug-fix / analyze / review / mr / notify / worktree 代码不改一行
4. **与 passive PRD review 共存**：保留 schema-v27 的 `doc-review-handler`，通过 label 短路避免双重 review
5. **Review prompt 独立**：新写一份面向 MR diff 的 `PRD_REVIEW_SYSTEM_PROMPT`，不复用 passive 路径
6. **PM-friendly UX**：指令入参是"GitLab 地址栏能直接复制的 URL"，不要求 PM 理解 projectPath / 分支名等 Git 概念

### 1.3 成功指标

| 指标 | 目标值 | 度量方式 |
|------|--------|---------|
| IM 指令 → MR 创建时延 | P95 ≤ 60s | `prd_submit_events` 中 `prd_submit_requested` 与 `prd_create_mr(success)` 同 submissionId 的 created_at 差值 |
| AI review 触达率 | ≥ 98% | `prd_ai_review_mr(success)` / `prd_create_mr(success)` 同 submissionId 命中率 |
| DM 回报触达率 | ≥ 99% | `prd_notify(success)` / `prd_submit_requested` 同 submissionId 命中率 |
| bug-fix 回归 | 100% 通过 | bug-fix 相关单测全绿 + 手动全链路可用 |
| passive PRD review 零影响 | 100% | `doc-review-*` 单测全绿；未带 `prd-active-review` label 的 MR 仍触发 passive review |

> **时延指标收紧**：v1 PRD 定的 P95 ≤ 90s 包含"拉 draft + 新建分支 + commit"的 15-30s 开销；v2 砍掉 stage 1 后实测应在 60s 内。

---

## 2. 用户与场景

### 2.1 目标用户

- **产品经理（PM）**：在 IM 群里发结构化指令提交 PRD MR，替代"手动在 GitLab UI 开 MR + 找人催 review"
- **AI Reviewer**：Claude 在 MR 创建后读 diff + 给 review 评论
- **管理员**：维护 pipeline / AI review prompt / IM 群与项目绑定

### 2.2 使用场景

**约定前提**（适用于所有场景）：PM 已经把 PRD 文件 push 到 GitLab 某个"工作分支"的 `docs/prds/xxx.md` 路径下（agent **不**负责 draft 搬运，见 §2.3）。

#### 场景 1：正常提交 PRD MR

PM 已经把 PRD 写在 `PAM/devops/chatops` 仓库的 `prd-smoke` 分支 `docs/prds/auth-v2.md`，并在本地 commit、push：

```bash
git commit -m "docs(prd): 邮箱登录方案初稿"
git push
```

然后在群里发（**标题通常不用填**）：

```
@agent 提交PRD MR
  工作地址=http://code.paraview.cn/PAM/devops/chatops/-/tree/prd-smoke
  MR地址=http://code.paraview.cn/PAM/devops/chatops/-/tree/feat/docreview
  MR文件=docs/prds/auth-v2.md
```

Agent：
1. 调 GitLab compare API 取 `prd-smoke` 领先 `feat/docreview` 的最新 commit 标题 → MR 标题 `[PRD] docs(prd): 邮箱登录方案初稿`
2. 开 MR（带 **`Draft:` 前缀 → merge 按钮被 GitLab 原生禁用**）+ `prd-active-review` label
3. AI review
4. **review 通过 → 移除 Draft 前缀 → merge 解锁**；review 不通过 → 保持 Draft（**任何人都点不了 Merge 按钮**）
5. **DM 单聊**告知结果

可选覆盖：若 PM 想要自定义标题，加 `标题="..."` 即可。

#### 场景 2：Review 结果回播（DM 单聊）

- **通过**：✅ DM "PRD MR 已提交，review 通过，链接 xxx"
- **不通过**：⚠️ DM "findings 摘要 + MR 链接，请改后再 push"
- 消息格式对齐 `notify_bug`：纯 Markdown 文本，不走群、不用卡片

#### 场景 3：指令/格式/路径/邮箱兜底

以下几种情况在**当前群内**回错（唯有的走群回复的分支，因为此时没法 DM 路由）：

| 触发条件 | 群内回复 |
|---------|---------|
| 指令字段缺失或格式完全错（正则 + Claude fallback 都失败） | `格式不符，示例：@agent 提交PRD MR 工作地址=... MR地址=... MR文件=... 标题="..."` |
| 两个 URL 的 projectPath 不一致（跨 repo） | `工作地址与 MR 地址必须是同一个仓库` |
| `MR文件` 不匹配 `^docs/prds/.+\.md$` | `MR 文件必须在 docs/prds/ 路径下，且以 .md 结尾` |
| `dingtalk_users.email` 反查不到该用户 | `未识别到你的企业邮箱，请联系管理员同步通讯录` |

#### 场景 4：重复提交（同源/目的分支已有 open MR）

PM 第一次 @agent 后已开 MR（此刻假设已 un-draft，已可合并）。收到 review 意见后 `git push` 修复到同一个 `prd-smoke`，再次 @agent：
- Agent 查 GitLab 同 `source_branch + target_branch` 的 open MR → **复用**现有 `mrIid`
- **Stage 1 强制把 MR 置回 Draft 状态**（PUT 加 `Draft:` 前缀）—— 防止"上次已 un-draft、本次新 push 引入 blocker、但 MR 仍可合并"的危险窗口
- Stage 2 在现有 MR 上 POST 新的 AI review 评论（GitLab 允许多 note，等于 review 多版本历史）
- Stage 2 **pass → 重新 un-draft**；**blocked → 保持 Draft**
- 事件 `prd_create_mr.data.reused = true`
- DM 发送新一轮 review 结论 + 是否可合并状态

#### 场景 5：bug-fix 路径保持原样

任意 bug-fix capability 触发链路保持原样，`bug_fix_events` 表、worktree 目录、MR label、DM 通知都与改动前一字不差。

### 2.3 非目标

- **不做 draft 搬运**：PM 必须自己 push 文件到 `docs/prds/*.md`；agent 不做 `drafts/ → docs/prds/` 的搬运（v1 PRD 里的 `prd_commit` stage 已移除）
- **不支持跨 repo MR**：两个 URL 的 projectPath 必须一致；fork MR 不在 MVP 范围
- **不自动触发第二次 review**：PM push 新 commit 后需要**手动再 @agent 一次**；不监听 GitLab push webhook 自动重跑
- **不禁用 Approve 按钮**：GitLab CE 原生无法禁用 Approve；Merge 闸门由 Draft MR 机制承担——评审人可以 Approve 但 GitLab 会拒绝 merge，直到 AI review pass 后 agent 解除 Draft
- **不强制目标路径为 `docs/prds/`** 以外的位置（MVP 正则硬约束；要放其他路径必须改 regex）

---

## 3. 功能需求

### 3.1 IM `@agent` 指令解析 + 入口 capability `prd_submit`

**优先级**: P0

**触发指令格式**：

```
@agent 提交PRD MR 工作地址=<URL> MR地址=<URL> MR文件=<path> [标题="<title>"]
```

`标题=` **可选**：若不填，由 stage 1（`prd_create_mr`）从 GitLab compare API 取 `sourceBranch` 领先 `targetBranch` 的最新 commit 标题（见 §3.2）。

**架构路径决策**（与 bug-fix `analyze_bug → handleAnalysisComplete → runPipeline` 同构）：
- `prd_submit` **是** handler-path capability（在 [coordinator.ts:125](src/agent/coordinator.ts#L125) 注册）
- `prd_submit` **不设** `default_pipeline_id` —— 避免 [coordinator.ts:145](src/agent/coordinator.ts#L145) 的 pipeline 自动路由跳过 handler
- handler 完成 IM 解析 + URL 解析 + authorEmail 反查后，**显式调用** `runPipeline(1893000001, {}, imTrigger({..., params: triggerParams}))` 启动后续 3 stage

**前置修改**（否则走不到 handler）：
- 把 `'prd_submit'` 加入 [claude-runner.ts:374](src/agent/claude-runner.ts#L374) `HANDLER_CAPABILITIES` 白名单

**处理流程**：

1. **两级解析指令**：
   - 正则快速路径：`工作地址=(\S+)\s+MR地址=(\S+)\s+MR文件=(\S+)(?:\s+标题=["""](.+?)["""])?`（`标题` 捕获组可选）
   - 失败 → Claude fallback 抽取 JSON `{workUrl, mrUrl, mrFile, title?}`（title 允许缺）

2. **URL 解析** ——`src/agent/prd-submit/url-parser.ts` 新实现：
   ```ts
   // 入: http://code.paraview.cn/PAM/devops/chatops/-/tree/prd-smoke
   // 出: { projectPath: 'PAM/devops/chatops', branch: 'prd-smoke' }
   const RE = /^https?:\/\/[^/]+\/(.+?)\/-\/tree\/(.+?)(?:[/?#].*)?$/
   ```
   - 工作地址 → `projectPathA` + `sourceBranch`
   - MR地址 → `projectPathB` + `targetBranch`
   - **跨 repo 断言**：`projectPathA !== projectPathB` → 群回错
   - **路径容错**：若 URL 带子路径（`/-/tree/prd-smoke/docs`）或 query（`?ref_type=heads`），正则会把 `(.+?)` 非贪婪匹配到分支名。但**分支名含 `/`** 的情况（如 `feat/docreview`）需要特别测试——`(.+?)(?:[/?#].*)?$` 的非贪婪 + 末尾可选 path 理论上支持，须在 url-parser 单测里覆盖

3. **MR 文件路径校验**：
   - 正则 `^docs/prds/.+\.md$` → 失败群回错
   - 防止 PM 误把文件放在 `docs/pr/xxx.md`、`docs/prds/xxx.txt` 等路径

4. **slug / submissionId**：
   - `slug = basename(mrFilePath).replace(/\.md$/, '')`
   - `submissionId = 'prd-mr-' + slug + '-' + Date.now() + '-' + nanoid(4)`

5. **authorEmail 反查**（单一路径，`TaskContext` 无 `senderEmail` 字段）：
   ```sql
   SELECT email FROM dingtalk_users WHERE user_id = $1   -- opts.context.initiatorId
   ```
   缺失 → 群回"未识别到你的企业邮箱"，不落事件

6. **落入口事件**：
   ```
   prd_submit_events.create({
     submissionId, projectPath,
     code: 'prd_submit_requested', status: 'success',
     data: { authorEmail, imPlatform, imGroupId, sourceBranch, targetBranch, mrFilePath, rawCommand }
   })
   ```

7. **显式启动 pipeline**（准确签名）：
   ```ts
   const { runPipeline, imTrigger } = await import('../../pipeline/executor.js')
   await runPipeline(
     1893000001,
     {},
     imTrigger({
       triggeredBy: opts.context.initiatorId,
       platform: opts.context.platform,
       groupId: opts.context.groupId,
       userId: opts.context.initiatorId,
       params: {
         submissionId, projectPath, sourceBranch, targetBranch,
         mrFilePath, title: title ?? null,   // null → stage 1 从 commit log 派生
         authorEmail,
       },
     }),
   )
   return { success: true, output: `PRD MR 提交中，结果将通过 DM 发送给你` }
   ```

**验收标准**：
- 指令正确 + URL 解析 OK + 路径合法 + authorEmail 命中 → 事件落 1 行 + pipeline 启动
- `标题=` 缺省 → `triggerParams.title = null`，stage 1 自动从 commit log 派生
- 4 种兜底分支（§2.2 场景 3）各手测一次，群内回对应错文案，**不**落事件

### 3.2 Stage 1：`prd_create_mr`（直接开 MR + Draft 闸门）

**优先级**: P0

**核心职责**（三件事）：
1. 确定 MR 标题（从 `triggerParams.title` 取；缺失则从 commit log 派生）
2. 创建或复用 MR
3. **确保 MR 处于 Draft 状态**（新建默认带 `Draft:` 前缀；复用 existing 时强制 PUT 回 Draft）

**流程**：

1. **派生标题**（若 `triggerParams.title` 为 null）：
   ```
   GET /api/v4/projects/{encodeURIComponent(projectPath)}/repository/compare
       ?from={targetBranch}&to={sourceBranch}
   ```
   - 返回 `commits[]`（按时间倒序）
   - 取第一个 **非 fixup 类** commit 的 `title`（过滤 `^(fixup!|squash!|wip:|WIP:)`）
   - 都没有 → 回退到 `[PRD] ${slug}`（slug 来自 MR文件 basename）
   - 成功派生 → 最终 `baseTitle = '[PRD] ' + commitTitle`
   - 显式传入 → `baseTitle = '[PRD] ' + triggerParams.title`
   - **源 branch 无领先 commits** → GitLab compare 返回空 `commits[]`，`gitlabCreateMr` 也会失败（无 diff 不能建 MR）→ 事件 `failed`，stage 3 DM 告知

2. **幂等检查**：
   ```
   GET /api/v4/projects/{encodeURIComponent(projectPath)}/merge_requests
       ?source_branch={sourceBranch}&target_branch={targetBranch}&state=opened
   ```
   - 返回数组 length > 0 → 取第一个 `iid / web_url`，`reused = true`，进入步骤 4（强制 Draft）
   - 返回空 → 进入步骤 3（新建）

3. **新建 MR**（无 existing 时）—— 复用 [gitlab-mr.ts:31](src/agent/mr/gitlab-mr.ts#L31) `gitlabCreateMr`（**仅调用不修改**）：
   ```ts
   await gitlabCreateMr({
     projectPath,
     sourceBranch,
     targetBranch,
     title: `Draft: ${baseTitle}`,           // ← 默认 Draft
     description: `提交者: ${authorEmail}\n文件: ${mrFilePath}\nsubmissionId: ${submissionId}`,
     labels: 'prd-active-review',            // ⚠️ CSV 字符串，非数组
   })
   ```

4. **强制 Draft**（复用 existing 时的关键闸门）：
   ```
   PUT /api/v4/projects/:id/merge_requests/:iid
   body: { title: 'Draft: ' + baseTitle }
   ```
   即使上次 AI review pass 已经 un-draft 过，本次也重置回 Draft——保证新 review 失败时 merge 按钮不可点。

5. **落事件**：
   ```
   prd_create_mr(success, {
     mrIid, mrUrl, reused,
     baseTitle,          // 不含 'Draft: ' 前缀，供 stage 2 un-draft 用
     wasForceDrafted      // true 表示复用时被我们重置为 Draft
   })
   ```

**关键不变量**：本 stage 结束时，MR **一定** 处于 Draft 状态（新建是 Draft、复用被强制回 Draft）。Merge 按钮由 GitLab 原生禁用。

**验收标准**：
- 首次调用 → 新 MR 开出，标题带 `Draft: [PRD]` 前缀 + `prd-active-review` label
- 同 source/target 第二次调用 → 复用 existing mrIid，事件 `data.reused=true, wasForceDrafted=true`，且 GitLab 上 MR 标题确认有 `Draft:` 前缀
- `triggerParams.title` 缺省 → commit log 派生成功，MR 标题含 commit 首行
- 目标分支不存在 / 源 branch 无领先 commits → 事件 `failed`；stage `onFailure:continue` 让 pipeline 跑到 stage 3 发 DM
- passive `doc-review-handler` 对此 MR 不产生 review（label 短路，见 §3.5）

### 3.3 Stage 2：`prd_ai_review_mr`

**优先级**: P0

**与现有 `ai_review_mr` 的差异**（参考 [claude-review.ts](src/agent/review/claude-review.ts)，**不复用其 handler**）：

| 维度 | 现有 `ai_review_mr` | 新 `prd_ai_review_mr` |
|------|---------------------|----------------------|
| 对象 | 代码 MR（fix 分支 diff） | PRD 文档 MR（docs/prds/*.md diff） |
| worktree | ✅ acquire fix 分支让 Claude Grep/Read 全代码库 | ❌ **不用**，只看 diff（MVP 简化：PRD review 不做跨文档一致性校验） |
| 输出 | 字符串启发式解析 `ai-approved` / `ai-needs-attention` | **Claude 必须输出 JSON**：`{decision, findings, markdown}`；启发式只作 fallback |
| label 域 | `ai-approved` / `ai-needs-attention` | `pass` / `blocked`（独立枚举，不混用） |

**流程**：

1. 读 `findLatest(submissionId, 'prd_create_mr')` 拿 `mrIid` 和 `baseTitle`
2. GitLab API 拉 MR diff：`GET /projects/{encodeURIComponent(projectPath)}/merge_requests/{mrIid}/changes`
3. 调 `runClaudePrdReview({ mrDiff, systemPrompt })`；`systemPrompt` 从 `capabilities` 表读 `prd_ai_review_mr.system_prompt`
4. **JSON 解析 + 校验**：抽取 `decision / findings`；解析失败或字段缺失 → 降级用字符串启发式给出保守 `blocked` 结果 + `parseFailed: true`
5. 结果回写 MR 评论（复用 [gitlab-mr-note.ts](src/agent/review/gitlab-mr-note.ts) `gitlabPostMrNote`）
6. **Draft 闸门切换**：
   - `decision === 'pass'` → `PUT /.../merge_requests/:iid { title: baseTitle }`（去掉 `Draft:` 前缀） → merge 按钮解锁
   - `decision === 'blocked'` → **不动**（上游 stage 1 已确保 Draft 状态）→ merge 按钮保持禁用
7. 落事件 `prd_ai_review_mr(success, { decision, findings, noteId, parseFailed?, draftCleared: boolean })`
   - `draftCleared = true` 只在 pass 路径置；blocked 路径 false

**超时语义（两层）**：
- Pipeline stage `timeoutSeconds: 900`（见 §4.3）
- Claude runner `timeoutMs: 600000`（600s，对齐 [claude-review.ts:97](src/agent/review/claude-review.ts#L97)）

**验收标准**：
- review 评论出现在 MR 上
- `decision ∈ {pass, blocked}`；`blocked` 触发条件：`findings` 有 `severity==='blocker'` 条目
- **pass 路径**：GitLab MR 标题从 `Draft: [PRD] xxx` 变成 `[PRD] xxx`；MR 详情页 merge 按钮变为可点
- **blocked 路径**：MR 标题保持 `Draft:` 前缀；merge 按钮保持禁用（GitLab UI 显示 "Can't merge — this merge request is still a draft"）
- Claude 返回非 JSON → 启发式 fallback + 事件 `data.parseFailed=true`；**保守判 blocked，不 un-draft**
- Claude CLI 超时（600s）→ 事件 `failed`；stage 3 仍会发"review 超时"的 DM，MR 保持 Draft
- 重复提交场景：上一次 pass 已 un-draft 的 MR，stage 1 强制重置回 Draft；本次 review 若 blocked，MR 保持 Draft（**不会出现 un-drafted 但新 review blocked 的危险窗口**）

### 3.4 Stage 3：`prd_notify`（DM 单聊，对齐 `notify_bug`）

**优先级**: P0

**通知通道**：`adapter.sendDirectMessage(userId, {text})`，Markdown 纯文本；**不走群、不用卡片、不 @mention**。与 `notify_bug` 完全一致。

**与 `notify_bug` 的区分点**：
- **不复用** [notify-handler.ts:99](src/agent/notify/notify-handler.ts#L99) 的 `shouldNotifyOwners` 过滤——`notify_bug` 仅在修复成功类场景发 DM；`prd_notify` 三种场景（passed / blocked / failed）**全部都要 DM**
- **Adapter 获取**：复用 `PipelineApprovalManager.getInstance()` + 私有字段 `(mgr as any).adapters?.[0]` 的 hack（与 [notify-handler.ts:510-513](src/agent/notify/notify-handler.ts#L510) 同式）——记入 §6 风险表

**场景判定**（独立实现，不继承 `decideScenario`）：

| 条件 | 场景 |
|------|------|
| 所有 stage success + `decision === 'pass'` | `prd_submit_passed` |
| 所有 stage success + `decision === 'blocked'` | `prd_submit_blocked` |
| 任一 stage（含本 stage 3 之前的 1/2）failed | `prd_submit_failed` |

**接收人解析**：
- 读 `triggerParams.authorEmail`（由 §3.1 handler 反查填入）
- `SELECT user_id FROM dingtalk_users WHERE LOWER(email) = LOWER($1) LIMIT 1`
- **索引前置条件**：`dingtalk_users` 必须有 `LOWER(email)` 函数式索引（见 §4.1a）
- 映射失败 → handler 返回 `no_recipient` + 落事件 `prd_notify(failed, {reason:'no_recipient', authorEmail})`

**消息模板**：

```
// prd_submit_passed
✅ 你提交的 PRD MR 已通过 AI review，**已解除 Draft，可以合并**：
- {projectPath}: {mrUrl}
  ({sourceBranch} → {targetBranch}; 文件: {mrFilePath})

📋 AI Review 结论：✅ pass

请在 GitLab 上完成 Approve + Merge。
```

```
// prd_submit_blocked
⚠️ AI Review 发现问题，**MR 保持 Draft 状态，任何人都无法 Merge**

你提交的 PRD MR：
- {projectPath}: {mrUrl}
  ({sourceBranch} → {targetBranch}; 文件: {mrFilePath})

AI Review 结论：⚠️ blocked
Findings 摘要：{findings[0..3] 按 severity 取前 3 条}

请查看 MR 评论，修复后 push 到 {sourceBranch} 并再次 @agent 触发新一轮 review。review 通过后 agent 会自动解除 Draft。
```

```
// prd_submit_failed
🛑 PRD MR 提交失败，**MR 保持 Draft（如已创建）**

失败阶段：{failedStage}
错误：{errorMessage}
{如果已有 mrUrl，则附上}

请联系管理员或重新提交。
```

**验收标准**：
- 三种场景（passed / blocked / failed）各手测一次，DM 到达提交者本人
- `sendDirectMessage` 抛错 → stage failed + 靠 `retryCount:2` 自动重试（前提：retryCount 对 capability stage 生效，见 §6 风险表）
- `dingtalk_users` 没有对应 email → handler 返回 `no_recipient` 且不发 DM，事件表留一行记录
- 所有消息**不**含卡片、**不**含 `@mention`、**不**发到群

### 3.5 passive `doc-review-handler` 的 label 短路（M4b 补）

**优先级**: P0

在现有 passive handler 中加 3 行 label 短路：

```ts
if (mr.labels?.includes('prd-active-review')) {
  console.log(`[doc-review] MR ${projectPath}!${mrIid} 带 prd-active-review label（主动提交流程），跳过 passive review`)
  return
}
```

**前置条件**：`passive review` 合入 main 后 rebase `feature/prd-active-submit` 再补。`passive` 未合入时该文件尚不存在，本 feature 主链路不受影响。

**验收标准**：
- 带 label MR → passive handler 早退
- 不带 label MR → passive handler 行为与改动前 100% 一致（现有单测全绿）

---

## 4. 数据与事件模型

### 4.1 新增事件表 `prd_submit_events`

字段语义与 `bug_fix_events` 同构：

| 字段 | 类型 | 说明 |
|------|------|------|
| submission_id | TEXT | 一次提交的唯一 ID |
| project_path | TEXT | GitLab 项目路径 |
| code | TEXT | `prd_submit_requested` / `prd_create_mr` / `prd_ai_review_mr` / `prd_notify` （**4 种，无 `prd_commit`**）|
| status | TEXT | `success` / `failed` / `running` |
| duration_ms | INT | 耗时 |
| data | JSONB | 阶段输出 |
| created_at | TIMESTAMPTZ | |

索引：`(submission_id, created_at DESC)`、`(submission_id, code)`。

### 4.1a 前置 schema 修正：`dingtalk_users.email`

**背景**：main 的 [schema-v2.sql:61](src/db/schema-v2.sql#L61) `dingtalk_users` 表无 `email` 列。本方案的 DM 路由依赖邮箱反查 userId，所以需要补齐：

```sql
ALTER TABLE dingtalk_users ADD COLUMN IF NOT EXISTS email TEXT;
-- 函数式索引（查询用 LOWER(email)，普通 (email) 索引不命中）
CREATE INDEX IF NOT EXISTS idx_dingtalk_users_email_lower
  ON dingtalk_users (LOWER(email));
```

`IF NOT EXISTS` 是幂等 DDL——若未来其他 feature（如 passive PRD review）也需要这列，共存无冲突。

**运营 SOP**：
- 初次上线：通过钉钉 OpenAPI `user.get_by_mobile` 或管理后台批量回填 email
- 单用户补录：管理员在管理后台 `dingtalk_users` 编辑页录入
- 缺 email 时体验：提交者群内收到"未识别到你的企业邮箱"，不影响其他用户

### 4.2 新增 4 个 capability（砍掉 `prd_commit`）

| key | display_name | `default_pipeline_id` | `tool_names` | 说明 |
|-----|--------------|-----------------------|-----|------|
| `prd_submit` | PRD MR 提交（入口） | **❌ 不设** | `[]` | IM @agent 触发；handler-path，内部显式调 `runPipeline(1893000001, ...)` |
| `prd_create_mr` | PRD 创建 MR | ❌ | `[]` | 派生标题（可选 override）+ 带 `prd-active-review` label 新建 **或** 复用；**始终置 Draft** |
| `prd_ai_review_mr` | PRD AI Review | ❌ | `[]` | 读 MR diff + Claude review + 写评论（JSON 输出）；**pass 时解除 Draft** |
| `prd_notify` | PRD DM 回报 | ❌ | `[]` | 按 submissionId 汇总事件后 DM 给提交者（含 merge 状态） |

**`prd_submit` 为何不设 `default_pipeline_id`**：[coordinator.ts:145](src/agent/coordinator.ts#L145) 对有 `defaultPipelineId` 的 capability 会直接 runPipeline，**跳过 handler**——IM 指令解析必须在 handler 里完成。与 bug-fix 的 `analyze_bug` 同思路。

### 4.3 新增 Pipeline 种子（id=1893000001，3 stage）

3 个 stage：`prd_create_mr` → `prd_ai_review_mr` → `prd_notify`。

**所有 stage 的 `onFailure` 均为 `continue`**：保证 stage 3 始终汇总 events 发 DM（因硬约束要求 coordinator 零改动）。

**stages 字段结构**（JSONB）：

```json
[
  {
    "name": "PRD create MR",
    "stageType": "capability",
    "capabilityKey": "prd_create_mr",
    "timeoutSeconds": 300,
    "retryCount": 1,
    "onFailure": "continue",
    "targetRoles": [],
    "parallel": false,
    "capabilityParams": {
      "submissionId": "{{triggerParams.submissionId}}",
      "projectPath": "{{triggerParams.projectPath}}",
      "sourceBranch": "{{triggerParams.sourceBranch}}",
      "targetBranch": "{{triggerParams.targetBranch}}",
      "title": "{{triggerParams.title}}",
      "authorEmail": "{{triggerParams.authorEmail}}"
    }
  },
  {
    "name": "PRD AI review",
    "stageType": "capability",
    "capabilityKey": "prd_ai_review_mr",
    "timeoutSeconds": 900,
    "retryCount": 0,
    "onFailure": "continue",
    "targetRoles": [],
    "parallel": false,
    "capabilityParams": {
      "submissionId": "{{triggerParams.submissionId}}",
      "projectPath": "{{triggerParams.projectPath}}"
    }
  },
  {
    "name": "PRD notify",
    "stageType": "capability",
    "capabilityKey": "prd_notify",
    "timeoutSeconds": 120,
    "retryCount": 2,
    "onFailure": "continue",
    "targetRoles": [],
    "parallel": false,
    "capabilityParams": {
      "submissionId": "{{triggerParams.submissionId}}",
      "authorEmail": "{{triggerParams.authorEmail}}"
    }
  }
]
```

**模板变量能力边界**（[executor-legacy.ts:48](src/pipeline/executor-legacy.ts#L48)）：正则 `^\{\{triggerParams\.(\w+)\}\}$` 仅支持**整串单字段**替换；不支持内嵌拼接（`"PRD [{{triggerParams.title}}]"` 无效）；不支持嵌套路径；拼接类操作必须在 handler 侧完成。

**Pipeline id 选型**：`1893000001`。开工前手查 `SELECT id FROM test_pipelines WHERE id = 1893000001` 确认不撞号。

### 4.4 阶段间数据接力

`triggerParams` 放入口时已知的原始参数：
```
{
  submissionId, projectPath, sourceBranch, targetBranch,
  mrFilePath, title | null, authorEmail
}
```

> `title: null` 表示 PM 未显式传，由 stage 1 从 commit log 派生。

跨阶段产出通过 `prd_submit_events.data` 传递：

- `prd_create_mr` → `data: { mrIid, mrUrl, reused, baseTitle, wasForceDrafted }`
  - `baseTitle`：不含 `Draft:` 前缀的 title，供 stage 2 un-draft 时 PUT 用
  - `wasForceDrafted`：复用 existing MR 时是否重置了 Draft 状态
- `prd_ai_review_mr` 读 event.data.mrIid + event.data.baseTitle → `data: { decision, findings, noteId, parseFailed?, draftCleared }`
  - `draftCleared: true` 仅当 decision=pass 且 un-draft API 调用成功
- `prd_notify` 读所有 events + `triggerParams.authorEmail` → `dingtalk_users.email` 反查 userId → DM

### 4.5 Stage 内的上下文限制（硬约束）

[executor-hooks.ts:171](src/pipeline/executor-hooks.ts#L171) 调 capability 时构造**合成 context**：

```ts
context: {
  taskId: `pipeline-${ctx.runId}-stage-${ctx.stageIndex}`,
  groupId: 'pipeline',
  platform: 'pipeline',
  initiatorId: 'pipeline-executor',
  initiatorRole: 'admin',
}
```

**所有 stage 无法读 IM 上下文**（真实 groupId / platform / userId 全部丢失）。所以：
- 路由 DM 的唯一键 **只能**是 `triggerParams.authorEmail`
- 若未来想 stage 内回群（不建议），必须把 `imGroupId` 也放进 triggerParams

---

## 5. 通知通道对齐矩阵（与 `notify_bug` 对比）

| 维度 | `notify_bug` | `prd_notify` | 对齐度 |
|------|--------------|--------------|--------|
| 通道 | DM | DM | ✅ 100% |
| 消息格式 | Markdown 纯文本 | Markdown 纯文本 | ✅ 100% |
| 底层 API | `adapter.sendDirectMessage()` | 同 | ✅ 100% |
| 失败记录 | 事件表 status=failed | 同 | ✅ 100% |
| 接收人路由 | `bug_fix_events.project_path → projects.owner_id` | `triggerParams.authorEmail → dingtalk_users.email → user_id` | ⚠️ 语义同构、表不同（bug 通知 owner，PRD 通知提交者） |
| stage 重试 | `retryCount:2` | `retryCount:2` | ✅ 100% |
| coordinator 幂等补发 | 有 | **无**（硬约束 coordinator 零改动） | ❌ 妥协点 |
| 补救措施 | — | 全部 stage `onFailure:'continue'` | — |

---

## 6. 风险与兜底

| 风险 | 概率 | 影响 | 兜底 |
|------|------|------|------|
| 新 MR 触发现有 passive review 导致双重 review | 高（passive 合入后必然） | 两套结果冲突、两套通知 | §3.5 label 短路 3 行修改（M4b 补） |
| 指令格式错误 | 中 | 用户体验差 | 正则 → Claude fallback → 仍失败时群回错 |
| URL 解析歧义（子路径、query、奇葩分支名） | 中 | sourceBranch / targetBranch 错 | 强制约定"只粘贴 GitLab 浏览器的分支根 URL"；url-parser 单测覆盖 `feat/xxx` 含 `/` 的分支名、`?ref_type=heads` query |
| MR文件不在 `docs/prds/` 下 | 中 | 污染其他路径 | 正则 `^docs/prds/.+\.md$` + 群回错 |
| 两 URL 跨 repo | 中 | 语义混乱 | projectPath 一致性断言 + 群回错 |
| 同 source/target 已有 open MR | 中（重复提交时必然） | GitLab 409 | **查询现有 → 复用 `mrIid` + 强制重置 Draft**，不重复建 |
| commit log 派生标题失败（无领先 commits / 全是 fixup） | 中 | 标题异常 | 回退 `[PRD] ${slug}` + 事件 data 记录 `titleSource: 'fallback'` |
| **un-draft 后又 push blocked 内容**（重复提交但新 review 失败） | 中 | 原本可 merge 的 MR 被改坏却未锁回 | **Stage 1 强制重置 Draft**，无论新建还是 reused；Stage 2 仅 pass 才 un-draft |
| un-draft PUT API 失败（网络/权限） | 低 | pass 但 MR 仍 Draft，用户困惑 | 事件 `draftCleared=false`，DM 文案显式说"review 通过但解除 Draft 失败，请联系管理员" |
| GitLab 老版本/CE 不支持 Draft title 切换语义 | 低 | Draft 闸门失效 | 开工前手测：对 CE 16.x 验证 `PUT title:"Draft: xxx"` 会将 MR 标记为 draft 且 merge 按钮禁用 |
| 目标分支不存在 | 低 | MR 无法创建 | GitLab API 报错 → 事件 `failed` → stage 3 DM 告知 |
| 源 branch 无领先 commits | 中 | MR 无 diff，创建失败 | stage 1 failed → stage 3 DM 告知"源分支与目标分支无差异" |
| Claude CLI 超时 | 低 | review 缺失 | stage 2 `onFailure:'continue'` + stage 3 DM "review 超时"；MR 保持 Draft |
| Claude 返回非 JSON | 中 | `decision` 解析失败 | 启发式 fallback + 保守 `blocked` + 事件 `parseFailed=true`；**MR 保持 Draft**（保守安全） |
| 管理员改 `prd_ai_review_mr.system_prompt` 被 migrate 覆盖 | 低 | 手改 rollback | 两段式 UPDATE 保留 admin 编辑 |
| `dingtalk_users.email` 映射失败 | 中 | DM 发不出 | handler 返回 `no_recipient` + 事件记录；运维 SOP（§4.1a） |
| pipeline stage 1/2 失败导致 stage 3 跳过 | 中 | 用户不知道失败 | 全部 stage `onFailure:'continue'` |
| `PipelineApprovalManager.adapters` 私有字段 hack | 低 | 未来 manager 重构时 DM 失败 | 与 `notify_bug` 同模式（已承担此技术债）；建议后续抽 `getFirstImAdapter()` 公共 util 一次替换 |
| 任一 stage `failed` → 整条 run UI 显红 | 中 | 看板误读为整体失败，尽管 DM 已发 | 接受现状；admin UI 可选增强：`prd_notify=success` 时 badge 改"部分成功" |
| Capability stage 的 `retryCount` 可能不生效 | 未知 | stage 失败不重试 | **开工前确认**：grep `retryCount` 在 graph-builder / executor-hooks 是否对 capability 生效；若不生效，stage 3 "DM 失败重试 2 次"承诺要降级 |

---

## 7. 验收与发布

### 7.1 端到端冒烟

1. `pnpm migrate` → 日志包含 `schema-v28 applied` + `prd_ai_review_mr` system_prompt 注入
2. `pnpm dev`，管理后台 capability 列表出现 4 个 `prd_*` 能力、pipeline 画布显示 3 个 stage
3. **准备**：
   - GitLab 仓库 `PAM/devops/chatops` 上有 `prd-smoke` 分支与 `feat/docreview` 分支
   - `prd-smoke` 分支已推送 `docs/prds/test.md`
   - 钉钉群已绑定，提交者 `dingtalk_users.email` 已同步
4. **群里发**（不带 `标题=`，测试自动派生）：
   ```
   @agent 提交PRD MR
     工作地址=http://code.paraview.cn/PAM/devops/chatops/-/tree/prd-smoke
     MR地址=http://code.paraview.cn/PAM/devops/chatops/-/tree/feat/docreview
     MR文件=docs/prds/test.md
   ```
5. **正向观察**：
   - `prd_submit_events` 按序出现 4 行 status=success
   - GitLab：从 `prd-smoke` → `feat/docreview` 开出 MR
   - **MR 标题先是 `Draft: [PRD] <最新 commit 标题>`；AI review 通过后自动变成 `[PRD] <最新 commit 标题>`**（去掉 Draft 前缀）
   - **Merge 按钮先灰（提示 "Can't merge — this merge request is still a draft"），review 通过后变可点**
   - MR 带 `prd-active-review` label + AI review 评论
   - **提交者的钉钉单聊**收到 DM（含"已解除 Draft，可以合并"字样）；**所在群不会收到任何机器人消息**
6. **负向手测**：
   - `MR文件=docs/other/xx.md` → 群回"MR 文件必须在 docs/prds/ 路径下..."，不落事件
   - 工作地址和 MR地址跨 repo（`PAM/a/x` vs `PAM/b/y`）→ 群回"必须是同一个仓库"，不落事件
   - 临时删 `dingtalk_users.email` → 群回"未识别到你的企业邮箱"，不落事件
   - `工作地址` 填不存在的分支 → stage 1 failed、stage 2 跳过、stage 3 DM `prd_submit_failed`
   - **标题覆盖**：带 `标题="自定义标题"` → MR 标题变 `Draft: [PRD] 自定义标题`
   - **重复提交 blocked 验证**（关键——闸门不被绕过）：
     1. 第一次 @agent → review pass → MR **已 un-draft**、Merge 可点
     2. PM push 一个 blocker 内容到 `prd-smoke` → 再次 @agent
     3. 观察：MR 标题**重新**变 `Draft: [PRD] xxx`，Merge 按钮**再次被禁用**
     4. 本次 review 若 blocked → MR 保持 Draft；若又 pass → un-draft
     5. `prd_create_mr` 事件 `data.reused=true, wasForceDrafted=true`
   - **commit log 派生降级**：源分支领先 commits 全是 `fixup!`/`wip:` 前缀 → 标题回退 `[PRD] test`（slug），事件 `data.titleSource='fallback'`

### 7.2 零回归

1. bug-fix 单测全绿
2. bug-fix 全链路手测：`bug_analyze → fix_bug_l1 → create_mr → ai_review_mr → notify_bug`，确认 `bug_fix_events` 与 worktree 目录互不干扰
3. passive PRD review 单测全绿（M4b 之后）
4. M4b 后推一条**不带** `prd-active-review` label 的 MR，确认 passive handler 照常 review

### 7.3 不做的事

- 不改 `src/agent/fix/**` / `src/agent/analyze/**` / `src/agent/review/**` / `src/agent/mr/**` / `src/agent/notify/**` / `src/agent/worktree/manager.ts` / `src/agent/coordinator.ts`
- 不新增 MCP tool
- 不动 schema-v27 表结构（仅对 `doc-review-handler.ts` 加 3 行 label 短路）
- 不做 draft 搬运（PM 自己负责 push 到 `docs/prds/xxx.md`）
- 不支持跨 repo MR
- 不做群卡片通知（DM 单聊为唯一回报通道；唯一例外是 §2.2 场景 3 的格式/路径/邮箱兜底，此时因无 DM 目标只能回群）
- 不自动监听 GitLab push webhook 触发重新 review（必须 PM 手动 @agent）
- 不做 Draft MR 锁 + approval gate unlock
- 不做 coordinator 级别的幂等补发

---

## 8. 里程碑

| 阶段 | 产出 | 估算 |
|------|------|------|
| M0 准备 | 在最新 `origin/main` 上起 branch `feature/prd-active-submit`；本地 pg `pnpm migrate` 跑到 v26 | 0.1d |
| M1 DB + capability | schema-v28（新事件表 + `dingtalk_users.email` + 4 capability + 3-stage pipeline）+ migrate 追加 | 0.4d |
| M2 Handler 骨架 | `src/agent/prd-submit/**` 4 handler + url-parser + 标题派生 + Draft 闸门 + server.ts + claude-runner.ts 白名单 | 1.2d |
| M3 Review 内核 | `claude-prd-review.ts` + `PRD_REVIEW_SYSTEM_PROMPT` + MR note 回写 + pass 时 un-draft + JSON 解析 fallback | 0.8d |
| M4a 主体冒烟 | 端到端手测 + Draft 切换双路径验证 | 0.3d |
| M4b（可选，推迟） | 未来 passive PRD review 合入 main 后再加 label 短路 3 行 | 0.2d |
| **合计（M0~M4a 即可上线）** | | **2.8d** |

> **关于 M0**：本方案 100% 复用 bug-fix 已建好的 IM 基建（adapter / intent / coordinator / DM / 事件表模式），M0 不涉及任何迁移或基建搭建，只是"checkout 最新 main + 起 branch"的例行动作。
>
> **关于 M4b**：main 当前没有 passive `doc-review-handler.ts`，不存在"双重 review"问题。M4b 是**未来 passive 合入 main 时的增量维护**，**不是本次上线必须项**。核心交付是 M0~M4a = 2.8d。

---

## 9. 附录：开发落点说明

### 9.1 分支策略

- 从最新 `origin/main` 起 branch `feature/prd-active-submit`——就是普通的 feature 分支，不涉及与其他在途分支的协调
- §3.5 label 短路**不在本次 scope 内**：main 当前没有 passive `doc-review-handler.ts`，短路无目标文件；未来 passive 合入 main 时作为可选增量再补 3 行（见里程碑 M4b）

### 9.2 模块拆分

**新增**：

| 文件 | 职责 |
|------|------|
| `src/agent/prd-submit/index.ts` | 统一 import + 4 次 `registerCapabilityHandler()` |
| `src/agent/prd-submit/url-parser.ts` | `parseGitlabTreeUrl(url) → { projectPath, branch }` + 跨 repo 校验 |
| `src/agent/prd-submit/submit-handler.ts` | `prd_submit`：指令解析（含可选 `标题=`）+ URL 解析 + 路径校验 + authorEmail 反查 + 显式 `runPipeline(1893000001, {}, imTrigger(...))` |
| `src/agent/prd-submit/create-mr-handler.ts` | `prd_create_mr`：**标题派生**（commit log compare API）+ 新建/复用 MR + **始终置 Draft**；labels 用 CSV 字符串 |
| `src/agent/prd-submit/review-handler.ts` | `prd_ai_review_mr`：review + **pass 时 un-draft (PUT title 去 Draft: 前缀)** |
| `src/agent/prd-submit/notify-handler.ts` | `prd_notify`（**不**复用 `shouldNotifyOwners`；消息含 merge 状态） |
| `src/agent/prd-submit/claude-prd-review.ts` | Claude review runner，JSON 输出 + 启发式 fallback |
| `src/agent/prd-submit/prompts.ts` | `PRD_REVIEW_SYSTEM_PROMPT`（明确 JSON schema） |
| `src/agent/prd-submit/mr-api.ts` | 封装 `resolveMrTitle / findOpenMr / setMrDraft(iid, isDraft)` 三个 GitLab API helper |
| `src/db/schema-v28.sql` | 新表 + `dingtalk_users.email` 列 + 函数式索引 + 4 capability + pipeline 种子 |
| `src/db/repositories/prd-submit-events.ts` | `createEvent / findBySubmission / findBySubmissionCode / findLatest` |

**已从 v1 移除**（砍 `prd_commit` 的直接收益）：
- ~~`src/agent/prd-submit/commit-handler.ts`~~
- ~~`src/agent/prd-submit/branch.ts`~~
- ~~`src/agent/prd-submit/gitlab-file.ts`~~

**现有文件修改**：

| 文件 | 改动 |
|------|------|
| [src/agent/claude-runner.ts](src/agent/claude-runner.ts) | L374 `HANDLER_CAPABILITIES` 集合加 `'prd_submit'`（前置条件） |
| [src/server.ts](src/server.ts) | import + 4 次 `register*Handler()` 调用（参考 L61-65 / L211-214） |
| [src/db/migrate.ts](src/db/migrate.ts) | 追加 v28 执行 + `prd_ai_review_mr` system_prompt 两段式 UPDATE |
| [src/adapters/gitlab/doc-review-handler.ts](src/adapters/gitlab/doc-review-handler.ts) | §3.5 label 短路 3 行（passive 合入 main 后 M4b 补） |
