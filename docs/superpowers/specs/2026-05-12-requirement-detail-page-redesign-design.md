# 需求详情页 UI 重新设计

**日期**：2026-05-12
**作者**：sherryswift1019@gmail.com
**状态**：待审阅

## 背景

当前需求详情通过 Drawer（宽度 640px）展示，存在四类问题：

1. **信息密度低**：8 行 `Descriptions column={1}` 一行一项，标题/状态/GitLab/分支单独占行，要滚很久才看到关键内容（spec、审批、节点执行）
2. **层级扁平**：原始输入、Spec、审批记录、E2E、节点执行平铺，没有"现在最该看什么"的视觉引导
3. **节点执行展示不全**：当前只显示 `status / type / duration / error`，但 v2 stage_results 已含 `skillOutput / specCoverage / commits / reviewHints / acDiff` 等结构化字段，全部塞在 DecideModal 里看，平时不可见
4. **抽屉宽度限制**：v2 结构化输出 + spec markdown + plan markdown + 节点 timeline + 审批 timeline 同时展示，640px 不够；从 IM 卡片跳转还要走"列表 → 抽屉"两跳

## 目标

把详情从抽屉升级为**独立页 `/requirements/:id`**，按"全局操作 / 当前焦点 / 详细内容"三层信息架构重新组织，不改后端 API、不改 DB。

## 非目标

- 不改后端 API（现有 `requirementsApi.get` 字段够用）
- 不改 DB schema
- 不动 IM 适配器和审批后端逻辑
- 不做 mobile 响应式（管理后台桌面优先）
- 不改造新建/编辑 Modal（沿用列表页）
- 不引入 SSE / WebSocket（轮询足够）

## 路由

| 旧 URL | 新 URL | 说明 |
|---|---|---|
| `/requirements` | `/requirements` | 列表页（保留） |
| `/requirements?id=N` | `/requirements/N` | 详情，列表点击行跳转 |
| `/requirements?id=N&openWaiter=M` | `/requirements/N?openWaiter=M` | IM 审批卡片现链接，**保留兼容** |
| — | `/requirements/N?tab=spec` | Tab 持久化，刷新不丢、可分享 |

**兼容策略**：列表页 mount 时检测 `?id=N` query → `navigate('/requirements/N' + 其余 query, { replace: true })`。IM 现有审批卡链接零改动。

`tab` query 合法值：`nodes`（默认）/ `spec` / `plan` / `approvals`。非法值降级为默认。

## 整体布局

```
┌──────────────────────────────────────────────────────────────────────┐
│ Header (fixed top, height ≈ 140px)                                   │
│  ← 需求 #1 — 登录页面优化                          [开发中]          │
│  ●──●──⟳──○──○──○──○                                                 │
│ Init Spec Plan Dev Review E2E MR                                     │
│  [运行]  [中止]                            上次更新 3s 前  [⟳ 刷新]  │
├──────────────────────────┬───────────────────────────────────────────┤
│ 左栏 sticky 380px        │ 右栏 flex                                 │
│  焦点卡（条件）          │  [节点执行] [Spec] [Plan] [审批历史]      │
│  元信息卡                │  ─────────────────────────────            │
│  原始输入卡              │  节点 timeline / Spec / Plan / Waiters    │
└──────────────────────────┴───────────────────────────────────────────┘
```

## 状态显示策略：前端推导 effectiveStatus

### 背景

后端 `RequirementStatus` 枚举 13 个值，但存在三类问题：
- **死状态**：`reviewing` / `aborting` 在 grep 全仓库无人 `setRequirementStatus` 调用，列在枚举但永远不出现
- **语义错位**：`spec_review` 实际含义不是"审核中"而是"整个 Spec 阶段"（Init 完成 / spec_author 完成时设置，持续到 plan_author 进入）；`developing` 同样（dev_author 完成时设，覆盖整个 Dev 阶段子节点）
- **粒度太粗**：用户看到 `developing` 徽章无法分辨是 `dev_author` / `dev_ai_review` / `dev_human_gate` 中的哪个节点。"审批中 / review 中"这种用户最关心的细分完全看不到。

另一个事实：DB 列 `current_stage` 存在、API 已返回 `currentStage: string | null`，**但代码里从来没人写它**（grep 全仓库 `setRequirementStatus` 调用第 3 参数全是 null）。

不动后端 schema / 不动状态机的前提下，**前端从 `stageResults + waiters` 推导出 UI 友好的细粒度状态**。

### 派生函数

输入 `RequirementDetailDTO`，输出 `{ label: string; color: string; tone: 'default'|'processing'|'success'|'warning'|'error' }`。

按优先级派生：

```
function effectiveStatus(detail):
  // 1. 终态优先（draft / queued / merged / aborted / failed） → 直接用原 STATUS_CONFIG
  if status in ('draft','queued','merged','aborted','failed'):
    return STATUS_CONFIG[status]

  // 2. 有 pending waiter → "等审批" 细分
  pending = waiters.find(!claimedBy && claimedBy !== 'system')
  if pending:
    switch (pending.approvalKind):
      'spec' → { label: 'Spec 等你决策', color: 'gold', tone: 'warning' }
      'plan' → { label: 'Plan 等你决策', color: 'gold', tone: 'warning' }
      'dev'  → { label: 'Dev 等你决策', color: 'gold', tone: 'warning' }
      'final' → { label: '最终审批 等你决策', color: 'gold', tone: 'warning' }
      'qi_e2e_intervention' → { label: 'E2E 失败 等人工介入', color: 'orange', tone: 'warning' }
      'qi_sandbox_failed' → { label: 'Sandbox 失败 等介入', color: 'orange', tone: 'warning' }
      'human_gate' → { label: '等你决策', color: 'gold', tone: 'warning' }
      'escalation' → { label: 'AI 升级 等决策', color: 'gold', tone: 'warning' }

  // 3. 有 running 节点 → 按节点细分
  running = stageResults.find(s => s.status === 'running')
  if running:
    return NODE_RUNNING_LABEL[running.name] ?? STATUS_CONFIG[status]

  // 4. 兜底
  return STATUS_CONFIG[status]
```

### NODE_RUNNING_LABEL 映射

| 节点 name | 派生 label | color |
|---|---|---|
| `init_branch` | 初始化分支中 | default |
| `spec_author` | Spec 生成中 | cyan |
| `spec_ai_review` | Spec AI 审查中 | cyan |
| `spec_commit_push` | Spec 提交中 | cyan |
| `plan_author` | Plan 生成中 | purple |
| `plan_ai_review` | Plan AI 审查中 | purple |
| `plan_commit_push` | Plan 提交中 | purple |
| `dev_author` | Dev 编码中 | blue |
| `dev_ai_review` | Dev AI 审查中 | blue |
| `dev_push` | Dev 推送中 | blue |
| `qi_e2e_runner` | E2E 测试中 | geekblue |
| `dev_fix_author` | E2E 失败修复中 | orange |
| `dev_fix_ai_review` | 修复 AI 审查中 | orange |
| `mr_create` | 创建 MR 中 | lime |
| `cleanup` | 清理中 | default |
| 其它未列出节点 | 兜底原 STATUS_CONFIG | — |

实现位置：[web/src/pages/requirement-detail/effectiveStatus.ts](web/src/pages/requirement-detail/effectiveStatus.ts)（新增），导出 `effectiveStatus(detail)` + 节点 label 表。建议带 unit test 覆盖 4 个分支。

### 视觉示例

```
[Spec 生成中]      ← 当 spec_author running
[Spec AI 审查中]   ← 当 spec_ai_review running
[Spec 等你决策]    ← 当 spec_human_gate 有 pending waiter
[Plan 生成中]      ← 当 plan_author running
[Dev 等你决策]     ← 当 dev_human_gate 有 pending waiter
[E2E 测试中]       ← 当 qi_e2e_runner running
[E2E 失败 等人工介入] ← 当 e2e_im_intervention 有 pending waiter
[已合入]            ← merged
```

### 列表页同步

`/requirements` 列表页的状态列也用 `effectiveStatus` 派生（同一函数），保证列表 ↔ 详情 状态展示一致。

## Header（顶部 fixed）

**职责**：流水线整体进度可视化 + 全局操作。

### 字段
- 标题行：`← 返回 · 需求 #N — {title}` + 状态徽章（**effectiveStatus 派生**）
- Stepper 7 段：Init / Spec / Plan / Dev / Review / E2E / MR
- 操作按钮：`[运行]`（仅 draft）/ `[中止]`（仅 STOPPABLE_STATUSES）
- 右侧：`上次更新 Xs 前` + `[⟳ 刷新]`

### 不在 Header 的入口
- **审批决策**：只在左栏焦点卡 —— 决策需要上下文（kind / round / 等待时长 / 来源），按钮承载不了
- **从失败重试**：只在节点 timeline 失败节点旁 —— 失败可定位到具体节点，节点级 retry (`requirementsApi.retryFromNode`) 比整 run retry 更精准
- **GitLab / 分支信息**：放左栏元信息卡，Header 不重复展示

### Stepper 阶段映射

22 个节点按 name 前缀映射到 7 段：

| Stepper 段 | 节点 name 前缀 / id |
|---|---|
| Init | `init_branch` |
| Spec | `spec_author / spec_ai_review / spec_human_gate / spec_commit_push` |
| Plan | `plan_author / plan_ai_review / plan_human_gate / plan_commit_push` |
| Dev | `dev_author / dev_ai_review / dev_human_gate / dev_push` |
| Review | `final_review / final_approval`（如有）|
| E2E | `qi_e2e_runner / e2e_*` |
| MR | `mr_create / mr_open` |

**实现注意**：前后端共享映射表 [src/pipeline/qi-stage-map.ts](src/pipeline/qi-stage-map.ts)（新增），前端通过 import 复用。具体节点 name 列表在实现阶段 grep `src/pipeline/graph-builder*.ts` 拿到 ground truth 后填充；映射表导出 `mapNodeNameToStage(name: string): StepperStage | null`。

### Stepper 状态算法

按段计算（不是按单节点）：

```
function stageStatus(stage, allNodeResults):
  nodes = allNodeResults.filter(n => mapNodeNameToStage(n.name) === stage)
  non_skipped = nodes.filter(n => n.status !== 'skipped')

  if non_skipped.empty:           return 'pending'       // 全 skipped 或无节点
  if non_skipped.any(failed):     return 'failed'        // 红色 X
  if non_skipped.any(running):    return 'running'       // 蓝色旋转
  if non_skipped.any(waiting):    return 'running'
  if non_skipped.all(success):    return 'done'          // 绿色实心
  if non_skipped.any(success):    return 'running'       // 部分 success = 进行中
  return 'pending'                                        // 全 pending → 未开始
```

注意：
- `skipped` 节点**不参与判定**（视作未发生）—— 一段含 success + skipped + pending 时按 success + pending 判定，结果是 'running'
- `skipE2E === true` 时 E2E 段渲染为灰色斜纹「已跳过」chip，跳过算法判定（不调用 stageStatus，直接渲染 skipped 视觉）

### Hover 交互

- hover stepper 一段 → Tooltip 列出该段子节点状态（如 `spec_author: success / spec_ai_review: running / spec_human_gate: pending / spec_commit_push: pending`）
- 点击 stepper 段 → 滚动右栏节点 timeline 到该段第一个节点（scroll into view）

## 左栏 Sticky（380px）

`position: sticky; top: 140px`，独立内部滚动。三张卡纵向堆叠：

### 焦点卡（条件渲染）

仅当 `activePendingWaiter` 存在时显示。

```
┌────────────────────────────────┐
│ ⚠ 待你决策                     │
│ ──────────────────────────     │
│ Spec 评审 · 第 2 轮            │
│ 已等待 24 分钟                 │
│ 钉钉群已推送                   │
│                                │
│ [前往决策 →]                   │
└────────────────────────────────┘
```

样式：
- 1px 实线边框 `#faad14`，背景 `#FFFBE6`
- 顶部 `⚠` 图标 + 「待你决策」黑色加粗
- waiter kind label 用现有 `KIND_LABEL`，round 后缀 `· 第 N 轮`
- 等待时长复用现有 `formatRelativeDuration`
- 来源标识：`imPlatform + imGroupId` 非空 → `{platform} 群已推送`；否则 `仅 web 端可决策`
- 主按钮 `type='primary'`，点击 → 弹 DecideModal（沿用现有，从 RequirementsPage 抽出）

业务约束：同一 requirement 同时只可能存在一个 active pending waiter，所以不会出现"多张焦点卡"。

### 元信息卡

```
┌────────────────────────────────┐
│ 元信息                         │
│ ──────────────────────────     │
│ GitLab     sherryswift1019…/   │
│              chatops           │
│ 基础分支    main               │
│ 功能分支    feat/qi-1          │
│ E2E        已跳过（橙 tag）    │
│ Pipeline   #1                  │
│ 创建       2026-05-12 17:19    │
│ 创建者      admin              │
│ 中止原因    …（仅 aborted/     │
│              failed 时，红字） │
└────────────────────────────────┘
```

布局：2 列紧凑（label 90px / value flex），label 灰色右对齐，value 黑色左对齐。无 border、无 bordered。

字段顺序固定，条件字段：
- `branch` 为 null → 功能分支整行不渲染（draft 状态尚未创建分支时）
- `pipelineRunId` 为 null → Pipeline 整行不渲染
- `skipE2E === false` → E2E 整行不渲染
- `abortReason` 非空 → 中止原因行展示，否则不渲染

### 原始输入卡

```
┌────────────────────────────────┐
│ 原始输入            [展开/折叠]│
│ ──────────────────────────     │
│ 登录页 /login 新增「记住用户   │
│ 名」Checkbox                   │
│ （默认 clamp 3 行 + 渐变遮罩） │
└────────────────────────────────┘
```

- `WebkitLineClamp: 3 + overflow: hidden`
- 展开按钮文案：`展开` ↔ `折叠`
- 文本长度 ≤ 100 字符直接全展开，不显示展开按钮
- `whiteSpace: pre-wrap` 保留用户输入的换行

## 右栏 Tab

四个 Tab，状态写进 URL `?tab=`，默认 `nodes`。

### Tab 切换行为
- 点 Tab → `setSearchParams({ tab: 'spec' }, { replace: true })`
- 采用 `replace: true`（**不**写浏览器后退栈）—— 用户在 Tab 间切换不该污染后退键，按后退应直接回列表页
- 刷新页面 → 从 URL 读 tab 恢复

### Tab 1：节点执行（默认）

竖向 timeline，每个节点变可点击展开行。基于现有 [web/src/components/StageResultsTimeline.tsx](web/src/components/StageResultsTimeline.tsx) 增强。

#### 节点行（折叠状态）
```
●  Spec Author              success    2.5m   [▼]
●  Spec AI Review           success    2.9m   [▼]
●  Plan Author              running    …      [▲ 默认展开]
○  Plan AI Review           pending
```

- 左侧状态圆点（沿用现有 STATUS_META 配色）
- 节点 displayName（沿用现有 nodeNameMap.get(name) ?? name）
- status tag
- duration
- 右侧展开/折叠 chevron

#### 节点行（展开状态）

按节点 type 分发：

| 节点 type | 展开内容 |
|---|---|
| `llm_author` | V2StructuredView（acceptanceCriteria / clarifications / risks / reviewHints / acDiff / standardsConsulted / selfCheck）|
| `llm_review` | V2StructuredView（specCoverage / scopeViolations / fileRisks / reviewHints）|
| `git_commit_push` | commits 列表（sha / message / tsc / vitest）+ Spec/Plan 快照（如该节点产物是 spec/plan 文档）|
| `human_gate` | 对应 waiter 的决策展示（决策值 / 决策人 / 时间 / 拒绝原因 / budget delta）|
| `qi_e2e_runner` | 内嵌现有 `<QiE2eProgress stageResults={[sr]} />`（注：当前 QiE2eProgress 接收的是 stageResults 数组而非单节点，实现时按需调整接口或筛选传入数组）|
| 其它（init/mr_*/notify 等）| `sr.output`（文本）+ `sr.error`（如有）|

#### 自动展开规则
- `status === 'failed'` → **默认展开 + 红色左边框** + 「从此节点重试」按钮（沿用现有 `Popconfirm` + `requirementsApi.retryFromNode`）
- `status === 'running'` → 默认展开 + 蓝色脉冲动画（圆点 SyncOutlined spin）
- 其它状态 → 默认折叠

#### 展开状态持久化
- 用 `useState<Set<string>>` 存展开的节点 name
- detail 轮询刷新后 **保留** 用户展开状态（不随 detail 状态改变）
- 自动展开的 failed/running 节点：如果用户主动折叠了，下次 detail 刷新**不再强制展开**（用户意图优先）
  - 实现：另维护一个 `Set<string>` "已自动展开过的节点"，已在该集合的节点不再触发自动展开

#### Skipped 节点折叠

沿用现有 toggle 设计：底部 `跳过节点 N 个 [显示/隐藏]`，默认隐藏。展示时灰色置底。

### Tab 2：Spec

```
┌────────────────────────────────────────────┐
│ Spec                              [📋 复制] │
│ ──────────────────────────────────────     │
│ # 登录页"记住用户名"功能                  │
│                                            │
│ ## 验收标准                                │
│ ...                                        │
└────────────────────────────────────────────┘
```

- 数据源：`detail.specContent`（最终版，永远 latest）
- 渲染：现有 `<MarkdownViewer source={detail.specContent} />`
- 无高度限制，自然撑开
- 右上「复制」按钮：复制原始 markdown 文本到剪贴板，`message.success('已复制')`
- `specContent` 为 null → 显示「Spec 尚未生成」+ 当前阶段提示

### Tab 3：Plan

同 Spec Tab 结构，数据源 `detail.planContent`，无内容时显示「Plan 尚未生成」。

### Tab 4：审批历史

复用现有 `WaiterTimeline` 组件，展示完整 `detail.waiters` 列表（含 pending + claimed）。

区别于焦点卡：
- 焦点卡 = 当前等待决策（仅 1 个）
- 审批历史 = 所有轮次审批（含已决策 + pending），按时间顺序

`WaiterTimeline` 组件抽离至 [web/src/components/WaiterTimeline.tsx](web/src/components/WaiterTimeline.tsx)，不改逻辑。

## DecideModal

- 沿用 RequirementsPage 现有实现，从 RequirementsPage 抽出到 [web/src/components/DecideModal.tsx](web/src/components/DecideModal.tsx)
- 入参：`{ open, waiter, requirementId, detail, onClose, onDecided }`
- 触发点：
  - 左栏焦点卡按钮
  - URL `?openWaiter=M` 自动弹（兼容 IM 卡片直跳链接）
- 决策成功后：onDecided callback → 父组件重新 fetch detail + 清掉 `?openWaiter` query
- Modal 打开时**暂停轮询**（避免决策途中数据被替换导致 form / V2StructuredView 错乱）

## 刷新机制

### 触发条件

| 场景 | 行为 |
|---|---|
| 页面 mount | 立刻拉一次 |
| 运行中状态（`queued / spec_review / planning / developing / reviewing / testing / mr_pending / mr_open / aborting`）| 每 5 秒自动轮询 |
| 终态（`draft / merged / aborted / failed`）| 停止轮询 |
| 浏览器 tab 切走（`document.visibilityState !== 'visible'`）| 暂停轮询 |
| 切回当前 tab | 立即拉一次 + 恢复 5s 节奏 |
| 用户操作（运行 / 中止 / 节点重试 / 决策）| 操作完成后立即拉，不等 5s |
| 用户点右上角刷新按钮 | 立即拉 + 重置 5s 计时 |
| DecideModal 打开 | 暂停轮询，关闭时恢复 |

### 实现要点

- 用 `useEffect + setInterval`，cleanup 时 clearInterval
- visibility 监听：`document.addEventListener('visibilitychange', ...)`
- 上次更新时间：`useState<Date>`，render 时计算相对时间，每 1s 触发一次相对时间重渲染（轻量 setState({} as never) 或 useRef + forceUpdate；不增加网络请求）
- 5s 硬编码，不可配（简单可预期）

### 不会闪烁 / 不丢展开

- `detail` 是单一 useState，setDetail 触发 React diff，未变化的子树不重渲
- 节点展开状态用单独 `Set<string>` 维护，按节点 `name` 索引（而不是数组 index），轮询替换 detail 数组顺序变化也不丢
- DecideModal 内部 form 是 Antd Form 管理，detail 变化不重置 form
- MarkdownViewer 接收 source string，相同 string 引用不变 → 不重渲染（实现注意：specContent 是从 detail 解构，需要稳定引用 / 或 MarkdownViewer 内部 memo）

## 字段清单（Field Catalog）

实现时按区域逐项落字段，避免漏字段或多展示无关字段。

### Header 区

| 字段 | 数据源 | 显示条件 |
|---|---|---|
| 返回箭头 | — | 必显示，点击 → `navigate('/requirements')` |
| 标题 | `detail.title` | `需求 #${detail.id} — ${detail.title}` |
| 状态徽章 | **`effectiveStatus(detail)`**（派生）| 必显示 |
| Stepper 7 段 | `detail.stageResults` + `qi-stage-map.ts` | 必显示，按 stageStatus 算法上色 |
| 「运行」按钮 | — | 仅 `status === 'draft'` |
| 「中止」按钮 | — | 仅 status ∈ STOPPABLE_STATUSES |
| 「上次更新 Xs 前」| 客户端 `useState<Date>(lastFetchedAt)` | 必显示 |
| 「⟳ 刷新」按钮 | — | 必显示 |

注意：**没有**「审批决策」「从失败重试」按钮 — 已分别移至左栏焦点卡 / 节点 timeline 失败节点旁。

### 左栏 · 焦点卡（条件渲染）

显示条件：`detail.waiters.find(w => !w.claimedBy && w.claimedBy !== 'system')` 存在。

| 字段 | 数据源 |
|---|---|
| ⚠ 图标 + 「待你决策」标题 | — |
| 审批类型 | `KIND_LABEL[waiter.approvalKind]` |
| 第几轮 | `waiter.round`，渲染为 `· 第 N 轮` |
| 等待时长 | `formatRelativeDuration(waiter.createdAt)` |
| 来源 | `waiter.imPlatform + imGroupId` 非空 → `{platform} 群已推送`；否则 `仅 web 端可决策` |
| 「前往决策 →」按钮 | — |

### 左栏 · 元信息卡

| 字段 | 数据源 | 显示条件 |
|---|---|---|
| GitLab | `detail.gitlabProject` | 必显示 |
| 基础分支 | `detail.baseBranch` | 必显示 |
| 功能分支 | `detail.branch` | `branch !== null`（draft 状态尚未创建时隐藏）|
| E2E | 「已跳过」橙 Tag | `skipE2E === true` |
| Pipeline Run | `#${detail.pipelineRunId}` | `pipelineRunId !== null` |
| MR | `detail.mrUrl`（外链）| `mrUrl !== null` |
| 创建时间 | `formatDateTime(detail.createdAt)` | 必显示 |
| 创建者 | `detail.createdBy ?? '—'` | 必显示 |
| 中止原因 | `detail.abortReason`（红字）| `abortReason !== null` |

样式：2 列紧凑（label 90px / value flex），无 bordered，比 Antd Descriptions 节省 50% 垂直空间。

### 左栏 · 原始输入卡

| 字段 | 数据源 |
|---|---|
| 标题「原始输入」+ 展开/折叠按钮 | — |
| 内容（默认 clamp 3 行 + 渐变遮罩）| `detail.rawInput` |

短文本 ≤ 100 字符直接全展开，不显示展开按钮。`white-space: pre-wrap` 保留换行。

### 右栏 · 节点执行 Tab（默认）

**节点行（折叠态）字段**：

| 字段 | 数据源 |
|---|---|
| 状态圆点 | `stageResult.status` → STATUS_META |
| 节点 displayName | `nodeNameMap.get(name) ?? name` |
| status Tag | `stageResult.status` |
| 类型副标 | `stageResult.type`（小灰字）|
| 耗时 | `fmtDuration(durationMs)` |
| 展开/折叠 chevron | UI state（Set\<string\>）|

**节点行展开内容**（按 `stageResult.type` 分发）：

| type | 展开字段 | 组件 |
|---|---|---|
| `llm_author` | `skillOutput.acceptanceCriteria` / `clarifications` / `risks` / `reviewHints` / `noGos` / `openQuestions` / `acDiff`；`evidence.standardsConsulted` / `selfCheck` | V2StructuredView |
| `llm_review` | `skillOutput.specCoverage` / `scopeViolations` / `fileRisks` / `reviewHints`；`skillOutput.summary` / `decision` | V2StructuredView |
| `git_commit_push` | `skillOutput.commits[]`（sha / message / tsc / vitest / round / isFix）+ `output` 文本 | NodeCommitsView |
| `human_gate` | 找到对应 waiter，展示 `decision` / `decidedBy` / `claimedAt` / `rejectReason` / `budgetDelta` / `citedAiNotes` | NodeApprovalView |
| `qi_e2e_runner` | 内嵌 `<QiE2eProgress stageResults={[sr]} />` | QiE2eProgress |
| `mr_create` | `output` 文本（含 MR URL）+ `mr_url` 高亮链接 | NodeOutputView |
| `init_qi_branch` | `output` 文本（含 branch / worktreePath / bareRepoPath）| NodeOutputView |
| `switch` / `cleanup` / `end` | `output` 文本 | NodeOutputView |
| `im_input` | `output.collected`（用户回填字段）+ `output.decision`（如有）| NodeOutputView |
| 未识别 type | `output` 文本兜底 + `error`（如有）| NodeOutputView |

**失败节点附加渲染**：
- 红色左边框（`border-left: 3px solid #ff4d4f`）
- `error` 全文（而非 120 字符截断）
- 「从此节点重试」按钮 → `requirementsApi.retryFromNode(detail.id, sr.name)`

**Skipped 节点**：默认折叠到底部 `跳过节点 N 个 [显示]`，沿用现有 toggle。

### 右栏 · Spec Tab

| 字段 | 数据源 | 备注 |
|---|---|---|
| Markdown 全文 | `detail.specContent` | `<MarkdownViewer source={specContent} />` |
| 「📋 复制」按钮 | — | 复制原始 markdown 文本 |
| 空态 | — | `specContent === null` → 「Spec 尚未生成」 |

### 右栏 · Plan Tab

同 Spec Tab，数据源 `detail.planContent`，空态文案「Plan 尚未生成」。

### 右栏 · 审批历史 Tab

| 字段 | 数据源 |
|---|---|
| Waiters timeline | `detail.waiters`（沿用 WaiterTimeline 组件内置过滤：`claimedBy !== 'system'`）|

### 不在详情页展示的字段

后端 `RequirementDetailDTO` 中以下字段**不在详情页 UI 展示**：
- `worktreePath` — 内部实现细节
- `retryCounters` — 系统内部状态（可在 dev console 看，不放 UI）
- `source` — 已隐含于"创建者"显示（im / web / api 用户不需要区分）
- `updatedAt` / `completedAt` — `createdAt` 已够用，过多时间戳干扰阅读
- `currentStage` (DB 字段) — 始终为 null，无信息
- `planContent` 的字段虽然展示但要注意：API 已返回这字段但**实际很多 run 不会落库**（看 plan_commit_push 节点是否落 detail.planContent，实现时需 grep `quick-impl/worker.ts` 或 `mergeStageResults` 看 spec/plan content 怎么被设置）



### 新增文件

```
web/src/pages/RequirementDetailPage.tsx       (主页面，~200 行)
web/src/pages/requirement-detail/
  DetailHeader.tsx                            (顶部条 + stepper + 操作)
  ProgressStepper.tsx                         (7 段 stepper 组件)
  DetailSidebar.tsx                           (左栏容器)
  PendingWaiterCard.tsx                       (焦点卡)
  MetaInfoCard.tsx                            (元信息卡)
  RawInputCard.tsx                            (原始输入卡)
  DetailTabs.tsx                              (Tab 容器 + URL 同步)
  NodesTab.tsx                                (节点执行 Tab)
  NodeRow.tsx                                 (节点行折叠/展开)
  NodeExpandedDetail.tsx                      (按 type 分发展开内容)
  NodeCommitsView.tsx                         (git_commit_push 节点展开)
  NodeApprovalView.tsx                        (human_gate 节点展开)
  NodeOutputView.tsx                          (init/mr/switch 等节点 output 展开)
  SpecTab.tsx
  PlanTab.tsx
  ApprovalsTab.tsx
  usePolling.ts                               (5s 轮询 hook)
  qi-stage-map.ts                             (节点 name → stepper 段)
  effectiveStatus.ts                          (status 派生函数 + NODE_RUNNING_LABEL)
```

### 抽离至 components/（详情页 + 列表页 + DecideModal 共用）

```
web/src/components/V2StructuredView.tsx       (从 RequirementsPage 抽出)
web/src/components/WaiterTimeline.tsx         (从 RequirementsPage 抽出)
web/src/components/DecideModal.tsx            (从 RequirementsPage 抽出)
```

### 修改

**[web/src/pages/RequirementsPage.tsx](web/src/pages/RequirementsPage.tsx)**：
- 删除 `Drawer` 整段渲染（约 150 行，行号 962-1107）
- 删除 `DecideModal` 渲染（搬到 DetailPage / DecideModal 组件）
- 删除 `V2StructuredView` 函数定义（搬至 components/）
- 删除 `WaiterTimeline` 函数定义（搬至 components/）
- 删除 `openDetail / detailOpen / detail / detailLoading` 等抽屉相关 state
- 删除 `openDecide / handleDecide / planEscalationOptions / decideState / decideForm` 等审批相关 state（搬到 DecideModal）
- 列表行点击改 `navigate(\`/requirements/${row.id}\`)`，标题列 Button 也跳路由
- 顶部抽屉的 useEffect（处理 `?id=N` 和 `?openWaiter=M`）改为重定向逻辑：检测到 `?id=N` → `navigate(\`/requirements/${id}${preserveQuery}\`, { replace: true })`
- 保留：新建 / 编辑 Modal、行级运行/编辑/停止/删除操作

**[web/src/App.tsx](web/src/App.tsx)**：
- 新增路由 `<Route path="/requirements/:id" element={<RequirementDetailPage />} />`

### 不动的文件

- 所有后端代码（`src/`）
- `web/src/api/requirements.ts`（API 客户端不变）
- `web/src/components/StageResultsTimeline.tsx`（NodeRow 内部复用 STATUS_META 等常量，但本组件保留不动给可能的其它调用方）
- `web/src/pages/QiE2eProgress.tsx`（被 NodeExpandedDetail 内嵌使用）
- `web/src/components/MarkdownViewer`
- `web/src/pages/requirements-helpers.ts`（findStageForWaiter / KIND_LABEL / buildDecisionModalTitle / buildDecisionOptions 等）

## 错误状态与边缘

| 场景 | 行为 |
|---|---|
| `/requirements/abc`（非数字 id）| 显示「无效的需求 ID」+ 返回列表按钮 |
| `/requirements/9999`（不存在）| API 404 → 显示「需求不存在或已被删除」+ 返回列表按钮 |
| `?openWaiter=M` 但 M 不存在 / 已 claim | 不弹 Modal，清掉 query（沿用现有逻辑）|
| 轮询失败（网络错误）| 静默重试下一轮，不弹 message.error。连续 3 次失败 → 右上角变红字「连接异常」|
| `detail.stageResults === null`（流水线未启动）| 节点 Tab 显示「流水线尚未启动，点「运行」开始」|
| `skipE2E === true` 且 E2E 段无节点 | stepper E2E 段显示灰色斜纹「已跳过」chip |
| 节点 name 不在 qi-stage-map 映射 | 节点正常显示在 timeline，但不影响任何 stepper 段计算（视作未分类）|

## 实施顺序

按依赖顺序拆 6 个独立 commit，每个可单独 review、可单独跑通：

1. **抽离共用组件 + effectiveStatus**：V2StructuredView / WaiterTimeline / DecideModal 三个文件搬到 components/；新增 [web/src/pages/requirement-detail/effectiveStatus.ts](web/src/pages/requirement-detail/effectiveStatus.ts)；列表页状态列接 effectiveStatus（详情页之前列表先获得细粒度状态展示）。Drawer 渲染暂保留，业务零变化。
2. **新建 RequirementDetailPage 骨架**：路由 + 数据加载 + Header（含 effectiveStatus 徽章 + stepper 占位）+ 左右栏空容器 + 轮询 hook，不渲染任何业务卡片。访问 `/requirements/1` 能看到标题和状态徽章。
3. **左栏三卡 + 焦点卡决策入口**：PendingWaiterCard / MetaInfoCard / RawInputCard，焦点卡接 DecideModal。
4. **右栏 Tab 容器 + 节点执行 Tab**：DetailTabs / NodesTab / NodeRow / NodeExpandedDetail + 各 type 的子组件 + 节点重试。
5. **右栏剩余 Tab + Stepper 接入**：SpecTab / PlanTab / ApprovalsTab；Header stepper 接 `qi-stage-map.ts` 真实映射。
6. **列表页瘦身**：删除 Drawer 和审批 Modal，列表行点击改路由跳转，旧 query 兼容重定向。

## 验收标准

1. 路由 `/requirements/N` 可访问、展示标题 + effectiveStatus 徽章 + 7 段 stepper
2. effectiveStatus 在不同场景下展示正确：spec_author running → `Spec 生成中`；spec_human_gate 有 pending waiter → `Spec 等你决策`；merged → `已合入`
3. 列表页状态列也用 effectiveStatus 展示细粒度状态
4. Stepper 状态判定符合"全部子节点 success 才标已完成"
5. 左栏在有 pending waiter 时显示焦点卡，点按钮弹 DecideModal，决策成功后焦点卡消失
6. 节点 timeline 中失败节点默认展开 + 红边框 + 「从此节点重试」按钮可工作
7. 节点 timeline 中 llm_author / llm_review 节点展开能看到 V2StructuredView
8. Tab 切换写入 URL，刷新页面保留当前 Tab
9. 运行中状态 5s 轮询节点状态变化，DecideModal 打开时暂停轮询
10. IM 审批卡片旧链接 `/requirements?id=N&openWaiter=M` 自动 301 到 `/requirements/N?openWaiter=M` 并弹 Modal
11. 列表页 Drawer 完全移除，列表行点击跳详情页
12. 浏览器 tab 切走暂停轮询，切回立即拉一次

## 风险与开放问题

- **节点 name 映射准确性**：22 节点全名列表需在实现阶段 grep `src/pipeline/graph-builder*.ts` 确认。若 graph-builder 后续改名，需同步更新 `qi-stage-map.ts`。建议加 unit test 保证映射完整性（test fixture = graph-builder 当前节点列表，断言每个节点都能映射到 stepper 段或显式标注为「未分类」）。
- **节点 type 字段枚举**：`V2StageResult.type` 是 `string` 类型，实际值需在实现阶段 grep 后端 `src/pipeline/graph-builder*.ts` 拿到完整枚举（llm_author / llm_review / git_commit_push / human_gate / qi_e2e_runner / init_qi_branch / mr_create 等）后写进 NodeExpandedDetail 的 switch。未识别的 type 降级为「output 文本展示」。
- **MarkdownViewer 性能**：长 Spec / Plan 文档 + 5s 轮询可能触发不必要的重渲染。如果实测有卡顿，给 MarkdownViewer 加 React.memo + 自定义 比较函数（source string 相等就不重渲）。
- **DecideModal 抽离后的副作用**：原 DecideModal 用了 RequirementsPage 的多个 state / form。抽离时需保证：(1) `planEscalationOptions` 跟随 `decideState.waiter.contextSummary` 重算；(2) `selectedDecision = Form.useWatch('decision', decideForm)` 仍工作；(3) form.resetFields 在 open 切换时触发。

## 不在本设计中

- 列表页本身的改造（筛选 / 排序 / 列调整）
- 新建 / 编辑 Modal 表单字段调整
- 后端 API 变更
- SSE / WebSocket 实时推送
