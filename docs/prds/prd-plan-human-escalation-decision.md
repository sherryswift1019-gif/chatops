# PRD：plan_human_escalation 人审决策模型

> 2026-05-09 起草。本文回答前置问题：**人审被叫醒时，他的认知任务是什么 / 他应该做什么 / 系统要支持哪些路径**。
>
> 与 [todo-plan-escalation-redesign.md](todo-plan-escalation-redesign.md) 的关系：那份解决"通知体里看不到 AI notes"等 3 个**实现 bug**（#4 / #6 / #7）；本文解决**产品定义问题**——人审界面、决策选项、后续路径在产品语义上该长什么样。两份配套，本文是上层定义，那份是下层修复。

---

## 1. 一句话目标

让被升级到的人审在 **1 分钟内**做出"批 / 拒（plan）/ 拒（spec）/ 终止"的正确分流，不用翻 spec.md / plan.md / AI notes 自己拼信息。

---

## 2. 人审被叫醒时的死锁分类

stage 2 `plan_review_loop` 在 maxRounds=2 用尽后升级到本节点。死锁可能来自 5 种根本不同原因：

| # | 死锁原因 | 真因层 | 正确动作 | 当前流程支持？ |
|---|---|---|---|---|
| A | AI reviewer 抠 nitpick，plan 其实够用 | reviewer 太严 | **批准** | ✅ |
| B | plan-decomposer 改不到点上 | plan 层 | **拒绝 + 给 plan 字段级指导** | 部分（reject 是自由文本）|
| C | spec 本身有歧义 / 矛盾 | spec 层 | **拒绝 + 升级到 spec-author 重写** | ❌ **无路径** |
| D | 这种需求 AI 整体能力不够 | 模型局限 | **终止 → 转人工拆** | abort 可用但语义糊 |
| E | 文件 / 引用对不上 | 环境问题 | **重跑** | abort 后人重启 |

**关键发现**：A 是最常见 case（应当 1 分钟内决策），C 当前**没有专属路径**——人审拒绝后只能让 plan-decomposer round++，但锅在 spec 时再拆几轮也没用。

---

## 3. 人审的认知决策树（Q1 → Q2 → Q3）

```
                  Q1：AI 拒绝是真问题还是 nitpick？
                    │
                    ├── nitpick ─────────────► 批准 → dev_with_review_loop
                    │
                    └── blocker
                            │
                            Q2：锅在 plan 还是 spec？
                            │
                            ├── plan 锅
                            │     │
                            │     Q3：能给字段级反馈？
                            │     │
                            │     ├── 能 ─► 拒绝(plan) + targetTaskId + reason
                            │     │           ↓
                            │     │       plan-decomposer round++（拿真实反馈）
                            │     │
                            │     └── 不能 ─► 回 Q2 重判
                            │
                            ├── spec 锅 ─► 拒绝(spec) + reason
                            │                ↓
                            │            spec-author round++（pipeline 倒回 stage 1）
                            │
                            └── 都不是（D/E） ─► 终止 + 注明原因
```

每个判断对应**输入信息**和**5 秒动作**：

| 判断 | 输入 | 5 秒动作 |
|---|---|---|
| Q1 | AI reviewer 最后一轮 notes（按 severity 排前 3）| 扫一眼是否任意一条 dev-loop 一定撞墙 |
| Q2 | spec.md 链接 + plan.md 链接 + AI notes 关联到的字段 | 判断 reviewer 的反对是 plan 字段错还是 spec 自相矛盾 |
| Q3 | plan.tasks[] 列表 + AI 引用的 task ID | 能不能指出"哪个 task 哪个字段该改成什么" |

---

## 4. 决策 → 系统动作映射

新增 / 修改的决策语义：

| 决策值（新）| 对应当前 | 后续路径 |
|---|---|---|
| `approved` | 同 | 进 `dev_with_review_loop` |
| `rejected_plan` | 当前 `rejected` | round++，plan-decomposer 跑，feedback = AI notes + 人 reason + targetTaskId |
| `rejected_spec` | **新增** | pipeline 倒回 `spec_review_loop`（spec-author round++），feedback = 人 reason；plan 阶段重置 |
| `aborted` | 同 | requirement → aborted，pipeline 终结 |

去掉 `force_passed`（历史遗留，与 `approved` 重复）。

`budget_extended` 保留（加预算延一轮决策时间，不算决策本身）。

---

## 5. 界面设计（3 屏）

### 屏 1：5 秒判 nitpick vs blocker

```
plan 已被 AI 拒绝 2 轮，AI 给出的核心理由：
─────────────────────────────────────
[error] T2.coverAC 缺 AC-3，spec.AC-3 无任务覆盖
[error] T1.files 缺 src/__tests__/fixtures/health.json
[warn]  T3.doneWhen[1] '功能正常' 无可验断言

当前 plan：4 个任务 / 估 320 LOC / 覆盖 6/7 AC
─────────────────────────────────────
 [批准（AI nitpick）]   [拒绝（真有问题）]   [终止]
```

- 通知体顶部直接列 AI 最后一轮 notes 前 3 条（severity 降序）
- 大按钮三选一并列，不藏折叠

### 屏 2：拒绝时分流（点"拒绝"才出现）

```
问题在哪？
○ Plan 层（让 plan-decomposer 重拆）
○ Spec 层（让 spec-author 重写需求）
○ 我说不准（终止此次拆解，需手工介入）
```

每选项对应 §4 表里的决策值。"我说不准" → aborted。

### 屏 3：plan 层时给字段级反馈

```
针对哪个 task？
[T1] [T2] [T3] [T4]  [全局问题]

具体反馈（建议引用 AI notes 之一）：
[文本框 + "引用 AI notes" 快捷按钮]
```

输出结构化：`{ targetTaskId: 'T2'|null, reason: string, citedAiNotes: string[] }`，下游 plan-decomposer round 2 能精准消费。

### 折叠区（按需深读）

- AI reviewer 全部 notes（不只前 3）
- 当前 plan.md 全文 + 上一版 plan diff
- spec.md 链接

---

## 6. 系统层 gap 清单

| # | 任务 | 已有 PRD 覆盖 | 本 PRD 新增 |
|---|---|---|---|
| 1 | AI notes 在通知体可见 | ✅ todo #6 | |
| 2 | 通知体精简结构化（5 段）| ✅ todo step 5 | |
| 3 | stage 3 round 1 不重跑 skill | ✅ todo #4 | |
| 4 | priorReviewerNotes 不再空 | ✅ todo #7 | |
| 5 | decisionSet 加 `plan_escalation`（4 选 1）| | ✅ |
| 6 | spec 升级路径（rejected_spec → 倒回 stage 1）| | ✅ |
| 7 | 字段级反馈结构化（targetTaskId + citedAiNotes）| | ✅ |
| 8 | 人审界面 3 屏化（钉钉卡片 + Web Modal）| | ✅ |

---

## 7. 实施顺序（依赖图）

```
[前置：todo PRD]
   step 1（修 #6 stepOutputs）
   step 2（修 #4 skipFirstSkill）
   step 3（plan v3 摘要 builder，拼 AI notes 进通知体）
       │
       ▼
[本 PRD]
   step 4（decisionSet 升级 + Web/IM 三选一按钮）   ◄── §4 §5
   step 5（spec 升级路径 wiring）                  ◄── §6 #6
   step 6（字段级反馈表单 + plan-decomposer round 2 消费）  ◄── §6 #7
       │
       ▼
[A/B 实验]
   step 7（lean plan-decomposer + 升级 plan-reviewer）
```

**为什么是这个顺序**：
- step 1-3 是 todo PRD 已识别的实现 bug，不修这些人审看不到 AI notes，§5 屏 1 信息不全
- step 4 解锁 §3 决策树的真实路径（不只是 binary）
- step 5 解决"spec 锅没路径"这个 §2 表 C 行的 gap
- step 6 让 plan-decomposer round 2 拿到结构化反馈
- step 7 lean planner 砍自检后必须依赖更可信的 reviewer 和更明确的人审反馈，所以放最后做 A/B

---

## 8. 待确认设计点

1. **Q1 的判定权重**：AI notes 中 error 数 ≥ 1 自动建议"拒绝"还是仍由人决定？（建议后者，避免把 AI 误判变成 UI 默认动作）
2. **rejected_spec 路径的影响**：spec-author round 2 需要拿到"plan 阶段为什么拒"的反馈作为 feedback.md。当前 spec-author 的 feedback 只用于 spec round 之间，跨阶段反馈格式要不要专设？
3. **targetTaskId 是必填还是选填**：必填会强制人审定位，但有"全局问题"（如任务粒度整体错）时反而不便。建议选填 + "全局问题" 选项。
4. **maxRounds 重新定义**：本节点 `maxRounds=3` 在新模型下是"人审决策次数 ≤ 3"。每次 rejected_plan / rejected_spec 都消耗 1 round？还是 rejected_spec 不消耗（因为是 spec 阶段的事，人审已尽职）？
5. **abort 时 requirement 状态**：当前直接 `aborted`。是否应留"待手工拆解"状态便于后续接管？
6. **多人审场景**：approverIds 多人时，是否需要任一即可（当前行为）还是必须共识？

---

## 9. 测试矩阵

| 场景 | 验收点 |
|---|---|
| Q1 判 nitpick → approve | 进 dev_with_review_loop；run 状态 success |
| Q2 判 plan 锅 → reject_plan + targetTaskId | round++，plan-decomposer 拿到 `{ targetTaskId, citedAiNotes, reason }`；新 plan diff 真改了 target task |
| Q2 判 spec 锅 → reject_spec | pipeline 倒回 stage 1，spec-author round 2，feedback.md 含人审 reason |
| Q1=blocker + Q2=不确定 → abort | requirement → aborted；run 终结 |
| 通知体含 AI notes（前置 step 1-3 验收点） | contextSummary 字符串含 "AI Reviewer 拒绝原因" 段 + 至少 1 条 note |
| maxRounds=3 用尽 | 最后一轮 reject 后 stage failed；error message 含 "max_rounds_exceeded" + 最后一轮 reason |

---

## 10. 度量

| 指标 | 健康值 | 用途 |
|---|---|---|
| 人审决策时间 P50 | < 60s | 验证屏 1 信息密度足够 |
| 误批率（approve 后 dev-loop fail） | < 10% | 验证 nitpick 判断准 |
| 误拒率（reject 后下轮 reviewer 反而 pass） | < 10% | 验证 blocker 判断准 |
| rejected_spec 占总拒绝比 | 5%-30% | 太低说明 §2 C 行被掩盖；太高说明 spec-author 自身质量低 |
| abort 占比 | < 10% | 太高说明系统能力边界明显，要么改善 planner，要么收紧适用范围 |

---

## 11. 启动会话时的输入示例

> 我要按 docs/prds/prd-plan-human-escalation-decision.md §7 的实施顺序做。前置 step 1-3 已在 todo-plan-escalation-redesign.md 跟踪；先做 step 4（decisionSet 升级 + UI 三选一按钮），改 src/approval/types.ts + skill_with_approval 节点、Web/IM 卡片，加 1 个 e2e 集成测覆盖三种 reject 决策值。
