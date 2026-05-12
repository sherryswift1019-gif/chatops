# Spec 阶段升级设计稿 v1

> 日期：2026-05-12
> 状态：待 review
> 关联：[2026-05-11-qi-pipeline-topology-design.md](./2026-05-11-qi-pipeline-topology-design.md) v12 拓扑、[2026-05-12-reject-topology-round2-design.md](./2026-05-12-reject-topology-round2-design.md) reject 回路

## 背景

当前 QI v12 拓扑的 spec 阶段（init_branch → spec_author → spec_ai_review → spec_human_gate → spec_commit_push）与产品流程图存在 3 处实质差异：

1. **AI review 形同虚设**：[bootstrap.ts:546](../../../src/quick-impl/bootstrap.ts#L546) `spec_ai_review → spec_human_gate` 是单边直通，AI 判 fail 时不会回 spec_author 重写，notes 只是透传给人工。流程图设想的"AI 先磨 N 轮再交人工"完全没实现。
2. **人工 reject 上限不对齐**：流程图标 "拒绝 2 次后禁止"，代码 `REJECT_CAP = 3`。
3. **rawInput 到 spec 之间无澄清环节**：spec-author v3 prompt 的 clarifications 字段是 LLM 自答 + 标记 assumption，用户参与度为零。模糊需求的"假设"和"事实"边界完全交给 LLM 判断。

同时，三个相关 role（spec-author / spec-reviewer / brainstorm-host 即将新增）的规范分散在各自 role.md 内嵌，没有 single source of truth，prompt drift 风险随时间累积。

## 设计目标

- **目标 1**：在 spec_author 之前加 brainstorming 前置节点，把用户主观决策从 spec-author 的"凭空假设"变成 brainstorm 的"明示选择"。
- **目标 2**：把 AI review 做成真循环（≤3 轮自动回 spec_author），降低人工被打扰频率。
- **目标 3**：人工 reject 上限对齐流程图（2 次），且与 plan/dev 阶段同步。
- **目标 4**：建立 spec 阶段的**上下文闭环**（节点间信息复用）与**规范闭环**（共享 single source of truth）。

**非目标**：
- 不做 deferred / aborted 决策路径（中止从需求详情/列表页触发）
- 不动 plan/dev 阶段拓扑（虽然 REJECT_CAP 共享，但回路改造留到后续）
- 不做 brainstorming 历史的跨需求复用

---

## §1 拓扑变更

```
init_branch
   ↓
[NEW] spec_brainstorm   ← llm_brainstorm 节点类型，多轮 interrupt
   ↓
spec_author             ← 输入由 rawInput 改为 enrichedInput + brainstorm.md
   ↓
spec_ai_review          ← 出口由直通改为条件分支
   ├─ onSuccess  ──→ spec_human_gate
   └─ onFailure  ──→ spec_author（受 aiReviewMaxRounds 上限保护，默认 3）
                     round 3 仍 fail → 强行走 spec_human_gate，附 AI 历次 notes
spec_human_gate         ← REJECT_CAP=2，决策树仅 approved / rejected
   ├─ approved   ──→ spec_commit_push → plan_author
   └─ rejected   ──→ spec_author（计数 +1，到 2 次后 abort 需求）
```

**变更清单**：
1. 新增 `spec_brainstorm` 节点（stageType: `llm_brainstorm`）
2. 新增 LLM role：`brainstorm-host`（quick-impl-artifact-author skill 下新增 roles/brainstorm-host.md）
3. 新增 stageType `llm_brainstorm` 的 builder（`buildLlmBrainstormNode()`）
4. `spec_ai_review → spec_human_gate` 改为条件分支，新增 `spec_ai_review → spec_author` 回路边
5. `REJECT_CAP` 3 → 2（plan/dev 同步影响）
6. spec_human_gate 决策树仅保留 approved/rejected
7. 新增系统配置：`qi.aiReviewMaxRounds`（默认 3，范围 1-5）、`qi.tokenBudgetPerRequirement`（默认 250000）
8. 数据清空：所有 QI 相关执行记录（开发期产品未上线）

---

## §2 spec_brainstorm 节点

### 2.1 职责边界

brainstorm 阶段**只**收集 spec-author 用 codebase + 默认值**无法自答**的问题，即用户的**主观决策**：

| 决策类 | 例子 |
|---|---|
| 角色与入口 | 谁用、从哪里触发、是否需要权限 |
| 验收主体 | 谁来验收（可能不是触发者：触发者是运维、验收者是 PM/QA） |
| 成功信号 | "做完了" 用户最在意的可观测信号 |
| noGos | 绝对不能做 / 必须避免的 |
| 历史相似工作 | 已存在 / 曾尝试 / 已废弃的类似功能 |
| 业务窗口 | 时间约束、上下游依赖、优先级原因 |

spec-author **能 grep 自答的不问**，**能用合理默认 + clarifications.assumption 标记的不问**。

### 2.2 单轮交互形态

每一轮 LLM 输出一个**结构化 markdown 块**，包含 5 段：

```markdown
## 已查证的现状
- 我从 codebase / brainstorm 历史中查到的事实（含 file:line）

## 这一轮要决定
- 一句话点出本轮的决策焦点

## 选项（带我的推荐）
**A. 选项一** ← 推荐
  理由：...
**B. 选项二**
  理由：...
**C. 选项三**
  理由：...

## 我替你做的默认（如果你不否决就走）
- 默认 1
- 默认 2

## 你怎么回？
- 简单回 `A` / `B` / `C` 即可
- 或者：`A 但默认勾选`
- 或者：`都不对，我想要 XX`
```

**5 段质量准则**（缺一即节点 fail）：
1. **必须给"已查证的现状"** —— 让用户看到 LLM 做了功课，不是凭空问
2. **必须列选项 + 推荐 + 理由** —— 降低用户决策成本的核心
3. **必须显式声明 LLM 默认决策** —— 用户不否决即视为同意
4. **必须给自由文本兜底通道** —— 选项不全也能 escape
5. **必须给历史 Q&A 引用** —— round 2+ 时，要标注本轮基于上轮哪个决策

字数无硬限制。LLM 自判信息密度。

### 2.3 终止条件

LLM 自判 `readyForSpec=true` + 硬上限 5 轮 + 用户 `/done` 即可中断。

- `readyForSpec=true` 的判定：5 类主观决策中**适用本需求**的全部已收集（不是"全部 5 类"，而是"本需求范围内的"）。
- 5 轮硬上限：触发后节点强制收尾，把当前 enrichedInput 标 `partial=true`。
- 用户 `/done`：任意轮次发 `/done`、`结束`、`够了` 等关键词 → 立即收尾。

### 2.4 交互入口

**本迭代仅实现 Web 轨道。** 当前 QI 需求只能从需求管理页创建，IM 触发 QI 需求的能力未上线。

- **Web 轨道（本迭代实现）**：用户在 Web 需求详情页的 Brainstorm Tab 提交答案；后端走 graph-runner 多轮 interrupt 机制 resume pipeline
- **IM 轨道（预留设计，本迭代不实现）**：等"IM 触发 QI 需求"能力上线后启用；届时 IM 触发的需求 → IM 群为主轨道，Web 提交答案广播回 IM 群保证上下文完整

实现层面复用 schema-v19 的 im_input 多轮 interrupt 基建（[im-router.ts](../../../src/pipeline/im-router.ts) + [graph-builder.ts:buildImInputNode](../../../src/pipeline/graph-builder.ts)）—— Web 端调用与 IM 端调用走同一个 resume 入口，IM 路径**代码可保留但不进 E2E 验收**，等触发能力上线后再启。

用户回答格式契约：`{ chosenOption?: 'A'|'B'|'C'|...; freeText?: string }`。im-input-agent 的解析逻辑要扩展（同时支持 Web 表单结构化提交和 IM 自由文本解析），本迭代实现 Web 路径，IM 路径解析逻辑也一并实现但不通过 IM 通道触发。

### 2.5 产物

**双产物**：

```
worktree/
├── docs/brainstorm/qi-{id}.md          ← brainstorm 全文 Q&A，commit
└── docs/brainstorm/qi-{id}.json        ← enrichedInput.json，commit
```

`enrichedInput.json` schema 完整定义（zod 草稿，design 层敲定，不再外包给 qi-spec-quality.md §2）：

```typescript
const EnrichedInputSchema = z.object({
  schemaVersion: z.literal('v1'),
  rawInput: z.string(),                            // 用户原始一句话，冗余兜底

  // 5 类用户主观决策（实际填什么由 brainstorm 收集结果决定）
  actors: z.object({
    triggerer:    z.string().optional(),           // 触发者（运维/PM/QA/...）
    primaryUsers: z.array(z.string()).optional(),  // 主要使用者角色
    verifier:     z.string().optional(),           // 验收主体（R6）
  }),
  objective: z.object({
    userValue:     z.string().optional(),
    businessValue: z.string().optional(),
    successSignal: z.string().optional(),          // 最在意的可观测信号
  }),
  scope: z.object({
    in:       z.array(z.string()),
    out:      z.array(z.string()),
    deferred: z.array(z.string()).optional(),
  }),
  noGos: z.array(z.object({
    desc:   z.string(),
    reason: z.string().optional(),
  })),
  historicalRefs: z.array(z.object({
    description: z.string(),
    relation:    z.enum(['existing', 'past_attempt', 'deprecated', 'related']),
    pointer:     z.string().optional(),            // file:line / PR / commit
  })),
  businessWindow: z.object({
    deadline:     z.string().optional(),
    upstreamDeps: z.array(z.string()).optional(),
    priority:     z.enum(['critical', 'high', 'normal', 'low']).optional(),
  }).optional(),

  // brainstorm 阶段已查证的事实（spec-author 必须复用，不允许重 grep）
  codebaseEvidence: z.array(z.object({
    file:    z.string(),
    line:    z.number().optional(),
    purpose: z.string(),
  })),

  // 元信息
  conversationSummary: z.string(),                 // ≤500 字
  qaTurnCount:         z.number(),
  partial:             z.boolean(),                // brainstorm 是否未完整
  missingFields:       z.array(z.string()).optional(), // partial=true 时列出未收集字段
});
```

字段说明：
- 所有 `optional()` 字段在 partial=true 时可能不填，spec-author 必须能处理 partial
- `codebaseEvidence` 是 brainstorm → spec-author 的核心上下文复用通道，spec-author role.md 显式约束"不可重 grep 已查证目标"
- `historicalRefs.relation` 用 enum 而非自由文本，便于下游 plan-author 做去重检查
- schema 在 [src/quick-impl/enriched-input-schema.ts](../../../src/quick-impl/enriched-input-schema.ts)（实现层新建）作为三个 role 共享的 zod 定义

`stepOutputs[spec_brainstorm].output`:
```json
{
  "rounds": 3,
  "readyForSpec": true,
  "partial": false,
  "earlyDone": false,
  "enrichedInputPath": "docs/brainstorm/qi-{id}.json",
  "brainstormPath": "docs/brainstorm/qi-{id}.md"
}
```

`enrichedInput.json` 的 schema 见上方 zod 定义。`qi-spec-quality.md §2` 引用同一份 schema 作为三方共识，但**单一来源** = 上方 zod 代码 + 实现层 [src/quick-impl/enriched-input-schema.ts](../../../src/quick-impl/enriched-input-schema.ts)。

### 2.6 失败兜底

| 场景 | 处理 |
|---|---|
| 5 轮 LLM 仍拒绝收尾 | 节点强制收尾，输出 `partial=true`，spec_author 仍启动，notes warn |
| 用户 24h 不回 | 复用 im_input 基建的 interrupt 超时机制（对 Web/IM 轨道都生效）→ requirement.status='aborted'，详情页可重启 |
| 用户主动 `/done` | 收尾 + `earlyDone=true` |
| LLM 输出不符 5 段质量准则 | 节点 fail（不进下一轮 interrupt），人工兜底 |
| 5 段质量准则连续 2 次 fail | brainstorm 节点输出 `failed`，spec_author 接力（读 rawInput 启动，等同今天的行为） |

**触发优先级**：当多个失败条件同时成立时，按以下顺序判定（**质量 fail > 轮数上限**）：
1. 5 段质量准则连续 2 次 fail → 立即 `failed`
2. 用户 `/done` → `earlyDone=true`
3. 5 轮硬上限 → 强制 `partial=true` 收尾
4. 用户 24h 不回 → `aborted`（这条独立于上面 3 条，由 interrupt 超时机制直接接管，Web/IM 轨道都生效）

### 2.7 spec-author 在 partial 状态下的退化路径

**关键约束**：brainstorm 升级后 spec-author 已经把 enrichedInput 当作主要输入（不再以 rawInput 为主），因此 partial 状态**不是"等同今天的行为"**，需要显式定义退化路径。

| 输入状态 | spec-author 行为 |
|---|---|
| `partial: false` | 必须复用 enrichedInput 全部字段；**禁止重 grep 已查证目标**（codebaseEvidence 中的 file:line）；clarifications 中只允许标记 enrichedInput 之外的边角假设 |
| `partial: true` | 必须先读 `missingFields` 数组识别哪些字段缺；对每个缺失字段：(1) 优先用 codebase grep 自答，(2) 答不出则填合理默认，(3) 在 `clarifications` 中以 `kind=assumption` 显式标记，附 `userMayDisagreeIf`；**output JSON 顶层必须加 `degraded=true` 信号** |
| brainstorm 节点 `failed`（连续质量 fail） | 与今天行为等同：直接读 rawInput 启动，无 enrichedInput；output JSON 顶层加 `degraded=true` + notes warn |

spec-reviewer 看到 `degraded=true` 时，S3 检查（"clarifications 至少 1 条 kind=assumption"）的语义自动收紧——必须覆盖 missingFields 的每一条。

**实现层注意**：spec-author role.md 在升级时增加"§4 分支处理"一节明确以上 3 个状态，不能笼统说"读 enrichedInput"。

核心原则：**brainstorm 失败不阻断 pipeline**，spec_author 进入 degraded 模式继续走（详见上表），requirement.status 不进入 aborted（除非用户 24h 不回）。

---

## §3 上下文与规范双闭环

### 3.1 上下文闭环

**核心原则**：节点间信息流只走两条道——**worktree 文件**（全文 / 大块数据）和 **stepOutputs 模板插值**（轻量信号 / 决策）。

**brainstorm → spec_author**：
- brainstorm 的所有产物（enrichedInput + Q&A 原文 + 已查证的 codebase references）通过 worktree 落盘
- spec_author 启动时由 skill-runner symlink 同一份到 `.qi-context/`
- spec_author role.md 显式约束：brainstorm 已查证的 file:line **必须复用**，不允许重新 grep 同一目标；如发现 reference 错误，notes 指出（健康的 double check）

**spec_author → spec_ai_review**：
- reviewer 启动时除了拿 devOutput + spec.md 全文，再 symlink brainstorm.md + enrichedInput.json
- spec-reviewer 的 S1 检查（"AC 反向链接 rawInput"）措辞改为 "AC 反向链接 enrichedInput.objective + scope.in"，rawInput 仅作冗余兜底

**spec_ai_review round 2+ 的逐项追踪机制**（避免 spec-author / reviewer 互锁烧 token）：

当 `ai_review_round >= 2` 时，reviewer 必须把**上轮 notes 作为强约束输入**，输出格式扩展：

```typescript
type SpecReviewOutput = {
  round: number;
  decision: 'pass' | 'fail';

  // round >= 2 必填：对上轮 notes 逐项判定
  resolvedFromPrevious?: Array<{
    previousNote: string;        // 上轮原文 note
    status: 'resolved' | 'still-failing' | 'not-applicable';
    evidence: string;            // 看到了什么改动才得出此结论
  }>;

  // 本轮新发现（应该接近空，否则触发 lint warn）
  newIssues: Array<{
    severity: 'error' | 'warn';
    msg: string;
    file?: string;
  }>;

  decisionBasis: string;
  // 例："上轮 5 项中 4 项 resolved、1 项 still-failing。新发现 0 项。fail。"

  notes: Array<{...}>;            // 原有字段，等于 newIssues + 仍 fail 的上轮 notes
};
```

这个改动解决 3 种翻车模式：
1. **理解漂移**（author 改错方向）：reviewer 必须列 evidence，看到 author 改的版本，能识别"换汤不换药"
2. **Oscillation**（每轮提新问题）：newIssues 应接近空；lint 加一条 `newIssues.length > resolvedFromPrevious.length → warn`（reviewer 标准漂移）
3. **标准漂移**（reviewer 自己摇摆）：判定锚点是"上轮 N 项中 M 项 resolved"而非"我此刻觉得怎么样"

spec-reviewer role.md 升级时必须把这段逐项追踪写入"任务步骤"。

**spec → plan_author**：
- 未来 plan 阶段拓展遵循同样约定：plan_author 启动时 symlink brainstorm.md + enrichedInput.json + spec.md，**零相关上下文丢失**

**调研缓存的具体文件结构、目录命名、symlink 策略**留给实现者定，design 层不约束。

### 3.2 规范闭环

抽出一份 `docs/standards/qi-spec-quality.md` 作为三个 role 的 single source of truth：

| 章节 | 内容 |
|---|---|
| §1 产品级 spec 的最低要求 | WHO/WHAT/AC/Scope/非功能 5 维度覆盖矩阵 + 判定准则 |
| §2 enrichedInput Schema 契约 | brainstorm 产出 / spec-author 消费 / spec-reviewer 验证 三方共识的 schema |
| §3 AC 质量准则 | GWT 格式 + 可观测断言定义 + 反模式黑名单 + 反向链接强制性 |
| §4 e2eScenarios 合规标准 | 从 spec-author role.md 现有 A/B/C 节迁移过来 |
| §5 调研留痕标准 | references[] 的 file:line 必须存在 + 复用约束 |
| §6 反模式黑名单（共享） | 主观词 / 凑数 / 凭空加 AC 等共享黑名单 |
| §7 各 role 引用义务 | 哪个 role 必读哪几节 |

**role.md 同步修改**：
- brainstorm-host role.md：新文件，引用 §1 §2 §6
- spec-author role.md：删除"E2E 合规标准 A/B/C"那一段（约 60 行），改为"见 qi-spec-quality.md §4"
- spec-reviewer role.md：7 项检查每条后标注 ← qi-spec-quality.md §X 兜底

**闭环验证**：新增 `scripts/check-qi-standards-consistency.ts`，跑在 `./test.sh` 里：
- 检查三个 role.md 都引用了 qi-spec-quality.md
- 检查 qi-spec-quality.md §X 在 lint / role.md 里都被使用（无 dead chapter）
- 检查 enrichedInput schema 在 brainstorm-host 输出 / spec-author 输入 / spec-reviewer 输入 三处定义一致

---

## §4 风险与边界

### R1 计数器独立

`spec_ai_review` 用独立 counter `ai_review_round`，`spec_human_gate` 用独立 counter `human_reject_count`。

**最坏路径**：spec_author 跑 3 (AI fail 全用满) + 2 (人工 reject 全用满) + 1 (初版) = **最多 6 次**。

`requirements.retry_counters` JSONB schema 扩展：
```json
{
  "reject_counts": { "spec_human_gate": 1, "plan_human_gate": 0, "dev_human_gate": 0 },
  "ai_review_rounds": { "spec_ai_review": 2, "plan_ai_review": 0, "dev_ai_review": 0 },
  "last_reject_reasons": { "spec_author": "..." },
  "last_ai_review_notes": { "spec_author": [...] }
}
```

### R2 commit 策略（保留 round commits）

每轮 spec_author 仍调 commit_artifact（保留 audit trail）。spec_commit_push 节点在 `approved` 后**保留所有 round commits**走 merge commit 入 main：

```bash
# spec_commit_push 节点的伪代码
if approved:
  git checkout <base_branch>
  git merge --no-ff qi-<id> -m "feat(qi-<id>): spec — <最终 summary>

  - spec_author rounds: <N>
  - spec_ai_review rounds: <M>
  - human approver: <user>
  "
  # merge commit 保留 round commits 的 author 归属（用户 brainstorm / AI / 人审）
```

**为什么不 squash**：squash 会让所有 round commits 的 author 全变成机器人，丢失"用户回答 brainstorm / AI 写 spec / 人审 approved"的归属信息。audit trail 是 spec 阶段最重要的产出之一，merge commit 是保留它的最低成本方式。

git history 干净度的代价（多 N+1 个 commit）由 git 日志按需折叠工具兜底。plan/dev 阶段的 commit 策略不受影响（沿用现有）。

### R3 brainstorm 失败的两种语义

需要区分两类失败，处理不同：

- **LLM 失败**（5 段质量准则 fail / 5 轮拒收尾）：节点输出 `partial` 或 `failed`，spec_author 接力读 rawInput 启动，**pipeline 不中断**。
- **用户失败**（24h 不回 / 显式取消）：复用 im_input 基建的 interrupt 超时机制（对 Web/IM 轨道都生效），requirement.status='aborted'，详情页可手动重启。

两类失败的具体处理已在 §2.6 详述。LLM 失败的最坏路径等同今天，无回归风险。

### R4 Token budget

单需求 LLM 调用预算 `qi.tokenBudgetPerRequirement`（后台可配，默认 250000）。

实现层面：
- 每个 LLM 节点跑完写入 `pipeline_run_state.token_usage`
- 进入以下节点前都检查累计 token：**spec_brainstorm（每轮 interrupt 前）/ spec_ai_review / plan_ai_review / dev_ai_review**
- 超 budget 的处理（按节点分支）：
  - **spec_brainstorm 超 budget**：强制 readyForSpec=true 收尾，notes warn"token 超限 brainstorm 截停"；后续 spec_author 走 partial 退化路径（见 §2.7）
  - **spec_ai_review / plan_ai_review / dev_ai_review 超 budget**：跳过自循环，强制走 human_gate（附带 token 超限说明）

### R5 plan / dev 阶段 REJECT_CAP 联动

`REJECT_CAP` 从 3 改 2 会同步影响 plan_human_gate / dev_human_gate。本设计不改 plan/dev 拓扑（AI review 循环不动），仅 cap 数字变。

**确认**：用户已确认开发期数据可全清，无线上影响。

### R6 配置项的生效路径

`aiReviewMaxRounds` / `tokenBudgetPerRequirement` 在 `system_config` 表 + 后台配置页加，graph-builder 读取需要新增 `loadQiConfig()`。每次 pipeline 启动时读最新配置，不支持热更（run 中变配置对正在跑的需求无效）。

---

## §5 数据迁移

| 表 | 操作 |
|---|---|
| `requirements` | TRUNCATE |
| `requirement_approval_waiters` | TRUNCATE |
| `pipeline_runs` (qi 触发的) | TRUNCATE |
| `test_runs` (qi 触发的) | TRUNCATE |
| `pipeline_run_state` (qi 触发的) | TRUNCATE |
| `system_config` | INSERT `qi.aiReviewMaxRounds=3, qi.tokenBudgetPerRequirement=250000` |
| schema 迁移 | 新增 schema-vN.sql 加 `qi_brainstorm_sessions` 表（如需独立存历史）或仅扩展 `requirements.retry_counters` JSONB schema |

worktree 清理：删除所有 `.git/worktrees/qi-*`。

---

## §6 验收

### E2E 验收 scenario

**正常路径 (happy)**：
- 用户在 Web 需求管理页创建需求 `加个登录页`
- spec_brainstorm 在 Web 端 Brainstorm Tab 多轮问答（≥2 轮，含选项 + 推荐 + 自由文本兜底）
- 用户答完后 readyForSpec=true，落 brainstorm.md + enrichedInput.json
- spec_author 读 enrichedInput 写出 spec.md，commit
- spec_ai_review pass，走 spec_human_gate
- 人工 approved → spec_commit_push 走 merge commit（保留 round commits）→ plan_author 启动

**AI fail 回路 (negative)**：
- spec_ai_review round 1 fail（含明确 notes）
- 自动回 spec_author，round 2 重写
- spec_ai_review round 2 pass
- 后续路径同 happy

**AI review 耗尽轮数升级人工 (negative)**：
- spec_ai_review round 1 fail → 回 spec_author round 2 重写
- spec_ai_review round 2 fail（应用逐项追踪机制：reviewer 输出 `resolvedFromPrevious` 标注上轮 notes 仍 still-failing）→ 回 spec_author round 3 重写
- spec_ai_review round 3 仍 fail → 触发 aiReviewMaxRounds=3 上限，**不再回 spec_author**，强制走 spec_human_gate
- spec_human_gate 审批摘要含 AI 历次 notes + 每轮 decisionBasis（"上轮 N 项中 M 项 resolved" 累计记录），让人审能看到 AI 卡在哪
- requirement.retry_counters.ai_review_rounds.spec_ai_review = 3
- 人工 approved → 走 spec_commit_push；或人工 reject → 进入"人工 reject 上限"路径（AI / human 两个计数器独立）

**人工 reject 上限 (negative)**：
- spec_ai_review pass，进 spec_human_gate
- 人工 reject round 1 → 回 spec_author，round 2
- 人工 reject round 2 → requirement.status='aborted'，retry_counters 显示 reject_counts.spec_human_gate=2

**brainstorm 失败兜底 (negative)**：
- spec_brainstorm 5 轮 LLM 仍拒绝收尾 → 节点 partial 收尾
- spec_author 仍启动，输入用 rawInput + partial enrichedInput
- 后续路径不变

**Token budget 触发 (negative)**：
- 模拟单需求累计 token > 250k
- 第二次进入 spec_ai_review 时直接走 human_gate（带超限说明）

### 单测

- `buildLlmBrainstormNode()` 的 state machine（5 段 markdown 解析、轮数累计、readyForSpec 判定、5 轮上限）
- im-input-agent 多轮拓展（选项 ID + 自由文本解析）
- `incrementAiReviewRound()` 与 `incrementRejectCount()` 互不干扰
- `handleAiReviewFailure()` 路由逻辑（aiReviewMaxRounds 内回 author，超出走 human_gate）
- spec_commit_push 行为：保留 round commits 走 merge commit，commit author 归属信息保留

### 规范一致性

- `check-qi-standards-consistency.ts` CI 跑通
- brainstorm-host / spec-author / spec-reviewer 三份 role.md 都引用 qi-spec-quality.md

---

## §7 实现注意事项（非约束）

以下是设计层之外的实现提醒，留给执行者参考，不作设计约束：

- `buildLlmBrainstormNode()` 实现要考虑 [graph-runner.ts:resumeFromImInput](../../../src/pipeline/graph-runner.ts) 已有的 race-winner claim 机制，多轮 interrupt 不能丢消息
- 前端 BrainstormTab.tsx 是新页面，但可以复用 NodeApprovalView.tsx 的样式系统
- enrichedInput.json 的 schema 应该用 zod 定义（与项目其他 schema 一致），便于 brainstorm-host / spec-author / spec-reviewer 三处共享
- `qi-spec-quality.md` 的初版可以从 spec-author role.md / spec-reviewer role.md / qi-spec-lint.ts 三处反向抽取，不需要从零写

---

## §8 开放问题

无。所有 7 个决策点在 brainstorming 阶段已确认（见 brainstorming 对话记录）。
