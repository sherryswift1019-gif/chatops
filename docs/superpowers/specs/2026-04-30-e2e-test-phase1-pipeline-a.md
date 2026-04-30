docs/superpowers/specs/2026-04-30-e2e-test-phase1-pipeline-a.md# 端到端自动化测试 — Phase 1 · Pipeline A：Test Generator

> 立项日期：2026-04-30
> 范围：**仅 Phase 1 中的 Pipeline A**（TestSpec.md → AI 生成 Playwright 脚本 + baseline self-correct + auto-merge）
> 姊妹文档：
> - `docs/superpowers/specs/2026-04-30-e2e-test-phase1-pipeline-b.md`（Pipeline B：Test-and-Fix Loop）
> - `docs/superpowers/specs/2026-04-30-e2e-test-phase1.md`（合并版，两条 pipeline 一份文档）
> - `docs/superpowers/specs/2026-04-30-auto-e2e-test-design.md`（包含 Phase 2-7 路线图的完整 spec）
> 关联：现有 bugfix 流水线、PRD 流水线、Pipeline 引擎（LangGraph）

> §0-2（目的 / 总览 / 数据模型 / 脚本契约）与 Pipeline B 文档共享，方便单独阅读本文档；§3 Pipeline A 是本文档主体；§4 Pipeline B 不在本文档，详见姊妹文档。

---

## 0. 目的与范围

### 目的

在 ChatOps 平台上实现**真实场景化端到端测试 + 自动诊断 + 自动修复 + 重跑直至全绿**的同步闭环。

第一期 dogfood 跑 ChatOps 自身（被测=本仓库），架构留口子支持外部项目（如 ssh-proxy 这类纯 CLI、无 UI 的 Go 项目）接入。

### Phase 1 不在本期范围

详见独立 spec 文档（`docs/superpowers/specs/2026-04-30-auto-e2e-test-design.md`）的 Phase 2-7 路线图。Phase 1 不实现的关键能力：TestSpec 模板/lint、Playwright codegen 录制入口、MR webhook 主入口、汇总 MR 完整形态、Auto-verify/一键 revert、完整 RBAC、SSE 实时刷新、业务指标完整、多项目接入、多模块多机环境编排、PRD→Spec 自动派生。

### 关键决策汇总

| 决策点 | 选择 |
|---|---|
| 被测对象 | 第一期 ChatOps 自身；架构支持外部项目接入 |
| 失败回路范式 | 同步闭环：一次 run 跑到全过 |
| 被测环境形态 | 临时沙盒（每次 run 起一份隔离环境）|
| 沙盒底座 | docker-compose-local |
| 测试脚本来源 | **AI 从 markdown spec 生成 Playwright（Pipeline A 完整版）**：包含 baseline self-correct（区分脚本 bug vs 产品 bug）+ auto-merge |
| 浏览器驱动 | Playwright + Playwright MCP（AI 探索时通过 MCP）|
| Bugfix 应用方式 | **独立 e2e-fix llm_agent 节点 + 精简 debug-fix prompt**（不调 bugfix capability，永远不接）；沙盒内 iteration_branch 直接 commit；全绿后开普通 MR 给人审 |
| 项目接入抽象 | shell 脚本契约（4 个约定脚本：build.sh / deploy.sh / test.sh / 可选 fix.sh）；平台一边只有一个通用节点 + 一张登记表 |
| Pipeline B 主入口 | **IM 单句**`@bot 跑 chatops e2e [--tag=smoke]` |
| Pipeline B 循环 | LangGraph 原生 conditional_edge 自循环 |
| Bugfix 分发 | 同进程同步 await |
| Schema 编号策略 | 本模块从 v1000 起步独立段位，跟主干 v59+ 永不撞号 |

---

## 1. 总览：三层模型 + 两条 Pipeline + 一组脚本契约

### 三层模型

```
       人写              AI 生成 / 项目自带          脚本契约 (sandbox + build/package/deploy/test/fix)
  TestSpec.md  ───►  TestArtifacts (Playwright / go test / pytest / ...)  ───►  TargetSystem
   验收意图          可重复运行 + 检查逻辑                                       项目仓库里的 5 个 .sh
        │                       │                                                       │
        │                       │                                                       │
        └────[Pipeline A]───────┘                                                       │
            "Generator + Self-correct"                                                  │
                                  └──────[Pipeline B]────────────────────────────────── ┘
                                       "Test-and-fix loop"
```

### 两条 LangGraph Pipeline

- **Pipeline A — Test Generator**：TestSpec.md → 跑 LLM 生成 → static check → baseline 自检 → 不过则改脚本（≤3 次）→ commit + 出 PR 给人审。**项目已有测试时整条 pipeline 跳过**。
- **Pipeline B — Test-and-Fix Loop**：起沙盒 → runTestSuite → 失败收证据 → 调 bugfix capability → 等 → 重部署 → 重跑 → 全绿后开汇总 MR。

### 项目接入抽象 — 脚本契约

被测项目的接入物 = **项目仓库根目录的一组约定脚本** + **平台一张 DB 表登记仓库地址 + 脚本能力清单**。

跟 ChatOps 现有脚本规范对齐，**第一期 4 个脚本**（不是 5 个 — `package` 跟 `build` 在 docker 项目里本来就是同一步、`sandbox` 跟 `deploy` 都是 docker-compose 生命周期管理，强行拆开违和）：

```
build.sh           # 必需 — 编译产物 + 打包成可部署形态（docker image / tar / 二进制）
                   # ChatOps 现状: ENV 驱动 (IMAGE_NAME / IMAGE_TAG / BASE_IMAGE / PLATFORM)，无子命令
                   # e2e 平台调时无需传子命令，调用前已在 sandbox checkout 到目标 branch
deploy.sh          # 必需 — 多角色：日常生命周期 + 沙盒生命周期 + 部署
                   # ChatOps 现状: up / down / restart / logs / migrate / status (位置参数子命令风格)
                   # e2e 新增子命令: provision / teardown / healthcheck / deploy / redeploy
test.sh            # 必需 — 跑测试 + 收证据 + 可选生成
                   # ChatOps 现状: --setup-env / --filter / --typecheck / --list / --keep / --rounds (长选项风格)
                   # e2e 新增子命令: --discover / --scenario / --static-check / --generate
fix.sh             # 可选 — 应用补丁；不实现就由平台用 git CLI 兜底
```

平台一边只有 **一个通用节点类型** `invoke_target_script` + **一张登记表** `e2e_target_projects`。所有项目特异性下沉到 shell 脚本里。

**为什么是 shell 脚本而不是 Node module 契约**：另一种设计是让被测项目实现 `tests/e2e/contract.ts` export 一组函数，平台调一个 `invoke_target_module` 节点。Node module 契约的优点是**类型安全 + IDE 友好 + 容易单测**；缺点是**锁死 Node 生态**——ssh-proxy（Go）、其他 Python / Rust / 嵌入式项目接入时必须包一层 Node wrapper，反而把"通用"打折扣。脚本契约虽然弱类型、stdout JSON 协议要靠 lint 工具保证，但**任何语言任何项目都能直接接入**。第一期 dogfood ChatOps 自己（Node）虽然类型安全损失明显，但为了第二期 ssh-proxy 接入的零负担，**架构层面坚持 shell 契约**。

### 脚本子命令契约

#### `deploy.sh`（位置参数子命令，沿用现状风格）

现有子命令保留不变（`up | down | restart | logs | migrate | status`），新增 e2e 沙盒生命周期 + 部署子命令：

```bash
# === e2e 新增子命令 ===

deploy.sh provision --branch=<branch> --out-handle=<file>
   # 准备一个干净的沙盒环境（独立 docker network + 端口动态分配）
   # 写 handle JSON 到 --out-handle:
   # {
   #   "envId": "test-iter-42",
   #   "kind": "docker-compose-local" | "k8s-namespace" | "remote-multi-host" | ...,
   #   "endpoints": { "web": "...", "api": "...", "ssh": "..." },
   #   "modules": [{ "name": "auth-svc", "host": "...", "port": ... }, ...],
   #   "internalRefs": { ... }
   # }
   # exit 0 = ready, exit 非 0 = 失败 (stderr 给原因)

deploy.sh teardown --handle=<file>
   # 销毁沙盒；幂等（已 torn_down 直接 exit 0）

deploy.sh healthcheck --handle=<file>
   # exit 0 = 全部模块 healthy

deploy.sh deploy --handle=<file>
   # 在已 provision 的沙盒里首次部署产物（build.sh 的输出）
   # 调用前 sandbox 里已经 git checkout 到目标 branch
   # stdout 最后一行 JSON: {"deployedAt":"...","modules":["..."]}

deploy.sh redeploy --handle=<file> [--module=<name> [--module=<name> ...]]
   # 沙盒里重新部署（修了 bug 之后用）
   # 不传 --module 部全部；传则只重部指定模块（V2 多模块 + 增量 redeploy 用，V1 不传）
```

#### `test.sh`（长选项 flag，沿用现状风格）

现有 flag 保留不变（`--setup-env | --filter | --typecheck | --list | --keep | --rounds`，无 flag 默认跑全套），新增 e2e flag：

```bash
# === e2e 新增 flag ===

test.sh --discover [--format=json]
   # 现读项目里的 scenario 列表（默认从 tests/e2e/ 扫描）
   # stdout 最后一行 JSON: {"scenarios":[{"id":"...","name":"...","tags":[...]}]}

test.sh --scenario <scenario-id> --evidence-dir=<dir> [--timeout=<sec>]
   # 跑单个 scenario（区别于无 flag 时默认跑全套）
   # exit 0=pass, 1=fail, 2=abort/error
   # 副作用: 把所有证据落到 <dir>/<scenario-id>/ 下
   # stdout 最后一行 JSON: {"result":"fail","summary":"...","duration_ms":...}

test.sh --static-check
   # 项目方实现的脚本静态校验（playwright→tsc / go→vet / py→compile）

test.sh --generate <spec-md-path> --out=<script-path>   # 可选
   # 项目内置生成器；不实现则平台兜底用通用 LLM generator
```

> **命名说明**：`--scenario` 而非 `--run`，避免跟"无 flag 默认 run 全套"语义冲突。

#### `build.sh`（ENV 驱动，沿用现状）

完全沿用 ChatOps 现状，无 flag、无子命令、ENV 驱动：

```bash
# 现状: 直接跑 ./build.sh，靠 ENV var 配置
IMAGE_NAME=chatops IMAGE_TAG=test-iter-42 BASE_IMAGE=... ./build.sh

# e2e 调用前 sandbox 已 git checkout 到目标 branch，build.sh 自然产出 branch 对应的镜像
# stdout 最后一行 JSON 期望: {"artifact":"<image-or-path>","kind":"docker-image|tar|..."}
# （现状 build.sh 没输出这个 JSON，需要补一行 echo 在末尾）
```

实施备注：现状 `build.sh` 末尾只 `echo "Size: ..."`，**e2e 接入时需要补一行 stdout JSON**：

```bash
# 在 ChatOps 自己的 build.sh 末尾追加
echo "{\"artifact\":\"${IMAGE_NAME}:${IMAGE_TAG}\",\"kind\":\"docker-image\"}"
```

#### `fix.sh`（可选）

不实现时平台用 git CLI 兜底（`git apply / git commit / git push`，凭据走 `resolveGitlabConfig()`）。如果项目要自定义补丁应用流程（比如多 monorepo workspace 的特殊处理），实现这个脚本：

```bash
fix.sh --branch=<branch> --patch-dir=<dir>
   # patch-dir 下放平台生成的 .patch 文件
   # 在仓库内 apply + commit + push 到 --branch
   # exit 0 = 成功，stdout 最后一行 JSON: {"commitSha":"..."}
```

#### Evidence Dir 协议（关键技术点）

证据走文件系统协议，命令行参数表达不下。`test.sh --scenario` 跑完后 `<evidence-dir>/<scenario-id>/` 下要符合：

```
evidence-dir/<scenario-id>/
  manifest.json          # 必需 — 证据清单
  artifacts/
    <kind>-<seq>.<ext>   # 实际证据文件
```

`manifest.json` 内容：

```json
{
  "summary": "TestE2E_PortForward 在第 2 个连接超时，goroutine 泄漏",
  "contextHint": "Go CLI 项目，无 UI，重点看 stderr / journalctl / goroutine dump",
  "artifacts": [
    { "kind": "stderr", "module": null, "mimeType": "text/plain", "path": "artifacts/stderr-1.txt", "description": "完整 stderr 输出" },
    { "kind": "log",    "module": "payment-svc", "mimeType": "text/plain", "path": "artifacts/payment-svc.log", "description": "payment-svc 日志" },
    { "kind": "screenshot", "mimeType": "image/png", "path": "artifacts/fail-moment.png", "description": "失败时刻截图" },
    { "kind": "har",    "mimeType": "application/json", "path": "artifacts/network.har", "description": "网络请求 HAR" }
  ]
}
```

平台扫这个目录、把 artifacts 上传到 storage、把 manifest 内联进 DB 喂给诊断 LLM。诊断 Agent 是通用 multimodal agent，看 mimeType 决定怎么消费（图给 vision、文本直读）。

`Artifact.module` 字段为多模块产品保留 —— 标记某 artifact 属于哪个模块，诊断 LLM 可对照不同模块日志的时间戳精确定位。

---

## 2. 数据模型

### 2.1 新增表

#### `e2e_target_projects` — 被测项目登记

```sql
CREATE TABLE e2e_target_projects (
  id              TEXT PRIMARY KEY,            -- 'chatops' | 'ssh-proxy' | ...
  display_name    TEXT NOT NULL,
  gitlab_repo     TEXT NOT NULL,               -- 'group/chatops'
  default_branch  TEXT NOT NULL DEFAULT 'main',
  working_dir     TEXT NOT NULL DEFAULT '.',   -- 脚本相对仓库根的目录
  scripts         JSONB NOT NULL,              -- { build: "build.sh", deploy: "deploy.sh", test: "test.sh", fix?: "fix.sh" }
  capabilities    JSONB NOT NULL DEFAULT '{}', -- { generate, fix, multiModule, testFramework, ... }
  default_sandbox_kind TEXT NOT NULL DEFAULT 'docker-compose-local',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### `e2e_specs` — TestSpec markdown 元数据（Stage 1 用）

```sql
CREATE TABLE e2e_specs (
  id                      BIGSERIAL PRIMARY KEY,
  target_project_id       TEXT NOT NULL REFERENCES e2e_target_projects(id),
  spec_path               TEXT NOT NULL,           -- 仓库内路径：docs/test-specs/login.md
  title                   TEXT NOT NULL,
  content_hash            TEXT NOT NULL,           -- sha256，markdown 变了 hash 变 → 触发重新生成
  generated_artifact_path TEXT,                    -- 生成出的 test 脚本路径：tests/e2e/login.spec.ts
  generated_pr_url        TEXT,                    -- Pipeline A 创出的 PR 链接，等人审合并
  generation_status       TEXT NOT NULL,           -- pending | generating | pr_open | committed | baseline_failed | blocked_on_baseline_bug | skipped
  last_generated_at       TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_project_id, spec_path)
);
```

**TestSpec ↔ TestArtifacts 是 1:1 但每文件 1:N scenario**：一个 markdown spec 描述某 feature 的若干场景，生成一个 `.spec.ts` 文件包含多个 `test()` block，每个 block 对应一个 `scenario_id`（来自 spec frontmatter 或 LLM 推导的 ID 列表）。

**`generation_status` 的精确语义**：

| 状态 | 含义 |
|---|---|
| `pending` | 已登记，未开始生成 |
| `generating` | Pipeline A 正在跑 |
| `pr_open` | Pipeline A 已 commit + 创建 PR，等人审合并 |
| `committed` | PR 已合并，脚本 live 在 main |
| `baseline_failed` | baseline self-correct 用尽预算仍失败，等人调脚本 |
| `blocked_on_baseline_bug` | 诊断为产品 bug，已调 `analyze_bug`，等 main 修好 |
| `skipped` | 项目自带测试，跳过 Stage 1 |

`pr_open → committed` 的转移由 GitLab MR webhook 触发（PR merged 事件），独立于 Pipeline A 图。Pipeline B 的 `discover` 看仓库实际状态（main 上有没有这个脚本），跟 spec 状态解耦。

主数据是 git 仓库里的 markdown 文件，表里只跟踪元数据 + 生成状态。**外部项目跳过 Stage 1 时这张表为空**，全部从 `test.sh --discover` 现读 scenario。

#### `e2e_runs` — 一次测试运行

```sql
CREATE TABLE e2e_runs (
  id                 BIGSERIAL PRIMARY KEY,
  target_project_id  TEXT NOT NULL REFERENCES e2e_target_projects(id),
  trigger_type       TEXT NOT NULL,           -- manual | api | scheduled | im
  trigger_actor      TEXT,                    -- 用户 / IM 群 ID / 调度器
  source_branch      TEXT NOT NULL,           -- 起跑时的源 branch（一般 main）
  iteration_branch   TEXT NOT NULL,           -- test-iter/<runId>，bugfix 在它上 commit
  scenario_filter    JSONB,                   -- {"tags":["smoke"]} 或 {"ids":[...]}
  status             TEXT NOT NULL,           -- pending | running | awaiting_fix | passed | failed | aborted
  governor_state     JSONB NOT NULL DEFAULT '{}',  -- 见下方
  summary_mr_url     TEXT,                    -- 全绿后开的汇总 MR
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  abort_reason       TEXT
);

CREATE INDEX idx_e2e_runs_status ON e2e_runs(status) WHERE status IN ('pending','running','awaiting_fix');
CREATE INDEX idx_e2e_runs_project ON e2e_runs(target_project_id, started_at DESC);
```

`governor_state` 例：
```json
{
  "perScenarioAttempts": {"login-success": 1, "create-prd": 3},
  "totalElapsedMs": 1452000,
  "totalAttempts": 8,
  "limits": {"maxPerScenarioAttempts": 3, "maxRunHours": 4, "maxTotalAttempts": 30}
}
```

注：`pingPongLog` 等字段第一期不预留；V2 加 ping-pong 检测时再走 schema-v1001 加更精确字段（如 `pingPongDetected boolean` + `pingPongHistory jsonb`）。

#### `e2e_scenario_runs` — 单场景执行历史

```sql
CREATE TABLE e2e_scenario_runs (
  id                   BIGSERIAL PRIMARY KEY,
  e2e_run_id           BIGINT NOT NULL REFERENCES e2e_runs(id) ON DELETE CASCADE,
  scenario_id          TEXT NOT NULL,           -- 'login-success'
  scenario_name        TEXT,                    -- discover 时拿到的人话名字
  attempt_number       INT NOT NULL,            -- 同一 scenario 在一个 run 里第几次跑
  result               TEXT NOT NULL,           -- pass | fail | error | timeout | skipped | unfixable
  duration_ms          INT,
  evidence_manifest    JSONB,                   -- manifest.json 内联 + e2e-fix 诊断结果（见下）（限 32KB，超大走 evidence_dir_uri）
  evidence_dir_uri     TEXT,                    -- 完整 evidence 目录的存储位置
  linked_bug_report_id BIGINT REFERENCES bug_analysis_reports(id) ON DELETE SET NULL,  -- MVP 永不写;预留
  started_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ,
  UNIQUE (e2e_run_id, scenario_id, attempt_number),
  CHECK (evidence_manifest IS NULL OR length(evidence_manifest::text) < 32768)
);

CREATE INDEX idx_e2e_scenario_runs_run ON e2e_scenario_runs(e2e_run_id, scenario_id);
CREATE INDEX idx_e2e_scenario_runs_failed ON e2e_scenario_runs(e2e_run_id) WHERE result IN ('fail','error');
```

**不维护 `e2e_scenarios` 主表**。scenario source-of-truth 是被测项目仓库（`test.sh --discover` 现读），平台不重复维护。

**`evidence_manifest` JSONB 扩展字段**（MVP 用 e2e-fix llm_agent 替代 bugfix capability 后增加的子字段）：

```json
{
  "summary": "...",
  "contextHint": "...",
  "artifacts": [...],
  "aiDiagnosis": {                          // ← MVP 新增，e2e-fix llm_agent 节点输出
    "verdict": "product_bug" | "test_flakiness" | "infra_issue" | "uncertain",
    "rootCauseSummary": "...",              // 一句话根因
    "fixCommitSha": "abc1234" | null,       // 成功时填
    "fixedFiles": ["src/agent/x.ts", ...],  // 改了哪些文件
    "success": true | false,
    "failureReason": "..."                  // success=false 时填
  }
}
```

诊断结果跟 evidence 一起内联落表，不另开 bug_analysis_reports / GitLab issue。

#### `e2e_sandboxes` — 沙盒记录

```sql
CREATE TABLE e2e_sandboxes (
  id           BIGSERIAL PRIMARY KEY,
  e2e_run_id   BIGINT REFERENCES e2e_runs(id) ON DELETE SET NULL,   -- 删 run 时保留沙盒记录作为审计
  kind         TEXT NOT NULL,                  -- docker-compose-local | k8s-namespace | remote-multi-host | ...
  handle       JSONB NOT NULL,                 -- deploy.sh provision 的 handle 输出
  status       TEXT NOT NULL,                  -- provisioning | ready | redeploying | torn_down | failed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at     TIMESTAMPTZ,
  destroyed_at TIMESTAMPTZ
);

CREATE INDEX idx_e2e_sandboxes_run ON e2e_sandboxes(e2e_run_id) WHERE status NOT IN ('torn_down','failed');
```

第一期 sandbox 跟 run 1:1。

### 2.2 现有表扩展

#### `bug_analysis_reports`（已有）— **MVP 不改**

> **MVP 决策**：e2e 模块用**独立的 e2e-fix llm_agent 节点**修复（详见姊妹文档 `pipeline-b.md` §4.3），**不调 bugfix capability**，因此**不需要给 `bug_analysis_reports` 加列**。e2e 失败的诊断结果直接存 `e2e_scenario_runs.evidence_manifest.aiDiagnosis` JSONB 字段，不开新表也不改老表。

如果未来某 Phase 想接回 bugfix capability（不在路线图，仅作架构口子说明），届时再加 ALTER。

#### `pipeline_node_types`（已有 12 种）+ 1 种

| 新节点 | 描述 |
|---|---|
| `invoke_target_script` | 通用 — 调被测项目的某个脚本，按 stdout JSON / exit code 协议解析。**所有项目特异性走这个节点**。**仅作为 pipeline node 注册，不暴露为 MCP 工具** |

**不新增 `loop` 节点**：Pipeline B 主循环用 LangGraph **原生 `conditional_edge` 自循环**（main_switch 节点的条件边连回自己），这是 LangGraph 子图 + checkpointer 上下文里唯一被验证可行的循环范式（fan_out 已明确禁套 interrupt 子节点，见 `src/pipeline/node-types/fan-out.ts` 注释）。"loop 节点"不登记进 `pipeline_node_types`，避免画布渲染暴露给用户编辑。

#### `internal_capability_pipelines`（已有）+ 新映射

新增 capability（**Phase 1 包含两条**）：

- `e2e_run` → 映射到 Pipeline B（test-and-fix loop）
- `e2e_generate_script` → 映射到 Pipeline A（generator + baseline self-correct + auto-merge）

dogfood 时给 ChatOps 项目登记两条映射；外部项目接入时再追加。

### 2.3 状态机

#### `e2e_runs.status`

```
                    ┌─────────────────────────────────────────────┐
                    ▼                                              │
pending ──► running ──► awaiting_fix ──► running（重跑同 scenario）
   │           │              │                                   │
   │           │              └──► aborted（governor / 人手）
   │           │
   │           ├──► passed（全场景绿）
   │           │
   │           └──► failed（governor 决定永久失败）
   │
   └──► aborted（创建后未启动就取消）
```

#### `e2e_sandboxes.status`

```
provisioning → ready → redeploying ⇄ ready → torn_down
                  │                        │
                  └──► failed ◄────────────┘
```

### 2.4 Schema 文件

**Schema 编号策略**：本模块用 `v1000` 开头独立段位，跟主干 `v1..v59+` 永远不撞号。

**Phase 1 — `src/db/schema-v1000.sql` 内容**：

- `CREATE TABLE` **4 张新表**：
  - `e2e_target_projects`
  - `e2e_specs`
  - `e2e_runs`
  - `e2e_scenario_runs`
  - `e2e_sandboxes`
- **硬编码 `INSERT INTO e2e_target_projects`** 一行 chatops 项目（dogfood）
- **不改 `bug_analysis_reports`**（MVP 用 e2e-fix llm_agent 节点替代 bugfix capability，详见姊妹文档 `pipeline-b.md` §4.3）
- `INSERT INTO pipeline_node_types` 1 个新节点（`invoke_target_script`；不新增 `loop`）
- `INSERT INTO internal_capability_pipelines` 2 条映射（`e2e_run` → Pipeline B；`e2e_generate_script` → Pipeline A）
- **末尾追加** `pipeline_node_types.enabled` 行数 ≥ 13 的硬断言（跟 schema-v35 同形式）

**两份 SCHEMA_FILES 列表都要追加**：

```typescript
// src/db/migrate.ts
const SCHEMA_FILES = [
  // ...
  ['v59', 'schema-v59.sql'],         // 主干当前最高
  ['v1000', 'schema-v1000.sql'],     // ← 自动化测试模块起点
] as const

// src/__tests__/helpers/db.ts
// 同步追加 v1000（新表非污染、catalog seed 干净，符合 CLAUDE.md
// "全新表 + 非污染 catalog seed 才能加进 helper" 标准）
```

**v1000 段位的取舍说明**：相比直接走 v60+，v1000 段位的代价是「两份 SCHEMA_FILES 列表都要维护」+「未来 v1001 表被主干 capability 引用时还得绕回」。但 ChatOps 自动化测试是个独立模块，按 1000 段位起步更清晰、合并 main 时永不撞号，**第一期值这个权衡**。如果未来出现"模块跨段位互相引用"的场景，按 CLAUDE.md 主干表 ALTER 的原则继续走主干编号即可。

**未来本模块迭代**：本模块独占表（`e2e_*`）的演进走 `v1001 / v1002 / ...`；主干表（如 `bug_analysis_reports`）的后续 ALTER **仍然走主干编号**。两条线物理分离。

### 2.5 关键决策（明示选择 + 理由）

| 决策 | 选择 | 理由 |
|---|---|---|
| `evidence_manifest` 内联 vs 仅存 URI | 内联 JSONB | manifest 一般几 KB；放表里支持"找出 stderr 提到 'panic' 的失败"这种查询 |
| 维护 `e2e_scenarios` 主表？ | 不 | scenario source-of-truth 是项目仓库；平台跟踪"运行历史"就够 |
| sandbox 跟 run 1:1 还是 1:N？ | 第一期 1:1；未来改 N:1 不破坏 schema | YAGNI |
| 状态机精细度 | 6 个：`pending / running / awaiting_fix / passed / failed / aborted` | 瞬态（`provisioning` / `redeploying`）当成 `running` 细分，看 sandbox.status |
| `governor_state` 单独表还是 JSONB？ | JSONB | 字段会随 governor 策略演进，schema 频繁加列代价高 |
| 同一 scenario 多次 attempt 怎么编号 | `(e2e_run_id, scenario_id, attempt_number)` 唯一 | 重跑历史完整保留 |
| TestSpec 是否必须存表 | 是，为了 Stage 1 跟踪生成状态 + content_hash 去重 | 跳过 Stage 1 项目这张表为空 |

---

## 3. Pipeline A — Test Generator

> **测试脚本准确度是整个闭环的根基**。如果脚本错了，下游"自动诊断 + 自动修复"会被污染（误诊为产品 bug → bugfix 修了不该修的代码）。**baseline self-correct 是工程必要项**，是区分"脚本 bug vs 产品 bug"的唯一可行办法。
>
> 本期包含：generator + static_check + baseline self-correct + commit + auto-merge + `e2e_specs` 表 + `/e2e-specs` 管理页 + `e2e_generate_script` capability。

### 3.1 输入与触发

```typescript
interface GenerateTestRequest {
  targetProjectId: string             // 'chatops'
  specPaths: string[]                 // 一次可处理多个 spec
  baseBranch?: string                 // 默认目标项目的 default_branch
}
```

**触发途径**：UI 测试规约页 / IM `@bot 生成测试 docs/test-specs/login.md` / content_hash 自动（第一期不实现）。

**不创建 `e2e_runs` 记录**。Pipeline A 状态全在 `e2e_specs` 表 + 图 state attempt counter。

### 3.2 整体图

```
START
  ▼
[init_generation]                — 在 e2e_specs 写/更 generating 状态
  ▼
[fan_out: per spec]              — 各 spec 独立子图（第一期 max_concurrency=1 串行）
  ▼
[generate_or_skip]               — switch: 项目自带 generate? 走项目 : 走平台兜底
  ├─ 项目: [invoke_target_script: test --generate]
  └─ 兜底: [llm_agent: 平台 LLM 生成]
  ▼
[static_check]                   — invoke_target_script: test --static-check
  │ 不过 → [llm_agent: 修脚本] → static_check（≤2 次）
  ▼
[setup_baseline_sandbox]         — invoke_target_script: deploy provision --branch=<baseBranch>
  ▼
[deploy_baseline]                — build → package → deploy 三步串联
  ▼
[run_baseline_check]             — invoke_target_script: test --run <scenarioId>
  ▼
[switch: baseline 通过?]
  ├─ 是 → [commit_and_pr]        — 创 PR，标 generation_status=pr_open
  │       ▼ (finally) [teardown_sandbox] → END (success)
  │
  └─ 否 → [llm_agent: 诊断]      — 判 'script_bug' | 'product_bug'
           ├─ script_bug  → [llm_agent: 修脚本] → run_baseline_check
           │                              ├─ 重试 ≤ 3 → 还失败 → 标 baseline_failed → END
           │                              └─ 通过 → commit_and_pr
           │
           └─ product_bug → [coordinator.triggerCapability('analyze_bug')]
                            标 generation_status='blocked_on_baseline_bug'
                            (finally) → END

任何错误路径汇 → [teardown_sandbox]
```

### 3.3 Baseline self-correct 的关键点

**为什么要这步**：AI 生成的脚本经常 selector 错、断言写错、时序假设错。如果直接 commit 进 main，下次 Pipeline B 跑这个 scenario 失败 → 误诊为产品 bug → bugfix 流水线"修了根本没坏的代码"。**baseline 自检是工程上唯一能区分"脚本 bug vs 产品 bug"的可行办法**。

**诊断 LLM 的判定**：
- 默认信念：baseline 应该是绿色的，所以失败更可能是脚本错
- 但允许诊断到 `product_bug` —— 罕见但合法（baseline 真有回归）
- `script_bug` 进入修脚本循环；`product_bug` 调 `analyze_bug` 走常规 bugfix，把这个 spec 暂停

### 3.4 Governor

存图 state 不入表：

| 预算 | 默认 | 超了之后 |
|---|---|---|
| `static_check_attempts` | 2 | 标 `baseline_failed` |
| `baseline_attempts` | 3 | 标 `baseline_failed`，保留 evidence 给人 review |

### 3.5 跟 Pipeline B 的解耦

A 完成的判定：**生成的脚本 commit 进了仓库 + 自动 merge 进 main**。后续 PR 合并由平台自动驱动（不走人审），spec 状态在自动 merge 后立刻变 `committed`。

- A 完成后 spec 状态 `pr_open`（PR 已创建）；CI 通过后**平台自动 merge** → 状态变 `committed`
- B 启动时 `test.sh --discover` 现读仓库**实际状态**（main 上是否有该脚本），不直接读 spec 状态
- spec 标 `blocked_on_baseline_bug` 时 B discover 不会有这个 scenario（脚本根本没 commit），UI 提示「该 spec 被 main 上的 bug 阻塞」

**git / MR 凭据**：`commit_and_pr` 节点跑 `git push` + `glab mr create` 时**必须走 `resolveGitlabConfig()`**（`src/config/gitlab.ts`）读 token / URL，不能裸用 `process.env.GITLAB_URL`（CLAUDE.md 硬约束）。

### 3.6 测试脚本自动 merge（不走人审）

**关键产品决策**：Pipeline A 生成的测试脚本 PR **由平台自动 merge**，不像产品代码 PR 那样需要人审。理由：

1. **不是产品代码** — 测试脚本错了不会破坏线上业务，最多 Pipeline B 跑出假阳/假阴
2. **已经过 baseline self-correct** — 内部循环已经在 baseline branch 上验证过 scenario 通过，相当于"机器自审"
3. **下次 baseline 会再筛一遍** — content_hash 变 → 重新跑 Pipeline A → 还是会过 baseline 才能 commit
4. **人审会拖死 dogfood** — 5 人小团队周末/出差/假期堆叠，PR 卡 1 周很常见，spec 状态卡死、改 markdown 触发新 PR 时 reviewer 看到俩页面搞不清

**自动 merge 流程**：

```
[commit_and_pr] → 创 PR + push iteration_branch
       ▼
[wait_for_ci] → 等仓库 CI（lint / typecheck）通过；超时 30min
       ▼
[auto_merge]  → glab mr merge --auto / API merge；merge 完毕 spec 状态 → committed
       ▼
[notify_im]   → IM 推一条 "✅ 已生成并合入测试脚本：<spec name>"，附 PR 链接给人事后看
```

**同 spec 卡 pr_open 时不再触发新生成**：cron 扫到 `generation_status='pr_open' AND last_generated_at < NOW() - 30min` 还没合的 PR → 调试日志告警（多半是 CI 卡了），不重启 generation。

人手撤销路径：admin 在 UI 上对个别 spec 标"暂停自动 merge"，回到老的人审模式（用于发现 generator 反复出错时的 brake）。

### 3.9 本期范围

**做**：平台兜底 generator / static_check / baseline self-correct / commit + PR + **自动 merge** / 单 spec 触发

**不做**（推后）：
- 多 spec 并行（max_concurrency=1）
- content_hash 自动触发
- 项目侧 `--generate` 实现入口（外部项目接入时按需）
- TestSpec 模板 + lint
- Playwright codegen 录制入口（第二种 spec 来源）

---

## 5. 前端 UI 与 IM 入口

### 5.1 页面拓扑

```
/admin
  ├─ /e2e-targets        被测项目登记（第一期：只读详情，单行 chatops 硬编码）
  ├─ /e2e-specs          测试规约管理（Pipeline A 入口 + 状态）
  ├─ /e2e-runs           E2E 运行列表
  └─ /e2e-runs/:runId    E2E 运行详情（核心页）
```

侧边栏新增「自动化测试」菜单。**注意**：现有 `/test-runs` 是流水线测试运行（test_runs 表）的不同概念，本模块全部用 `e2e-` 前缀避免歧义。

### 5.2 `/e2e-targets`（第一期：只读详情 + 单行硬编码）

第一期不实现完整 CRUD UI。`e2e_target_projects` 表里**硬编码一行 chatops**（schema-v1000.sql 里 `INSERT` 进去），UI 只提供**只读详情页**展示该项目的 scripts 路径 / capabilities / sandbox kind / GitLab 仓库链接。每个脚本路径调 GitLab API 现查存在性，UI 上 ✓/✗ 标记。

**完整 CRUD 推迟到 V2**（ssh-proxy 接入时一起做）—— 第一期只一个项目，没必要做表格 + 表单 + lint 工具，**省一周开发**。

### 5.3 `/e2e-specs`（Pipeline A 入口）

列表 + 操作：
- 状态 Badge: `pending / generating / pr_open / committed / baseline_failed / blocked_on_baseline_bug / skipped`
- 「生成」/「重生成」触发 Pipeline A
- 「查看 baseline 失败 evidence」（仅 baseline_failed）
- 「查看脚本」跳到 GitLab 文件
- 「跳过 Stage 1」开关

markdown spec 内容主数据是 git 仓库，UI 通过 GitLab API 现读。

### 5.8 本期范围（仅 Pipeline A 相关 UI）

**做**：
- `/e2e-specs` 管理页（spec 列表 + 状态徽章 + 「生成」/「重生成」按钮 + baseline 失败 evidence 查看 + 跳转到生成的 PR）
- `/e2e-targets` 只读详情（chatops 一行硬编码）

**不做**（推后）：
- TestSpec 模板创建 / lint UI 提示
- in-page markdown 编辑器
- e2e-targets 完整 CRUD
- 「Lint 接入」按钮

> Pipeline B 相关的 `/e2e-runs` 列表 / 详情页 / IM 入口 / 通知策略见姊妹文档 `pipeline-b.md` 的 §5.4-§5.8。

---

## 6. 部署、测试、风险与第一期里程碑

### 6.1 部署 & 运行时考量

#### 沙盒怎么起 — 独立 docker network + 强制 token 覆盖 + sentinel

第一期沙盒 `docker-compose-local`，宿主就是 ChatOps 自己的容器。需要在 ChatOps 容器里调 docker socket（commit `cc2a62f` 已挂载）。

但**绝不能直接复用宿主的 network / 配置**。每个 run 的沙盒按下面隔离：

| 隔离维度 | 做法 |
|---|---|
| Docker network | 独立 network `chatops-e2e-sandbox-<runId>`，跟生产 network 不连通 |
| 端口分配 | **`find-free-port` 动态分配**（不用 `13000 + runId%1000` 模数 — 第 1001 个 run 会撞）；分配结果写进 sandbox handle |
| DB URL | `deploy.sh provision` 强制覆盖 `DATABASE_URL` 指向沙盒内的临时 PG，**不继承宿主环境** |
| Claude OAuth token | `E2E_SANDBOX_CLAUDE_TOKEN`（专门测试租户的 token；不要用真生产 token；缺省时走 `_e2e.ts` 已有的 Claude mock 端点）|
| IM token | 强制覆盖为测试租户（钉钉 / 飞书各有 sandbox app）；缺省时禁用 IM 通道（沙盒里 chatops 不发 IM 消息）|
| GitLab token | 强制覆盖为测试租户 / 测试项目；用 `_e2e.ts` mock 时不需要真 token |

**Sentinel 检查**：沙盒启动后 chatops 第一次跑数据库 migration 前**必须**校验：

```sql
SELECT current_database()    -- 必须是 sandbox-pg-<runId>，不能是生产库名
```

任一 token / DB URL 没被覆盖就拒启动（启动时跑 sentinel 函数，失败直接 exit non-zero）。这道防线避免 sandbox 里的 chatops 误连生产 DB / 误打真 IM / 误 push 真 GitLab。

#### Evidence 存储 + secrets 脱敏

第一期本地 fs：`/var/chatops/e2e-evidence/<runId>/<scenarioId>/<attempt>/`。Fastify static 路由 `/admin/e2e-runs/:runId/evidence/...` 暴露给 UI（仅限已登录 admin）。每个 run 完成 + 30 天后 cron 自动清理。第二期切 S3/MinIO 时换 URI scheme，节点和 UI 不动。

**evidence 上传前 mask sensitive info**（M4）：sandbox 里收集的 stderr / log / journalctl 经常带 token / 密码。在 `[collect_evidence]` 节点拷贝出来后、上传到 storage 前，**对所有 `mimeType: text/*` 类 artifact 跑一遍 `mask()`**（`src/agent/masking/sensitive-info.ts`）。二进制 artifact（截图 / coredump）不动 —— 截图本身可能包含 token UI，evidence 详情页查看时 admin 自己负责（不再加二次脱敏）。

#### 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `E2E_SANDBOX_DOCKER_HOST` | `unix:///var/run/docker.sock` | 起沙盒的 docker daemon |
| `E2E_EVIDENCE_ROOT` | `/var/chatops/e2e-evidence` | evidence 落地根目录 |
| `E2E_EVIDENCE_RETENTION_DAYS` | `30` | 自动清理阈值 |
| `E2E_DEFAULT_MAX_RUN_HOURS` | `4` | governor 默认 |
| `E2E_DEFAULT_MAX_PER_SCENARIO_ATTEMPTS` | `3` | governor 默认 |
| `E2E_DEFAULT_MAX_TOTAL_ATTEMPTS` | `30` | governor 默认 |
| `E2E_DEFAULT_MAX_QUEUED_RUNS` | `2` | 排队上限，超了拒绝触发 |
| `E2E_RUN_CONCURRENCY` | `1` | 第一期固定 1 |
| `E2E_SANDBOX_CLAUDE_TOKEN` | (空) | 沙盒里 chatops 用的 Claude token；空时走 `_e2e.ts` mock |
| `E2E_SANDBOX_IM_DISABLE` | `true` | 沙盒里 chatops 是否禁用 IM 通道（避免误推消息）|

走 `src/config.ts` 的 Zod 校验。

### 6.2 自动化测试自身的测试

| 层 | 怎么测 | 用什么 |
|---|---|---|
| `invoke_target_script` 节点 | 单测：mock 子进程 stdout/exit code | vitest，无 DB |
| Governor 逻辑 | 单测：构造各种 governor_state（含队列拒绝）| vitest，无 DB |
| Bugfix 改造（fix-runner / branch-manager / fix-logic）| 单测：iterationBranch / skipMr / checkout 已存在 branch | vitest |
| Bugfix 集成 | 集成测：在测试 GitLab 项目 push 到 test-iter branch + 不创 MR | vitest + testcontainer pg + 测试 GitLab 项目 |
| Pipeline B 图 | 集成测：mock 所有 invoke_target_script，跑完整图（含 reset_iteration_branch / e2e_fix_agent）| vitest + testcontainer pg |
| Pipeline A 图 | 同上 | |
| Startup recovery | 单测：构造 inflight runs（status='running' / 'awaiting_fix'），调 recovery 函数 → 全部 aborted + teardown 调用 | vitest + testcontainer pg |
| Run abort 清理顺序 | 集成测：触发 abort → 验证 status / sandbox teardown / branch delete / issue close 调用顺序 | vitest |
| Sentinel 校验 | 单测：连真生产库名时拒启动 | vitest |
| 端到端 dogfood | 1 spec → A 生成 → 故意改坏一个文件 → B 跑通自动修复；中间 kill chatops 验 recovery | 手工，里程碑验收 |

**关键约定**：所有 invoke_target_script 测试**走 mock 子进程接口**（注入假 spawn），不真起 docker / 跑 playwright。真实"跑沙盒 + Playwright"只在端到端 dogfood 跑一次。

### 6.3 风险清单 & 缓解

| 风险 | 严重 | 缓解 |
|---|---|---|
| **沙盒里的 chatops 误打真生产** | 🔴 高 | §6.1 三道防线：独立 docker network + 强制覆盖 token / DB URL + 启动 sentinel 校验 `current_database()` |
| **进程重启时 awaiting_fix run 卡死** | 🔴 高 | 强制 startup recovery hook：扫表 → 全部标 aborted + teardown sandbox + delete branch（详见姊妹文档 `pipeline-b.md` §4.7）。**周 1 不可省略** |
| **e2e-fix llm_agent 在沙盒 docker exec 上下文里跑 Claude CLI** | 🟡 中 | 周 1 验证：(a) claude-runner 加 dockerExec 选项跑通；(b) Claude 工具能力（Read/Edit/Bash）在容器内正常使用；(c) commit + push 到 iterationBranch 凭据可用。Fallback：失败时直接标 unfixable，不阻塞 run |
| **e2e-fix prompt 写得不好导致修复成功率太低** | 🟡 中 | prompt 借用 `superpowers:debug-fix` skill 内容做精简版；周 1 写 + 周 5 dogfood 验收测真实修复成功率 |
| **Playwright 跑 chatops 自身需要测试账号 + IM 模拟** | 🟡 中 | 复用 `_e2e.ts` mock 端点；Playwright 不通过真 IM，直接 POST `_e2e.ts` 的 inject 端点 |
| AI 生成的脚本反复过不了 baseline | 🟡 中 | governor `baseline_attempts ≤ 3`；UI 留 evidence 给人调脚本 |
| 沙盒资源耗尽 | 🟡 中 | `E2E_RUN_CONCURRENCY=1`；teardown 严格幂等；监控 disk / memory |
| Evidence 文件爆磁盘 | 🟢 低 | 30 天 retention cron；单 run > 100MB 警告；mask 后文本 artifact 通常不大 |
| Evidence 里 secrets 泄露 | 🟢 低 | §6.1 收 evidence 时对所有 `text/*` artifact 跑 mask() |

**最高优先级是前 2 条**：沙盒安全、进程重启 recovery。三者任一缺失，第一期就上不了线。

### 6.4 Phase 1 里程碑（Pipeline A 视角）

> 完整 5 周里程碑见合并版 `phase1.md` §6.4。本文档仅列 Pipeline A 直接相关的周次。

| 周 | 重点 | Acceptance Criteria（具体到可验证条目）|
|---|---|---|
| **周 1（共享基础）** | DB schema + 通用节点 + claude-runner dockerExec | • [DB] schema-v1000.sql 上线（**4 张表 + chatops 硬编码登记 + invoke_target_script 节点 + e2e_generate_script capability 映射**），`pipeline_node_types` enabled ≥ 13 断言通过<br>• [claude-runner dockerExec] 给 `src/agent/claude-runner.ts` 加 `dockerExec` 选项（Pipeline A 的 baseline self-correct 也用 dockerExec 跑沙盒里 playwright）<br>• [节点] `invoke_target_script` 单测（mock spawn，验 stdout JSON / exit code 解析）|
| **周 2（共享基础）** | ChatOps 自身 deploy/test/build 脚本扩子命令 + 沙盒安全防线 | • `chatops/deploy.sh` 新增 `provision / teardown / healthcheck / deploy / redeploy` 子命令<br>• `chatops/test.sh` 新增 `--discover / --scenario / --static-check` flag<br>• `chatops/build.sh` 末尾追加 stdout JSON 行<br>• 本地手工 `./deploy.sh provision && ./deploy.sh deploy && ./test.sh --discover` 跑通<br>• Sentinel：沙盒里 chatops 启动时校验 `current_database()`，连到生产库时拒启动<br>• 沙盒 docker network 独立 + 端口动态分配可验证 |
| **周 3（Pipeline A 主线）** | Pipeline A 完整（generator + baseline self-correct + auto-merge）+ `/e2e-specs` 页 | • Pipeline A 集成测过：mock LLM 输出，跑完整图（generate → static_check → setup_baseline_sandbox → run_baseline_check → 通过分支 / 失败诊断 → script_bug 修脚本循环 / product_bug 调 analyze_bug → commit_and_pr → wait_for_ci → auto_merge）<br>• `e2e_specs` 表 + `e2e_generate_script` capability 跑通<br>• `/e2e-specs` 列表页 + 「生成」按钮 + 状态 Badge<br>• 端到端手工：写 1 份 markdown spec → 触发生成 → 看到 `tests/e2e/<id>.spec.ts` 自动 commit + 自动 merge 到 main<br>• baseline 故意失败时：诊断 LLM 能正确判 `script_bug` vs `product_bug` |
| **周 5（验收）** | Pipeline A dogfood 验收 | • 至少 1 份 markdown spec 走完整 Pipeline A → 自动 merge 到 main<br>• baseline self-correct 成功率手工统计（dogfood ROI 数据点之一）|

**Pipeline A done 的标志**：
1. 至少 1 份人写 markdown spec 通过 Pipeline A 完整跑通：生成 → static_check → baseline self-correct → commit + auto-merge 到 main
2. baseline self-correct 能在脚本 bug 时正确改脚本、产品 bug 时调 analyze_bug 派单（决策正确率手工 review）
3. 生成的 .spec.ts 文件可直接被 Pipeline B（姊妹文档）作为输入

> 周 4（Pipeline B 图 + IM 单句）和 周 5 的 Pipeline B dogfood 部分见姊妹文档 `pipeline-b.md`。

---

### 6.5 指标与日志（可观察性）

#### 6.5.2 工程指标（Prometheus）

| 指标 | 类型 | label |
|---|---|---|
| `e2e_run_total` | counter | `target_project, status` (passed/failed/aborted) |
| `e2e_run_duration_seconds` | histogram | `target_project, status` |
| `e2e_scenario_run_total` | counter | `target_project, scenario_id, result` |
| `e2e_bugfix_attempt_total` | counter | `target_project, scenario_id, success` (true/false) |
| `e2e_sandbox_provision_seconds` | histogram | `target_project, kind` (p50/p95) |
| `e2e_governor_abort_total` | counter | `target_project, reason` (over_per_scenario / over_total_time / over_total_attempts / queue_full) |
| `e2e_evidence_size_bytes` | histogram | `target_project, scenario_id` |
| `e2e_run_queue_size` | gauge | (无 label，全局)|
| `e2e_llm_token_total` | counter | `pipeline` (A/B), `node` (generate/diagnose/...) — **成本监控用** |

#### 6.5.3 Structured log 关键字段

每条 e2e 模块的 log 都必须带：

```json
{ "module": "e2e", "runId": 42, "scenarioId": "login-success", "attempt": 2, "stage": "e2e_fix_agent", ... }
```

便于按 runId 抽时间线，按 scenarioId 抽 attempt 轨迹。沙盒里 chatops 自己的 log 走 docker logs `chatops-e2e-sandbox-<runId>`，平台扫这个标签拉沙盒视角的 log（evidence 收集时一并落到 evidence dir）。

### 6.6 预算与成本控制

每次 e2e run 调多少次 LLM、跑多久 sandbox、占多少 disk，没成本意识 LLM quota 会跑爆。

#### 6.6.1 单次 run 成本预估（dogfood 单模块基线）

| 项 | 估算 |
|---|---|
| LLM token 消耗 | 平均：10 scenario × （1 次诊断 ~5K + 1 次 fix prompt ~10K + 0-2 次 fix retry）≈ 200K-400K token / run |
| Sandbox 持续时间 | 平均 30 分钟 ~ 4 小时 |
| Disk evidence | 平均 50 MB / run（截图 + log），失败多的可达 200 MB |
| Compute（沙盒 docker）| 1 vCPU + 1 GB RAM 持续 |

#### 6.6.2 硬性预算（防止跑爆）

| 限制 | 默认 |
|---|---|
| **单 run LLM token 上限** | `E2E_RUN_TOKEN_BUDGET=2_000_000`（约 200 美元等价；超了 governor 触发 over_budget）|
| 单 run evidence 上限 | `E2E_RUN_EVIDENCE_MB=500`（超了停止收集新 evidence，写一行警告进 manifest）|
| 单 run docker CPU/MEM | docker run --cpus=2 --memory=2g 限制 |

`e2e_llm_token_total` 指标接 alert：单日总 token 超过阈值发 IM 告警给 platform admin。



### 6.9 撤回 / sunset 路径

如果 dogfood 验收失败 / 团队不爱用，怎么回退？避免变成另一个无人维护的内部工具。

**Sunset 触发条件**（任一满足，platform admin 决定是否触发）：

- dogfood 验收完成后**3 个月内**触发 e2e 的 MR 数 < 总 MR 数的 10%（重测覆盖率严重低）
- AI 修复成功率持续 < 30%（修不好反而拖人时）
- 团队反馈"导致工作流变慢"占比 > 50%

**Sunset 流程**（如果触发）：

1. 公告：在 IM 群 + admin 看板挂横幅"E2E 模块已停用"
2. 关掉 GitLab MR webhook 自动触发（保留 IM / UI 入口给人主动用）
3. 1 个月观察期：是否有人主动用？
4. 如仍无人用 → 关 IM / UI 入口（保留 schema 和 evidence 历史可查）
5. 6 个月没人用 → schema-v1000+ 整段标记 deprecated，未来一次大重构清理

**架构上的 sunset 友好性**：本模块全部 schema 在 v1000 段位独立，整模块下线**不影响主干**。这是 v1000 段位决策的额外好处。

---

## 附录 A — 名词对照（避免混淆）

| 名词 | 在本设计里的含义 |
|---|---|
| TestSpec | 人写的 markdown 验收规约（输入）|
| TestArtifacts | 可执行测试脚本（Pipeline A 输出 / 项目自带）|
| TargetSystem | 被测项目，由仓库里的 5 个 shell 脚本契约定义 |
| Pipeline A | Test Generator pipeline |
| Pipeline B | Test-and-Fix Loop pipeline |
| iteration_branch | `test-iter/<runId>`，bugfix 在这里 commit |
| sandbox | 一次 run 起的隔离环境（第一期 docker-compose 单机）|
| sandbox handle | `deploy.sh provision` 输出的 JSON，记录环境元信息 |
| Evidence | 失败现场的证据集合（manifest.json + artifacts/）|
| Governor | run-level 的回路保护机制（重试上限 / 总时长 / 总尝试数）|
| affected_modules | bugfix 修了哪些模块，给增量 redeploy 用（多模块产品）|

## 附录 B — 与现有架构的集成清单

| 现有机制 | 怎么复用 / 改造 |
|---|---|
| LangGraph Pipeline 引擎（`src/pipeline/`）| Pipeline A / B 都是 LangGraph，复用现有 graph-builder / graph-runner / interrupt-resume / `wait_webhook`（仅 PRD/IM input 用，本模块第一期不用）。Pipeline B 主循环用 LangGraph 原生 `conditional_edge` 自循环 |
| `_e2e.ts` mock 端点 | Playwright 跑 ChatOps 自身时通过这些端点注入 IM 消息 / 模拟 Claude 响应；沙盒里 chatops 的 Claude mock 也走这套 |
| Bugfix capability `analyze_bug` / `src/agent/fix/*` | **MVP 完全不调用 / 不改造**。e2e 闭环用独立的 e2e-fix llm_agent 节点替代（详见姊妹文档 `pipeline-b.md` §4.3）。永远不接 bugfix capability（A 决策）|
| `claude-runner.ts`（现有 Porygon-based Claude CLI 调用）| **新增 dockerExec 选项**（详见姊妹文档 `pipeline-b.md` §4.3.4）：让 claude 在指定 docker 容器内 cwd 跑，工具调用（Read/Edit/Bash）在容器里执行 |
| `internal_capability_pipelines` 映射 | 新增 `e2e_run` / `e2e_generate_script` 两条映射 |
| IM-Driven Pipeline Flow | `e2e_run` capability 走现有 IM input 多轮 interrupt 路径（im_input 节点真用 LangGraph interrupt；本模块的 e2e_fix_agent 是同进程 await，不用 interrupt）|
| `pipeline_node_types` 表 | 新增 `invoke_target_script` 一个 node 类型；不新增 `loop`（用 LangGraph 原生 conditional_edge）|
| stage log SSE（commit `73f9759`）| 第一期不复用，详情页走 5s polling 兜底 |
| `resolveGitlabConfig()`（`src/config/gitlab.ts`）| commit / push / 创 MR 的代码统一走它读 GitLab token（CLAUDE.md 硬约束）—— `[init_run]` `[reset_iteration_branch]` `[create_summary_mr]` `[commit_and_pr]` 节点都受此约束 |
| `mask()`（`src/agent/masking/sensitive-info.ts`）| `[collect_evidence]` 节点对所有 `text/*` artifact 跑 mask，避免 evidence 泄露 token |
| 现有 `chatops/build.sh / build-base.sh / deploy.sh / test.sh` | dogfood 时**完全沿用现状文件 + 扩子命令**（不新增脚本文件）：`deploy.sh` 加位置参数 `provision / teardown / healthcheck / deploy / redeploy`；`test.sh` 加长选项 `--discover / --scenario / --static-check / --generate`；`build.sh` 末尾追加 stdout JSON。命名规范跟现状对齐（`deploy.sh` 位置参数风格、`test.sh` 长选项风格、`build.sh` 纯 ENV 驱动） |
| Server startup hook | **新增** `recoverInflightE2eRuns()`（详见姊妹文档 `pipeline-b.md` §4.7）—— 进程启动时扫 inflight runs 全部标 aborted + teardown，**不可省略** |
