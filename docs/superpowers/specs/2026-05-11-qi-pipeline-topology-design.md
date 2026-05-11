# Quick-Impl Pipeline Topology 重设计

> Brainstorm 时间：2026-05-11
> 输入：[docs/qi-workflow-audit.md](../../qi-workflow-audit.md)
> 范围：非 E2E 部分节点拓扑定稿 + 标准 stage type 抽象；E2E 内部拆分占位（后续单独 brainstorm）

## 1. 目标

把 [Quick-Impl 工作流梳理](../../qi-workflow-audit.md) 中识别的「设计不一致」「严重 bug」「架构层 gap」的根因
（节点职责混杂、失败兜底不均、retry 颗粒度过粗、git push 时机集中、状态机分散、hack 节点充斥）一次性消除，
建立一份「最合理的 pipeline」契约。

不在本次范围内：
- E2E 节点内部如何拆（保留单一占位节点 `e2e_placeholder`，下次单独议）
- Sandbox 由 docker-compose 改 VM 的方案（独立议题）
- 状态机单源（LangGraph checkpoint + DB 三源同步策略，独立议题）

## 2. 设计原则

### 2.1 节点单一职责（拆 author / ai_review / human_gate / commit_push）

skill_with_review / skill_with_approval 两个复合节点拆为独立节点：

- `llm_author`：LLM 生成 artifact，**不 commit**（dev 阶段为内嵌 TDD 例外，详 §5.3）
- `llm_review`：独立 LLM 审 artifact，输出 pass / fail + notes
- `human_gate`：人工 binary 批准，含 timeout + escalation 规则
- `git_commit_push`：幂等 git add + commit + push

理由：审计 §2.2 / §2.3 指出 skill_with_review 内 maxRounds 循环对外不可见、retry 颗粒度过粗、
"两套 dev 配置漂移"。每个节点单一职责后，checkpoint 粒度细化到节点级，可独立 retry/replay/观测。

### 2.2 循环用图边表达

AI review fail → 边路由回 author（round++）；超 maxRounds → 边路由到 `human_gate`（带
`source: ai_escalation` 入边上下文）。不在节点内部跑 while loop。

理由：节点内多轮 LLM 对调用者不可见，checkpoint 不能跨轮恢复（审计 §2.2 "interrupt registry 跟
checkpoint 状态不一致"）。

### 2.3 每阶段里程碑 push GitLab

每个 phase（spec / plan / dev / e2e）通过 ai_review + human_gate 后跟一个 `git_commit_push` 节点，
push 到 origin/feat/qi-N。branch_init 阶段也 push 一个空占位 commit 让远端可见。

理由：审计 §2.6 "仅 mr_create push 导致整个流程对 GitLab 隐身"；用户期望 "每节点产出有 git 痕迹"。

### 2.4 Human gate 可配置

每个 LLM 阶段后的 `human_gate` 节点在 pipeline 定义里声明：

```yaml
phases:
  spec:
    human_gate: required   # 总要人审
  plan:
    human_gate: on_fail    # 只在 AI review fail 时走人审
  dev:
    human_gate: on_fail
  final:
    human_gate: required
```

`on_fail` 时 ai_review pass 边绕过 human_gate 直连 commit_push；ai_review N-fail 时统一回 human_gate
（带 `source: ai_escalation` 上下文），不再有独立 `_human_escalation` 节点。

理由：审计 §3 "失败兜底分布不均" + §4-A.1 "onFailure 三种值混用没有统一规则"。模式标准化、可配置，
人审永远是 AI 失败时的兜底，不可关。escalation 跟 gate 决策类型一致（approve/reject）+ 下游路由一致
（approve → commit_push，reject → author），合为单节点 + 入边带上下文。

### 2.5 节点级独立 retry

新增 admin API `POST /admin/requirements/:id/stages/:stage/retry`，可从任意节点重起。后端改 LangGraph
checkpoint 的 currentNode + clear downstream state，重新调度。

理由：审计 §4-C.9 "graph 终态后无法从单节点重起"。

### 2.6 onFailure 默认规则统一

- 基础设施节点（branch_init / git_commit_push / mr_create / cleanup）：`stop`
- 业务 LLM 节点（llm_author / llm_review）：`continue`，失败 → 边路由 `human_gate`（escalation 上下文）
- 路由节点（switch）：`stop`（无副作用，表达式失败该硬停）
- gate 节点（human_gate / human_intervention）：`stop`，超时按配置降级

### 2.7 abort 路径标准化

cleanup 作为标准 stage type，承担：worktree / sandbox / 远端 branch / draft MR / local bare repo 清理。
所有「abort」路径（spec/plan/dev reject、final_approval reject、IM intervention abort）统一汇入 cleanup → done。

---

## 3. 主拓扑图（E2E 占位版）

```
[branch_init]
    │
    ▼
[spec_author] ←──fail+round<maxRounds (带 priorReviewerNotes)───[spec_ai_review]
    │                                                                  │
    │ initial                                                          ├── pass ──┐
    │                                                                  │          │
    │                                                                  └── N-fail ┤ (带 aiNotes + source=escalation)
    │                                                                             │
    │   ┌──reject (回 author 带 humanNotes)──────────────────────────────[spec_human_gate]
    │   │                                                                         │
    └───┘                                                              ┌──approve─┘
                                                                       │
                                                                       ▼
                                                              [spec_commit_push]
                                                                       │
                                                                       ▼
                                                              [plan_author]

(plan / dev 同 spec 4 节点模式，差别仅在 human_gate.mode 默认值：
   plan/dev = on_fail（AI pass 跳过 human_gate）
   spec/final = required（AI pass 也走 human_gate）)

                                                                  [dev_push]
                                                                       │
                                                                       ▼
                                                              [e2e_placeholder]   ← TBD
                                                                       │
                                                                       ▼
                                                              [final_approval]
                                                                       │
                                                              ┌────────┼────────┐
                                                          approve   reject    timeout (按 config)
                                                              │        │        │
                                                              ▼        ▼        ▼
                                                        [mr_create] [cleanup] [cleanup]
                                                              │        │        │
                                                              └─→ [done] ←──────┘
```

### 3.1 spec_ai_review 边路由

- pass → `spec_human_gate`（inputs: `{ source: 'ai_pass', artifact, aiReview }`）
- fail + round < maxRounds → 回 `spec_author`（inputs: `{ priorReviewerNotes }`）
- fail + round ≥ maxRounds → `spec_human_gate`（inputs: `{ source: 'ai_escalation', artifact, aiReview, aiAttempts: N }`）

human_gate 在 `on_fail` 模式下，pass 边短路绕过 human_gate 直连 commit_push；
两种 source 下 human_gate 节点本身的决策类型一致（approve/reject）。

### 3.2 plan / dev 类比 spec

替换 `spec_*` 为 `plan_*` / `dev_*`，配置不同的 skill 名和 maxRounds 默认值（见 §5）。

### 3.3 E2E placeholder

`e2e_placeholder` 节点暂时复用现有 `qi_e2e_runner` 实现（保留 sandbox_failed bug 不修，待下次单独 brainstorm
E2E 内部拆分时一并解决）。占位节点输出 `{ result: pass|fail|sandbox_failed|skipped, ... }`，由后续 router
决定走 final_approval / dev_fix_loop / im_intervention。本次 spec **不定** E2E 内部 4 节点拆分细节。

---

## 4. 标准 stage type 集合

| Stage type | 职责 | 关键字段 | 替代 |
|---|---|---|---|
| `branch_init` | 建分支 + 占位首推 | inputs: `requirementId`, `gitlabProject`, `baseBranch`<br>outputs: `branch`, `worktreePath`, `bareRepoPath` | 现有 init_qi_branch 增强 |
| `llm_author` | LLM 写 artifact（不 commit） | inputs: skill name, prior notes, prev artifacts<br>outputs: `artifactPath`, `skillOutput` | 拆 skill_with_review.author |
| `llm_review` | LLM 审 artifact，binary 决策 | inputs: artifact + skillOutput<br>outputs: `decision`, `notes`, `specCoverage[]?` | 拆 skill_with_review.reviewer |
| `human_gate` | 人审 binary（mode=required/on_fail）+ timeout 规则 + escalation 入边上下文 | config: `mode`, `timeoutSeconds`, `onTimeout` (reject\|approve)<br>inputs: `source` ('ai_pass'\|'ai_escalation'), `artifact`, `aiReview?`<br>outputs: `decision`, `humanNotes` | 替代 final_approval (skill=null hack) + skill_with_approval.human + 各 `_human_escalation` |
| `human_intervention` | IM 卡片多选 + 超时升级 | config: `options[]`, `timeoutSeconds`, `onTimeout` (default decision\|escalate)<br>outputs: `decision` | 增强现有 im_input |
| `git_commit_push` | 幂等 commit + push origin | inputs: `artifactPaths[]`, `commitMessageTemplate`<br>outputs: `commitSha`, `pushedAt` | 新增 |
| `mr_create_or_update` | 幂等建/更新 Draft MR | inputs: `titleTemplate`, `labels`, `descriptionTemplate`<br>outputs: `mrUrl`, `mrIid` | 现有 mr_create 改造 |
| `cleanup` | 清 worktree/sandbox/remote branch/bare repo/draft MR | inputs: `targets[]`<br>outputs: `report` | 新增 |
| `end` | 显式 END 节点 | — | 替代 mr_create_skip 自环 hack |
| `switch` | 表达式路由（无副作用） | inputs: `cases`, `expression`<br>outputs: 路由 target | 现状保持 |
| `e2e_*` (TBD) | 占位 | — | 后续单独议 |

### 4.1 stage type 间的契约

- `llm_review.outputs.decision` ∈ `{ pass, fail }`，fail 时 `notes` 必填
- `human_gate.outputs.decision` ∈ `{ approved, rejected }`
- `human_gate.config.mode` ∈ `{ required, on_fail }`（无 disabled，人审兜底永不可关）
- `human_gate.config.onTimeout` ∈ `{ reject, approve }`；超时按此降级
- `human_gate.inputs.source` ∈ `{ ai_pass, ai_escalation }`；节点根据 source 渲染不同 IM/Web 卡片（escalation 多展示 AI notes + attempts），但决策类型和下游路由完全相同
- `git_commit_push` 必须幂等：若 commit hash 已存在 origin 则直接通过；push 失败时返回 `status: failed`，由路由进入 `infra_intervention` 节点（TBD，可暂用 cleanup 兜底）
- `mr_create_or_update` 必须幂等：检查 `requirements.mr_url` 字段，若存在则 PUT GitLab API 更新 description；不存在则 POST 新建

---

## 5. 节点实例契约（16 个非 E2E + 1 占位 + done）

| # | 节点 | Stage type | 关键输入 | 产出 | 副作用 | onFailure | Retry | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | branch_init | branch_init | requirementId, gitlabProject, baseBranch | branch, worktreePath, bareRepoPath | 建 worktree+bare repo；push 占位 commit | stop | 节点级（删 worktree 重建） | `branch_initializing` |
| 2 | spec_author | llm_author | rawInput, priorReviewerNotes?, priorHumanNotes? | spec.md, skillOutput | 写 spec.md（不 commit） | continue | 节点级 | `spec_authoring` |
| 3 | spec_ai_review | llm_review | spec.md, skillOutput | aiReview.{decision, notes, specCoverage} | 无 | continue | 节点级 | `spec_ai_reviewing` |
| 4 | spec_human_gate | human_gate (mode=`required`) | source ('ai_pass'\|'ai_escalation'), spec.md, aiReview? | decision, humanNotes | 推 IM/Web 卡片（escalation source 时多展示 AI notes + attempts） + 等审 | stop（超时按 config） | 节点级（替换决策） | `spec_human_gating` |
| 5 | spec_commit_push | git_commit_push | artifactPaths: [spec.md], commitMessageTemplate | commitSha, pushedAt | git add+commit `docs(qi-N): spec — ...` + push | continue | 幂等 | `spec_pushing` |
| 6 | plan_author | llm_author | spec.skillOutput, priorNotes? | plan.md, plan.tasks[] | 写 plan.md（不 commit） | continue | 节点级 | `plan_authoring` |
| 7 | plan_ai_review | llm_review | plan.md, plan.tasks | aiReview | 无 | continue | 节点级 | `plan_ai_reviewing` |
| 8 | plan_human_gate | human_gate (mode=`on_fail`) | source, plan.md, aiReview? | decision | 推卡片（AI pass 时此节点被边短路绕过；AI N-fail 时走此节点带 escalation 上下文） | stop | 节点级 | `plan_human_gating` |
| 9 | plan_commit_push | git_commit_push | artifactPaths: [plan.md] | commitSha | commit + push | continue | 幂等 | `plan_pushing` |
| 10 | dev_author | llm_author（TDD 内嵌） | spec/plan/tasks | tasksDone[], 多文件改动 + e2e playbook | **内每任务 commit**（保 commit 历史，详 §5.3） | continue | 节点级（round++） | `dev_authoring` |
| 11 | dev_ai_review | llm_review | worktree diff, tasksDone | aiReview | 无 | continue | 节点级 | `dev_ai_reviewing` |
| 12 | dev_human_gate | human_gate (mode=`on_fail`) | source, dev artifacts, aiReview? | decision | 推卡片（同 plan_human_gate 行为） | stop | 节点级 | `dev_human_gating` |
| 13 | dev_push | git_commit_push (push-only) | branch | pushedAt | 仅 push origin（已 commit） | continue | 幂等 | `dev_pushing` |
| 14 | e2e_placeholder | TBD | dev 产出 | result (pass/fail/skipped) | 复用现 qi_e2e_runner（占位） | TBD | TBD | `testing` |
| 15 | final_approval | human_gate (mode=`required`，无 AI review 上游) | source='final', 整 pipeline 摘要 | decision | 推最终审批卡片 | stop（超时 reject） | 节点级 | `mr_pending` |
| 16 | mr_create | mr_create_or_update | requirementId, titleTemplate, descriptionTemplate | mrUrl, mrIid | 幂等建/更新 Draft MR；**不再 push** | continue | 幂等 | `mr_open` |
| 17 | cleanup | cleanup | targets[] | report | 按 targets 清 | warn 但 continue | 节点级 | `aborted` 或 `done` |
| 18 | done | end | — | — | — | — | — | `done` |

### 5.1 默认 maxRounds

- spec ai_review fail loop：`maxRounds = 3`（当前 5 偏多）
- plan ai_review fail loop：`maxRounds = 3`（当前 2 偏少，对齐 spec/dev）
- dev ai_review fail loop：`maxRounds = 3`（保持当前）

可通过 pipeline definition 覆盖。

### 5.2 默认 timeout

- human_gate (mode=required, source=ai_pass)：`24h`，`onTimeout: approve`（spec/final 默认信任 AI pass）
- human_gate (任意 mode, source=ai_escalation)：`48h`，`onTimeout: reject`（AI 都拒了，超时该默认拒）
- human_intervention：`24h`，`onTimeout: default decision`（如 `abort`）

可在 pipeline definition 里按节点覆盖。

### 5.3 dev_author 内嵌 TDD commit 例外说明

dev-loop 内部按任务 TDD 顺序（write test → red → impl → green → tsc → commit）每任务 commit 一次，
**不**外抽为多个 graph 节点（任务数动态、tsc 长跑、commit 必须紧跟 green 状态）。dev_author 节点对外
contract 仍是「单一职责的产出节点」，节点内部多 commit 视为实现细节。

dev_push 节点只 push，不 commit。

### 5.4 author 修订策略（round 2+ 行为）

spec / plan / dev 三个 author 节点在 ai_review fail（round < maxRounds）或 human_gate reject 后被
重入时，**做增量修订而非重写**。

| round | 输入 | 输出 |
|---|---|---|
| 1（首次进入）| `rawInput`（+ 上游产物，如 plan_author 拿 spec.skillOutput）| 写新 artifact |
| 2+（AI rejected）| `rawInput` + `priorArtifact` + `priorReviewerNotes` | **覆盖**上一版 artifact |
| 2+（human rejected）| `rawInput` + `priorArtifact` + `priorHumanNotes` | **覆盖**上一版 artifact |

Prompt 引导 LLM「针对评审意见修订 artifact，保留已通过部分」，不要求全部推翻重写。

理由：
- token 省：reviewer notes 通常比 artifact 全文短，增量改比从零重写省 70%+ token
- 避免反复倒车：已被认可的部分不让 LLM 重新"发明"
- 跳出局部最优：多轮改不动时由 human_gate（escalation source）介入，由人决定彻底重写或 reject

Git 历史不留中间被拒版本：

- **spec_author / plan_author**：round 1..N 都 overwrite 同一个 artifact 文件（不 commit）；
  通过 human_gate 后由 spec_commit_push / plan_commit_push 做一次 commit，git 只看到「最终批准版」
- **dev_author**（TDD 内嵌 commit 例外）：round 1 内部按任务 commit；round 2+ 在已有 commits 上
  **追加 fix commit**，不改写历史，对齐 commit-conventions「按任务 commit，round 2+ 追加 fix」

各轮完整 round 历史（artifact diff、reviewer notes、human notes）保留在 LangGraph checkpoint state +
DB stage_operations 表，UI 详情页可查。

### 5.5 节点级 retry 设计

- 新增 admin API：`POST /admin/requirements/:id/stages/:stage/retry`
  - body: `{ fromNode: 'spec_ai_review', resetMode: 'resume'|'invalidate_downstream' }`
- 语义：
  - `resume`：仅当 graph 已停在 fromNode（failed / interrupt）时可用，重跑该节点后继续往下
  - `invalidate_downstream`：用于「graph 已经走过 fromNode 进入下游、想回头改」的场景，
    把 fromNode + 下游所有节点的 checkpoint state 清掉，从 fromNode 重新执行
- 后端实现：
  1. 校验当前 graph state 不是 running（避免并发）
  2. 用 LangGraph `getState` / `updateState` API 修改 checkpoint 的 `currentNode` + clear channel values
  3. 调 `graph.invoke({}, { configurable: { thread_id }})` 重新调度
- UI 暴露：requirement 详情页节点列表，每节点旁加「从此节点重跑」按钮（仅在 graph terminal /
  stuck / 已通过但想回退时可用）
- 风险：LangGraph checkpoint mutation 的稳定性需验证；详 §9

---

## 6. 跟当前实现的关键变化

| 改动项 | 当前实现 | 新版 |
|---|---|---|
| LLM 是否 commit | 委托 LLM 自行 commit（依赖 prompt DoD） | 不再委托——commit_push 节点强制做（dev 因 TDD 例外内嵌）|
| onFailure | stop / continue 混用，无规则 | **基础设施 stop / 业务 continue** + 失败边路由人审节点（§2.6 规则）|
| Push 时机 | 仅 mr_create 一次性 push | 每阶段 commit_push 节点 push；branch_init 也推占位 |
| MR 创建幂等 | 撞 409 报错 | mr_create_or_update：DB 查 mrUrl 决定 create/update |
| status 字段粒度 | 5 状态对 ~13 节点 | 18 节点 = 18 个细化 status，UI 精确显示卡在哪 |
| 人审兜底 | spec/dev/e2e 部分缺，plan 有独立 escalation 节点 | 每 LLM 阶段统一一个 human_gate 节点；escalation 作为入边上下文，不再独立节点 |
| End 节点 | switch 自环 hack | 标准 `end` 类型 |
| final_approval | skill_with_approval + skill=null hack | 标准 human_gate 类型 |
| Cleanup | 散落各处 | 标准 cleanup 节点接 abort/reject 路径 |
| 节点级 retry | 无入口，整条重跑 | admin API + checkpoint mutation + UI 按钮 |
| dev 双份配置 | dev_with_review_loop + dev_loop_for_e2e_fix 双套漂移 | 单一 dev_author 节点配置，e2e_fix 复用同节点但 inputs 注入 failureReport |

---

## 7. 迁移路径

不在本设计稿范围内（属于 implementation plan 阶段），但记下高层路线：

1. 新增 stage type：先实现 `llm_author` / `llm_review` / `human_gate` / `git_commit_push` / `cleanup` / `end` 共 6 个
2. graph-builder 拆分：把现有 skill_with_review buildNode 拆成两个 sub-node（带兼容旧 pipeline 定义的 fallback）
3. 改造 mr_create 幂等
4. 新增节点级 retry admin API
5. 改 init_qi_branch 加占位首推
6. pipeline 定义迁移：旧 QI pipeline JSON 改成新拓扑（保留旧 stage type 一段时间作 fallback）
7. E2E 节点保持占位（沿用 qi_e2e_runner），下次议时再拆 4 节点
8. UI 改造：requirement 详情页节点列表 + 节点级 retry 按钮

---

## 8. 待后续 brainstorm 的议题

按审计 §5 优先级排：

1. **E2E 节点 4 拆**（playbook_parse / sandbox_provision / scenario_run / sandbox_teardown）— 含 sandbox_failed 路由修正
2. **sandbox 改 VM**（VM provider 抽象、provisioning 协议、配置迁移）
3. **状态机单源**（LangGraph checkpoint vs DB stage_operations vs requirements.status 一致性策略）
4. **MR 描述补全**（plan / e2e 报告纳入 description）
5. **infra_intervention** 节点：commit_push / mr_create 等基础设施失败时的人工兜底（本设计稿暂时用 cleanup 兜底）

---

## 9. 关键风险

- **18 节点 vs 13 节点**：节点数增加，checkpoint 表存储压力略升；但每节点单一职责后单条记录 size 变小，net 影响待评估
- **dev_author 内嵌 commit 跟「全拆」哲学有微冲突**：本设计稿明确为 trade-off 例外（保 commit 历史 > 形式纯粹），详 §5.3
- **pipeline 定义迁移**：旧 QI requirement 在新拓扑下如何继续跑（建议：旧 requirement 保留旧 pipeline 定义跑完，新需求用新定义）
- **节点级 retry 的 LangGraph checkpoint mutation**：需验证 LangGraph 是否允许外部修改 checkpoint state（若不允许需另设状态机层）
- **human_gate 双 source 渲染**：单节点要根据 `source` 字段渲染两种 IM/Web 卡片样式（ai_pass 简版 vs ai_escalation 详版），UI 实现要小心两个状态混淆

---

附：审计文档 [docs/qi-workflow-audit.md](../../qi-workflow-audit.md)
