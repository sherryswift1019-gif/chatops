# Quick-Impl 工作流梳理（Audit）

> 目的：把当前 Quick-Impl pipeline 的实际行为、设计意图、与生产级要求的差距，一次性梳理清楚。
> 后续讨论"怎么改"时以这份为基准，避免凭印象判断。
>
> 梳理时间：2026-05-11
> 对应代码版本：`main` HEAD = `ec9776d feat(qi): v9 E2E pipeline 全量实现`
> 触发场景：在 `sherryswift1019-group/chatops` 仓库跑「登录页 /login 新增『记住用户名』Checkbox」需求 #1，卡在 QI E2E Test sandbox_failed。

---

## 0. 期望工作流

用户表述的目标工作流（生产级）：

1. **分支创建（Init Branch）**：基于需求填写的 Git 项目，fork 出新的需求分支（push GitLab）
2. **需求设计（Spec + AI Review）**：根据用户输入生成完整的生产级 Spec（commit GitLab）
3. **制定计划（Plan + AI Review）**：根据 Spec 制定执行计划（commit GitLab）
4. **执行计划（Dev + Review）**：使用 superpower 研发模式，开发 + 自测，测试成功后提交（commit GitLab）
5. **E2E 测试**：连接虚拟机，启动 sandbox，拉取开发分支，启动，端到端测试
6. **提交 MR**：在 GitLab 创建 MR

**关键要求**：
- 每个节点产出有 git 痕迹（分阶段 commit，不是最后一起提交）
- 每个节点能**独立重试**（E2E 失败不需要重跑 Dev / Spec）
- 整体达到「生产级别」可观测、可恢复、可审计

---

## 1. 当前实际流程图

```
[init_branch] (push? ❌)
     │
     ▼
[spec_review_loop]                                  ← skill_with_approval, onFailure=stop
     │ ◄── 人工 binary (approved/rejected)
     ▼
[plan_review_loop]                                  ← skill_with_review, onFailure=continue
     │
     ├ AI review pass ──► [dev_with_review_loop]
     └ AI fail (onFailure=continue) ──► [plan_human_escalation]
                                              │ 人工 plan_escalation
                                              ▼
                                        [dev_with_review_loop]   ← skill_with_review, onFailure=stop
                                              │
                                              ▼
                                        [qi_e2e_runner]          ← onFailure=stop, maxAttempts=2
                                              │
                                              ▼
                                        [e2e_router] (switch)
                                              │
                ┌─────────────────────────────┼─────────────────────────────┐
                │                             │                             │
       pass / skipped              sandbox_failed              fail+attempt<2
                │                             │                             │
                ▼                             ▼                             ▼
        [final_approval]      [e2e_sandbox_intervention]    [dev_loop_for_e2e_fix]
        (人工 binary)              (IM 卡片 fix/abort)               │
                │                             │                             ▼
                ▼                             │                      [qi_e2e_runner]
        [mr_create]                 [sandbox_intervention_router]    (loop)
        (push GitLab)                          │
        (建 Draft MR)              ┌──────────┴──────────┐
                                    fix                  abort
                                    │                    │
                                    ▼                    ▼
                            [qi_e2e_runner]        [mr_create_skip]
                                                       (sink)

                            default (fail+attempt≥2)
                                       │
                                       ▼
                               [e2e_im_intervention]
                                  (IM 3 按钮: fix/force_passed/abort)
                                       │
                                       ▼
                               [e2e_intervention_router]
                                       │
                       ┌───────────────┼───────────────┐
                  force_passed         fix            abort
                       │               │               │
                       ▼               ▼               ▼
                [final_approval]  [dev_loop_for_e2e_fix]  [mr_create_skip]
```

---

## 2. 主干节点逐项审计

### 2.1 Init Branch

| 维度 | 实际行为 |
|---|---|
| **类型** | `init_qi_branch` ([init-qi-branch.ts](../src/pipeline/node-types/init-qi-branch.ts)) |
| **输入** | `requirementId`、`gitlabProject`、`baseBranch`、`retryAttempt?` |
| **产出** | `branch` (`feat/qi-{id}`)、`worktreePath`、`cachePath`、`bareRepoPath` |
| **副作用** | 1. 写 `requirements.branch / worktree_path`<br>2. 状态 → `spec_review`<br>3. 本地 worktree + per-project **本地 bare repo** ([init-qi-branch.ts:108-129](../src/pipeline/node-types/init-qi-branch.ts#L108-L129)) |
| **Git push** | ❌ **不 push GitLab**。设计上推后到 `mr_create` 一次性推 |
| **失败处理** | 任一失败 → `status: failed`，graph `onFailure: stop` 终止 |
| **Retry** | 节点本身支持 `retryAttempt` 参数（分支名变 `feat/qi-N-r2`），但**没有 admin 入口**触发重试，需外层 graph 调用 |
| **资源回收** | worker 有 cleanup tick 扫 worktree 目录，但 init 失败后 worktree 未必清理 |

**Gap vs 期望**：

| Gap | 当前 | 期望 |
|---|---|---|
| 是否 push GitLab | ❌ | ✅ |

**设计理由**："不污染 GitLab，e2e 全绿后 mr_create 才正式 push GitLab"。Tradeoff：
- 早 push → 用户能在 GitLab 看到分支进度，但失败留分支垃圾（需 abort 时清理）
- 晚 push（当前） → 远端干净但开发期间 GitLab 完全看不到此需求存在

---

### 2.2 Spec + AI Review

| 维度 | 实际行为 |
|---|---|
| **类型** | `skill_with_approval`（interrupt-bound 节点，由 [graph-builder.ts:buildSkillWithApprovalNode](../src/pipeline/graph-builder.ts) 接住 LangGraph `interrupt()`） |
| **输入** | `requirementId`、`rawInput`、`worktreePath`、`branch`、`artifactPath` (`docs/specs/qi-N.md`) |
| **产出** | spec.md 文件 + `skillOutput` JSON（含 summary/decision/notes/acceptanceCriteria 等结构化字段） |
| **副作用** | 1. LLM 写 spec.md<br>2. **LLM 自己调 MCP tool `commit_artifact`** 做 git commit（`docs(qi-N): spec — ...`）<br>3. 创建 approval waiter 等人审<br>4. 通过后状态 → `planning` |
| **AI Review** | ⚠️ **名字误导** — 没有独立 AI reviewer 节点。spec-author 自己输出"自我评估摘要"（contextSummary 里的 🟡 medium risk / 看起来可快速批 之类）。对比 plan 节点是双角色（decomposer + reviewer 独立 LLM） |
| **Commit 责任** | ⚠️ **委托给 LLM**，不是 graph 节点强制做。role prompt（[spec-author.md](../.claude/skills/quick-impl-artifact-author/roles/spec-author.md)）DoD 写"必须调 commit_artifact"，但 LLM 可能不调 → 静默漏 commit |
| **Git push** | ❌ commit 后不 push |
| **失败处理** | binary 决策：approved → 推进；rejected → 同节点重跑（最多 `maxRounds: 5`）；超 5 轮 → `status: failed` + `onFailure: stop` graph 终止 |
| **Retry** | 节点内多轮（rejected 再生成）；**跨节点 retry 无入口**（整条重跑） |
| **资源回收** | spec.md 留在 worktree（人审挂掉也不动） |

**Gap vs 期望**：

| Gap | 当前 | 期望 |
|---|---|---|
| AI Review 不独立 | spec-author 自评 | 独立 reviewer（对比 plan 节点） |
| Commit 不强制 | LLM 自己 commit，约束在 prompt DoD 里 | graph 节点保证（commit 失败 = 节点失败） |
| 不 push | 同 init | 每节点 push |
| 审批超时无处理 | maxRounds=5 用完 → fail，waiter 无 timeout | N 小时未审 → 升级 / 默认 reject / 提醒 |
| 节点独立 retry 无入口 | 整条 graph 失败无 retry | 从此节点重起 |

**额外发现的 product 风险**：
- skill_with_approval **强依赖 in-memory interrupt registry**（[graph-runner.ts](../src/pipeline/graph-runner.ts) `resumedInterrupts` Set）。chatops 进程重启后，已通过审批的 waiter 可能 replay
- LangGraph checkpoint 跟 stage_operations 表 / requirements.status 三者状态可能不一致（[worker.ts:155-166](../src/quick-impl/worker.ts#L155-L166) 注释明确说"status stale"会发生）

---

### 2.3 Plan + AI Review

| 维度 | 实际行为 |
|---|---|
| **类型** | `skill_with_review`（async loop，**无 interrupt**，纯 LLM 双角色对话） |
| **双角色 LLM** | ✅ 真正双 AI ——`plan-decomposer`（生成 plan）+ `plan-reviewer`（独立 LLM 审）。每轮 dev → reviewer → 通过退出 / 拒绝喂 reviewer.notes 给下一轮 |
| **maxRounds** | 2（比 spec 的 5 少一半） |
| **输入** | spec.skillOutput（spec 全文 + 结构化字段）、`schemaVersion: v2` |
| **产出** | plan.md 文件 + `tasks[]`（任务清单结构化）+ `review.notes` |
| **副作用** | 1. LLM 写 plan.md + commit<br>2. 通过后状态 → `dev` |
| **Commit 责任** | ⚠️ 同 spec —— 委托给 LLM（plan-decomposer role 的 DoD） |
| **Git push** | ❌ 不 push |
| **失败处理** | ⭐ **`onFailure: 'continue'`** —— AI review 失败不终止 graph，路由到 `plan_human_escalation` 节点（人工兜底） |
| **人工兜底** | `plan_human_escalation`：decisionSet=`plan_escalation`，`skipFirstSkill: true`（round 1 不重跑 LLM，直接给人审 AI 拒的那版 + reviewer notes） |
| **Retry** | dev 内 maxRounds=2 自动 retry；AI 全失败 → 人工 escalation 节点（多 1 个 round 人审）；**人审超 3 轮 → fail**，整条重跑 |

**比 spec 强的地方**（值得 spec 借鉴）：
- ✅ 真正的独立 AI reviewer
- ✅ `onFailure: 'continue'` + 人工兜底节点（不会硬死）
- ✅ `skipFirstSkill` 节省一次 LLM 调用（人审看 AI 拒的版本）

**比 spec 弱的地方**：
- maxRounds=2 偏严（但有人工兜底所以可接受）

**Gap vs 期望**：

| Gap | 当前 | 期望 |
|---|---|---|
| Commit 不强制 | LLM 自己 commit | graph 节点保证 |
| 不 push | 同 init/spec | 每节点 push |
| 节点独立 retry 无入口 | 同前 | 从此节点重起 |

---

### 2.4 Dev + Review

| 维度 | 实际行为 |
|---|---|
| **类型** | `skill_with_review`（同 plan 结构，但参数差异大） |
| **双角色** | `dev-loop`（生成）+ `code-quality-reviewer`（独立 AI 审） |
| **maxRounds** | 3 |
| **超时** | 1 小时 / 单轮（dev），10 分钟 / 单轮（reviewer） |
| **maxTurns** | 200 turns / dev，30 / reviewer |
| **输入** | spec.skillOutput + plan.tasks[] + planPath + requirementId |
| **artifactPath** | ⭐ 整个 worktree 目录（dev 改多个文件，非单 artifact） |
| **产出** | 代码改动（多文件）+ 单测 + e2e playbook YAML（`docs/test-playbooks/qi-N.yaml`）+ `tasksDone[]` |
| **副作用** | 1. 多个 git commit（按任务 + 追加 fix）<br>2. 通过后状态 → `testing` |
| **dev-loop 自测约束** | ✅ **TDD 顺序**：write test → red → implement → green → `tsc` → commit<br>✅ **vitest --related** 跑受影响单测<br>✅ **每任务 commit 前必须 tsc + 单测都过** ([dev-loop.md:92-104](../.claude/skills/quick-impl-artifact-author/roles/dev-loop.md#L92)) |
| **Commit 责任** | 同样委托给 LLM，但约束更细："按任务 commit"，round 2+ 追加 fix commit 不改写历史 |
| **Git push** | ❌ 不 push（[commit-conventions](standards/commit-conventions.md) 明确："dev-loop 不 push，mr_create 节点统一推") |
| **失败处理** | ⚠️ **`onFailure: 'stop'`** —— 跟 plan 不一致。dev 多轮失败后直接终止 graph，**无人工兜底节点** |
| **Retry** | 节点内 maxRounds=3 自动重试；跨节点失败 → 整条重跑 |
| **dev 第二个出现点** | `dev_loop_for_e2e_fix` 节点 —— E2E 失败后修代码用，inputs 多塞 `failureReport` + `humanNote`，**maxRounds=1** |

**Gap vs 期望**：

| Gap | 当前 | 期望 |
|---|---|---|
| superpower 研发模式 | dev-loop role prompt 强约束 TDD，但**没显式启用 [superpowers skills](../.claude/skills/superpowers/)（test-driven-development / verification-before-completion 等）** | 显式启用 superpower |
| 不 push | dev-loop 完成不 push | 每节点 push |
| 节点 retry 无入口 | 同前 | 从 dev 单节点重起 |
| commit 规范不强制 | reviewer 把"按任务 commit"违规判 warn 不 error（看 #1 跑出来 T1+T2 合 commit） | 不合规应阻断 |
| 缺失人工兜底 | onFailure=stop，跟 plan 比少 dev_human_escalation | 生产级该有 |

**两个明显的设计不一致**：
1. **失败兜底分布不均**：spec=stop / plan=continue（有人工兜底）/ dev=stop / e2e=stop（有 sandbox 介入 / im 介入兜底但被 stop bug 卡掉）。需统一：所有 LLM 节点都该有人工兜底
2. **dev 节点出现两次**（首次实现 + e2e fix），两套配置参数不一致（maxRounds=3 vs maxRounds=1，inputs 不同）

---

### 2.5 QI E2E Test

| 维度 | 实际行为 |
|---|---|
| **类型** | `qi_e2e_runner`（独立 stage type，不依赖 LangGraph interrupt） |
| **输入** | `requirementId`、`worktreePath`、`branch`、`bareRepoPath`、`maxAttempts: 2` |
| **流程** | 1. parse + 合规校验 playbook YAML<br>2. push worktree 到本地 bare repo<br>3. 反查 `e2e_target_projects` by `gitlabProject`<br>4. `provisionQiSandbox` → 本地建 sandbox 目录 + clone bare + 跑 `deploy.sh provision`<br>5. 串行跑每个 scenario（Claude + Playwright MCP 在 sandbox 里跑）<br>6. teardown sandbox |
| **Sandbox 类型** | ⚠️ `docker-compose-local` —— **本地 docker stack**，不是 VM。每个 sandbox = host 上独立目录 + 独立 compose network（带 runId 后缀） |
| **共享依赖** | ⚠️ ChatOps 项目的 `deploy.sh provision` **借 host 的 `chatops-postgres-1` 容器跑 psql** 来初始化 sandbox DB。**不完全 self-contained** |
| **产出** | scenario manifest + evidence dir (`TEST_DATA_DIR/qi-evidence/qi-N/attempt-M/`) + `result` (pass/fail/sandbox_failed/skipped) + `failureReport` |
| **副作用** | push worktree commits 到**本地 bare repo**（不是 GitLab），sandbox 从 bare clone |
| **Git push GitLab** | ❌ 不 push |
| **Commit** | ❌ 节点不 commit（evidence 只在 evidence 目录，不进 git） |
| **失败分类** | `pass` / `fail` / `sandbox_failed` / `skipped`（playbook 不存在 = 非功能改动） |
| **失败处理** | ⚠️ **`onFailure: 'stop'`** 但内部按 result 区分 `status`：result=skipped 时 status=success；其他 result 都 status=failed |
| **Retry** | 节点内 `attempt` 计数（attempt<2 时 router 路由到 dev_loop_for_e2e_fix 修代码）；attempt=2 还失败 → e2e_im_intervention |
| **路由** | E2E Router 根据 result + attempt 分流（见路由节点章节） |
| **资源回收** | try-finally 保证 teardown sandbox + clean evidence dir。evidence 写到 sandbox **外**（避免 teardown 删掉） |

**Gap vs 期望**：

| Gap | 当前 | 期望 |
|---|---|---|
| "连接虚拟机" | ❌ 本地 docker-compose，不是 VM | ✅ VM 隔离 |
| "拉取开发分支" | ✅ git clone 本地 bare 仓 feat/qi-N | ⚠️ 从本地 bare 而非 GitLab（前面没 push 到远端） |
| 节点独立 retry 无入口 | attempt 内可循环，外层失败要重跑 dev | E2E 失败可单独触发（target 修了就 retry） |

**严重设计问题**：
1. ⚠️ **sandbox_failed 被 onFailure='stop' 截杀**（[qi-e2e-runner.ts:251](../src/pipeline/node-types/qi-e2e-runner.ts#L251)）—— 实测验证。graph 设计了 `e2e_sandbox_intervention` 兜底节点**但走不到**。要么改 `onFailure='continue'`，要么 `sandbox_failed` 时 return `status: 'success'`（output.result 告诉 router 路由）
2. ⚠️ **sandbox 不是 VM** —— 用户期望"虚拟机隔离" vs 当前"本地 compose" 是产品语义差异
3. ⚠️ **共享 host 容器** —— `chatops-postgres-1` 这个依赖让 sandbox 不能完全独立。换个 target 项目可能 deploy.sh 不依赖；但 ChatOps 自己 dogfood 时会卡这里
4. ⚠️ **evidence 路径分裂** —— evidence 在 `TEST_DATA_DIR` 不是 git。失败 evidence 不跟分支走，回头看 history 找不到
5. ⚠️ **本地 bare repo 作 sandbox origin** —— "拉开发分支"实际从本地 bare 拉，**不验证 GitLab 远端真的有该分支**。如果期望 sandbox 跟生产路径一致（生产 clone GitLab），本地 bare 是 shortcut

---

### 2.6 Create MR

| 维度 | 实际行为 |
|---|---|
| **类型** | `mr_create`（独立 stage type） |
| **输入** | `requirementId`、`titleTemplate`、`labels`、`removeSourceBranchAfterMerge`、`squashCommits`、`draft`（默认 true） |
| **流程** ([mr-create.ts:113+](../src/pipeline/node-types/mr-create.ts#L113)) | 1. 校验需求/branch/worktreePath<br>2. 拿 GitLab url+token<br>3. **git push HEAD:branch 到 GitLab**（首次推送！）<br>4. 检测 base 是否有新 commit（rebase hint）<br>5. 反查 spec content（DB 优先 + file fallback）<br>6. 构建 title `Draft: [quick-impl] <title>`<br>7. 构建 description（含原始需求 + spec 摘录 + dev review 摘要 + rebase 提示）<br>8. POST GitLab API 建 MR<br>9. setMrUrl + status → `mr_open` |
| **产出** | `mrUrl`、`mrIid`、`rebaseHint` |
| **Git push** | ⭐ **整个流程唯一 push GitLab 的地方**（迟到 push） |
| **MR 状态** | ⚠️ 默认 **Draft**（除非 `params.draft=false`） |
| **MR 描述内容** | 原始 rawInput + spec 摘录前 300 字 + dev review decision/fixRounds/tasksDone。⚠️ **不引 plan / e2e 报告** |
| **Commit 模式** | 默认 `squashCommits: false`（保留按任务 commit 历史） |
| **Branch 清理** | `removeSourceBranchAfterMerge: true`（merge 后 GitLab 自动删 source branch） |
| **失败处理** | `onFailure: 'stop'` |
| **Retry** | 节点失败要重跑——push 幂等 OK，但**重建 MR 会失败**（GitLab 同 source_branch 已有 MR 就 409）。**没有"MR 已存在则更新"逻辑** |

**严重设计问题**：
1. ⚠️ **Push 时机集中导致整个流程对 GitLab "隐身"**——开发期间在 GitLab 看不到此需求存在
2. ⚠️ **Retry 不幂等**：mr_create 失败重跑会撞 GitLab 409
3. ⚠️ **MR 描述信息不全**：plan.md / e2e 结果 / sandbox 介入决策都没体现
4. ⚠️ **abort 后 worktree + GitLab branch 都不清理**：mr_create 之后 abort 留 GitLab 远端分支 + draft MR 垃圾
5. ⚠️ **spec_content 兜底入 DB**（[mr-create.ts:156-162](../src/pipeline/node-types/mr-create.ts#L156-L162)）—— 这里做"补救式"DB 写入。说明 spec 入库职责本不在 mr_create，但 cleanup worker 30min 才入库，mr_create 等不了 → **职责越界 + 时序耦合**

---

## 3. 路由 + 人工介入节点

| 节点 | 类型 | 决策方式 | onFailure | 关键参数 |
|---|---|---|---|---|
| **e2e_router** | switch | qi_e2e_runner.output 字段表达式匹配 | stop | 4 个 case + default |
| **dev_loop_for_e2e_fix** | skill_with_review | LLM 双角色 | stop | maxRounds=1（外层 attempt 计数），多塞 `failureReport` + `humanNote` 给 dev-loop |
| **e2e_im_intervention** | im_input | IM 卡片 3 按钮（fix/force_passed/aborted） | stop | timeoutSeconds=86400（24h） |
| **e2e_intervention_router** | switch | im 决策表达式 | stop | force_passed→final_approval / fix→dev_fix / default→skip |
| **e2e_sandbox_intervention** | im_input | IM 卡片 2 按钮（fix→retry / aborted） | stop | timeoutSeconds=86400 |
| **sandbox_intervention_router** | switch | im 决策 | stop | fix→qi_e2e_runner / default→skip |
| **final_approval** | skill_with_approval | skill=null（跳过 generator）binary 决策 | stop | `statusOnSuccess: mr_pending` |
| **mr_create_skip** | switch (sink) | `cases=true→self`（自环到 END） | stop | aborted 路径的尾节点 |

**理解上的关键点**：
1. ✅ **设计意图很清楚**：E2E 失败有 3 条路径（修代码 / 重跑 sandbox / 人工 force_passed），覆盖了 dev bug / 基础设施 bug / 误判 三种 root cause
2. ✅ **路由表达式可读**（`steps.qi_e2e_runner.output.result == '...'`），不是硬编码
3. ✅ **IM 介入设计成 24 小时超时**，给运维一天时间响应
4. ⭐ **dev_loop_for_e2e_fix 不切 status**（保持 `testing`），避免 UI 误判状态在前进

**严重设计问题**：
1. ⚠️ **sandbox_failed 永远走不到 e2e_sandbox_intervention**（前面发现的核心 bug）。`qi_e2e_runner` `onFailure='stop'` + `sandbox_failed` 时 status=failed 互锁 → graph 在 router 之前已经死
2. ⚠️ **所有路由节点 onFailure='stop'**。switch 节点失败通常是表达式 eval 出错（生产期可能因 stepOutputs 缺字段），现在直接 graph 死。**没有 fallback 路由**
3. ⚠️ **dev_loop_for_e2e_fix 和 dev_with_review_loop 参数漂移**：
   - `dev_with_review_loop`: maxRounds=3, maxTurns=200, timeoutMs=1h
   - `dev_loop_for_e2e_fix`: maxRounds=1, maxTurns=120, timeoutMs=30min
   - 两套配置维护起来容易不同步
4. ⚠️ **`final_approval` 用 skill_with_approval 但 skill=null**——hack 出来"纯人审"的节点。如果"纯人审"是常见模式，**应该有专门的 stage type `human_approval`**，而不是复用 skill_with_approval + 传 null
5. ⚠️ **`mr_create_skip` 用 switch 自环作 sink**——hack 法。LangGraph 直接 `target: END` 不行吗？这种"假节点占位"会让 stage_operations 表多一条没意义的记录
6. ⚠️ **三个 IM 介入节点 timeout 一致都是 24h**，但**没有"超时后自动决策"逻辑**（im_input 超时只是 throw）。生产级：超时该有 escalation rule（自动 reject / 升级到二级 / 默认行为）
7. ⚠️ **没有"abort 已通过审批的需求"路径**——如果 spec 通过、plan 通过、dev 跑一半发现需求理解错了，**没有节点支持"回到 spec 重做"**。当前只能 abort 然后新建需求重头跑
8. ⚠️ **status 字段跟 stage 不一一对应**：spec_review_loop 推 status=planning，plan_review_loop / plan_human_escalation 推 status=dev，dev_with_review_loop 推 status=testing，final_approval 推 status=mr_pending，mr_create 改 status=merged/mr_open。**dev_loop_for_e2e_fix 故意不改 status**。**testing → testing → testing → mr_pending 的过渡里，UI 区分不出"E2E 第 1 轮 / E2E 第 2 轮 / 人工介入"** —— 信息丢失

---

## 4. 总览：系统级问题分类

### A. 设计不一致（修起来快但要先统一规则）

1. **`onFailure` 三种值混用**（stop / continue / ?）。**没有统一规则**：哪类节点该 stop、哪类该 continue
2. **失败兜底分布不均**：plan 有人工 escalation、spec / dev / mr_create 都没有
3. **status 字段跟节点 1:N**：testing 状态对应 E2E / dev_fix / sandbox 介入 / im 介入 4 个不同节点，UI 看不出具体卡哪
4. **dev_with_review_loop vs dev_loop_for_e2e_fix 参数双份**（maxRounds/maxTurns/timeoutMs），漂移风险高
5. **`final_approval` 用 skill=null hack** + **`mr_create_skip` switch 自环 sink hack** —— 欠一个 `human_approval` + `end_sink` 标准 stage type

### B. 严重 bug（修了立刻能跑通更多场景）

6. **sandbox_failed 被 `onFailure='stop'` 截杀**，永远走不到 e2e_sandbox_intervention（本次实测的核心 bug）
7. **mr_create retry 不幂等**（撞 409）
8. **commit 委托给 LLM，没强制保障**（dev T1+T2 合 commit 这种违规只 warn）

### C. 架构层 gap（用户提的「生产级」要求）

9. **节点独立 retry 无入口** —— graph 终态后无法从单节点重起，要么整条重跑要么手改 checkpoint
10. **每节点不 push GitLab** —— 用户明确要求"每节点 push"，当前只 mr_create 一次性推
11. **sandbox 不是 VM** —— 用户期望"虚拟机隔离"，当前 docker-compose-local + 共享 chatops-postgres-1
12. **状态机分散到 LangGraph checkpoint + stage_operations 表 + requirements.status + memory interrupts registry**，四源一致性靠 worker recovery tick 校准 —— 重启 / 崩溃 / 部署时容易 split-brain
13. **timeout / escalation 缺失** —— 所有 IM 介入超时只 throw，没"自动决策 + 上升一级"逻辑
14. **abort 路径资源清理不完整** —— worktree / sandbox / GitLab branch / draft MR / local bare repo 散落各处

### D. 用户体验 gap

15. **UI/IM 看不到"当前卡在哪个具体节点"** —— 只有 status 字段，5 个节点共享 4 个 status
16. **MR 描述不完整** —— reviewer 在 GitLab 看不到完整上下文
17. **每节点不 push** 导致开发期间 GitLab 完全看不到此需求存在，无法 audit / 中途接手

---

## 5. 后续讨论锚点

这份梳理之后，需要做的设计决策（按优先级）：

1. **统一 `onFailure` 规则** + **统一每个 LLM 节点都有人工兜底** —— 修 5 个节点配置，半天
2. **修 sandbox_failed 截杀 bug** —— 改 [qi-e2e-runner.ts](../src/pipeline/node-types/qi-e2e-runner.ts) status 返回，1 小时
3. **抽 `human_approval` 标准 stage type** + **mr_create_skip 改 direct END** —— 半天
4. **设计「节点独立 retry」机制** —— 涉及 admin API + LangGraph checkpoint state mutation，1-2 天
5. **每节点 push GitLab + abort 时清理远端** —— 需要 contract 设计（节点 push 失败如何重试），1-2 天
6. **sandbox 改 VM** —— 大改造，需要 VM provider 抽象、provisioning 协议、配置迁移，1-2 周
7. **状态机单源（弃 LangGraph checkpoint 还是补 reconcile）** —— 架构选择，时间不可估
8. **MR 描述补全 + retry 幂等 + abort 资源清理** —— 综合改造，1-2 天

---

## 6. 实测时发现的待修小 bug

- 测试脚本 [quick-impl-pipeline.mjs:577](../src/__tests__/e2e/quick-impl-pipeline.mjs#L577) `qi-already-claimed` 用错路由 `/waiters/.../decide`（正确是 `/approvals/:waiterId`），导致测试无脑 PASS
- admin 缺 `POST /e2e-targets` 创建端点（只有 PUT 更新），新增 target 项目要 DB 直 INSERT
