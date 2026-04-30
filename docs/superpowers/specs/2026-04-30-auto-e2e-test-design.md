# 端到端自动化测试 + 自动修复回路 — 设计文档

> 立项日期：2026-04-30  
> 状态：设计稿，待审  
> 关联：现有 bugfix 流水线、PRD 流水线、Pipeline 引擎（LangGraph）

## 0. 目的与范围

### 目的

在 ChatOps 平台上实现**真实场景化端到端测试 + 自动诊断 + 自动修复 + 重跑直至全绿**的同步闭环。

第一期 dogfood 跑 ChatOps 自身（被测=本仓库），架构留口子支持外部项目（如 ssh-proxy 这类纯 CLI、无 UI 的 Go 项目）接入。

### 不在本期范围

- 多模块多机环境编排（独立立项，本期只做 `docker-compose-local` 单机沙盒，contract 留好供后续替换实现层）
- ssh-proxy 等外部项目接入（验证 contract 通用性，第二期）
- PRD → TestSpec 自动派生（第四期）
- 跨项目 dashboard（多项目接入后再做）
- 资源池调度 / scenario 并行（第二期）

### 关键决策汇总

| 决策点 | 选择 |
|---|---|
| 被测对象 | 第一期 ChatOps 自身；架构支持外部项目接入 |
| 测试场景表达 | 脚本骨架 + AI 探索补充（混合）|
| 失败回路范式 | 同步闭环：一次 run 跑到全过 |
| 被测环境形态 | 临时沙盒（每次 run 起一份隔离环境）|
| 场景库源头 | 人手维护的 markdown 规约（架构留口子给 PRD 派生 / AI 探索）|
| 浏览器驱动 | Playwright + Playwright MCP（AI 探索时通过 MCP）|
| Bugfix 应用方式 | 沙盒内 iteration_branch 直接 commit；全绿后才开汇总 MR 给人审 |
| 项目接入抽象 | **shell 脚本契约**（5 个约定脚本 + 子命令协议），平台一边只有一个通用节点 + 一张登记表 |
| TestSpec → TestArtifacts | Pipeline A 独立步骤（可跳过；项目自带测试就跳过）|
| 生成的脚本存放位置 | 被测项目仓库的 `tests/e2e/` 子目录 |
| Schema 编号策略 | 本模块从 v1000 起步独立段位，跟主干 v46+ 永不撞号 |

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

```
build.sh           # 必需 — 编译产物
package.sh         # 必需 — 打包成可部署形态（image / tar / ...）
sandbox.sh         # 必需 — 沙盒生命周期 (provision / teardown / healthcheck)
deploy.sh          # 必需 — 在已 provision 的沙盒里部署产物
test.sh            # 必需 — 跑测试 + 收证据 + 可选生成
fix.sh             # 可选 — 应用补丁；不实现就由平台用 git CLI 兜底
```

平台一边只有 **一个通用节点类型** `invoke_target_script` + **一张登记表** `e2e_target_projects`。所有项目特异性下沉到 shell 脚本里。

### 脚本子命令契约

#### `sandbox.sh`

```bash
sandbox.sh --provision --branch=<branch> --out-handle=<file>
   # 准备一个干净环境
   # 写 handle JSON 到 --out-handle:
   # {
   #   "envId": "test-iter-42",
   #   "kind": "docker-compose-local" | "k8s-namespace" | "remote-multi-host" | ...,
   #   "endpoints": { "web": "...", "api": "...", "ssh": "..." },
   #   "modules": [{ "name": "auth-svc", "host": "...", "port": ... }, ...],
   #   "internalRefs": { ... }
   # }

sandbox.sh --teardown --handle=<file>          # 幂等
sandbox.sh --healthcheck --handle=<file>       # exit 0 = 全部模块 healthy
```

#### `test.sh`

```bash
test.sh --setup-env
   # 安装本地跑测试需要的依赖（仅 Stage 1 host 环境用）

test.sh --discover --format=json
   # stdout 最后一行 JSON: {"scenarios":[{"id":"...","name":"...","tags":[...]}]}

test.sh --run <scenario-id> --evidence-dir=<dir> [--timeout=<sec>]
   # exit 0=pass, 1=fail, 2=abort/error
   # 副作用: 把所有证据落到 <dir>/<scenario-id>/ 下
   # stdout 最后一行 JSON: {"result":"fail","summary":"...","duration_ms":...}

test.sh --static-check
   # 项目方实现的脚本静态校验（playwright→tsc / go→vet / py→compile）

test.sh --generate <spec-md-path> --out=<script-path>   # 可选
   # 项目内置生成器；不实现则平台兜底用通用 LLM generator
```

#### `build.sh / package.sh / deploy.sh`

```bash
build.sh --branch=<branch> [--target=<dist-path>]

package.sh --branch=<branch> --out=<image-tag-or-tar>
   # stdout 最后一行 JSON: {"artifact":"...","kind":"docker-image|tar|..."}

deploy.sh --env-handle=<file> --branch=<branch> [--module=<name> [--module=<name> ...]]
   # 在已 provision 的沙盒里部署
   # 不传 --module 部全部；传则只重部指定模块（多模块产品 + 增量 redeploy 优化）
   # stdout 最后一行 JSON: {"deployedAt":"...","modules":["..."]}

deploy.sh --env-handle=<file> --redeploy --branch=<branch> [--module=...]
```

#### Evidence Dir 协议（关键技术点）

证据走文件系统协议，命令行参数表达不下。`test.sh --run` 跑完后 `<evidence-dir>/<scenario-id>/` 下要符合：

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
  scripts         JSONB NOT NULL,              -- { build, package, sandbox, deploy, test, fix? }
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
  "pingPongLog": [],
  "limits": {"maxPerScenarioAttempts": 3, "maxRunHours": 4, "maxTotalAttempts": 30}
}
```

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
  evidence_manifest    JSONB,                   -- manifest.json 内联
  evidence_dir_uri     TEXT,                    -- 完整 evidence 目录的存储位置
  linked_bug_report_id BIGINT REFERENCES bug_analysis_reports(id) ON DELETE SET NULL,
  started_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ,
  UNIQUE (e2e_run_id, scenario_id, attempt_number)
);

CREATE INDEX idx_e2e_scenario_runs_run ON e2e_scenario_runs(e2e_run_id, scenario_id);
CREATE INDEX idx_e2e_scenario_runs_failed ON e2e_scenario_runs(e2e_run_id) WHERE result IN ('fail','error');
```

**不维护 `e2e_scenarios` 主表**。scenario source-of-truth 是被测项目仓库（`test.sh --discover` 现读），平台不重复维护。

#### `e2e_sandboxes` — 沙盒记录

```sql
CREATE TABLE e2e_sandboxes (
  id           BIGSERIAL PRIMARY KEY,
  e2e_run_id   BIGINT REFERENCES e2e_runs(id) ON DELETE SET NULL,   -- 删 run 时保留沙盒记录作为审计
  kind         TEXT NOT NULL,                  -- docker-compose-local | k8s-namespace | remote-multi-host | ...
  handle       JSONB NOT NULL,                 -- sandbox.sh --provision 的 handle 输出
  status       TEXT NOT NULL,                  -- provisioning | ready | redeploying | torn_down | failed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at     TIMESTAMPTZ,
  destroyed_at TIMESTAMPTZ
);

CREATE INDEX idx_e2e_sandboxes_run ON e2e_sandboxes(e2e_run_id) WHERE status NOT IN ('torn_down','failed');
```

第一期 sandbox 跟 run 1:1。

### 2.2 现有表扩展

#### `bug_analysis_reports`（已有）+ 新增 4 列

```sql
ALTER TABLE bug_analysis_reports
  ADD COLUMN triggering_e2e_run_id          BIGINT REFERENCES e2e_runs(id) ON DELETE SET NULL,
  ADD COLUMN triggering_e2e_scenario_run_id BIGINT REFERENCES e2e_scenario_runs(id) ON DELETE SET NULL,
  ADD COLUMN sandbox_branch                 TEXT,                           -- bugfix 应在该 branch 上 commit
  ADD COLUMN affected_modules               TEXT[];                         -- bugfix 输出，告诉 redeploy 哪些模块
```

E2E 测试触发的 bug 走同一个 `analyze_bug` capability，但携带这几个字段；bugfix capability 看到 `sandbox_branch` 不为空就在沙盒迭代 branch 上 commit，**不开 MR**；产出 `affected_modules` 给 redeploy 节点用。

#### `pipeline_node_types`（已有 12 种）+ 2 种

| 新节点 | 描述 |
|---|---|
| `invoke_target_script` | 通用 — 调被测项目的某个脚本，按 stdout JSON / exit code 协议解析。**所有项目特异性走这个节点** |
| `loop` | 通用 — 子图自递归，支持「直到条件成立」语义，带 max_iterations 安全网。E2E 重跑回路用，其他 pipeline 也能受益 |

#### `internal_capability_pipelines`（已有）+ 新映射

新增两个 capability：

- `e2e_run` → 映射到 Pipeline B（test-and-fix loop）
- `e2e_generate_script` → 映射到 Pipeline A（generator + baseline self-correct）

dogfood 时给 ChatOps 项目登记这两条映射；外部项目接入时再追加。

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

**Schema 编号策略**：本模块用 `v1000` 开头独立段位，跟主干 `v1..v45+` 永远不撞号。

- `src/db/schema-v1000.sql` — 包含本节所有内容：
  - `CREATE TABLE` 4 张新表
  - `ALTER TABLE bug_analysis_reports` 加 4 列
  - `INSERT INTO pipeline_node_types` 2 个新节点
  - `INSERT INTO internal_capability_pipelines` 2 条映射

**两份 SCHEMA_FILES 列表都要追加**：

```typescript
// src/db/migrate.ts
const SCHEMA_FILES = [
  // ...
  ['v45', 'schema-v45.sql'],
  ['v46', 'schema-v46.sql'],   // 主干已经走到这里
  ['v1000', 'schema-v1000.sql'],   // ← 自动化测试模块起点
] as const

// src/__tests__/helpers/db.ts
// 同步追加 v1000（新表非污染、catalog seed 干净）
```

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
[setup_baseline_sandbox]         — invoke_target_script: sandbox --provision --branch=<baseBranch>
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

A 完成的判定只看一件事：**生成的脚本 commit 进了仓库（PR 创建完毕）**。后续 PR 合并由人审驱动，spec 状态 `pr_open → committed` 由 GitLab MR webhook 触发。

- A 完成后 spec 状态 `pr_open`；PR 合并后才 `committed`，脚本 live 在 main 的 `tests/e2e/<id>.spec.ts`
- B 启动时 `test.sh --discover` 现读仓库**实际状态**（main 上是否有该脚本），不直接读 spec 状态
- spec 标 `blocked_on_baseline_bug` 时 B discover 不会有这个 scenario（脚本根本没 commit），UI 提示「该 spec 被 main 上的 bug 阻塞」

### 3.6 第一期范围

**做**：平台兜底 generator / static_check / baseline self-correct / commit + PR / 单 spec 触发

**不做**：多 spec 真正并行（max_concurrency=1）/ content_hash 自动触发 / 项目侧 `--generate` 实现入口

---

## 4. Pipeline B — Test-and-Fix Loop

### 4.1 输入与触发

```typescript
interface RunTestRequest {
  targetProjectId: string
  sourceBranch: string                       // 一般 'main'
  scenarioFilter?: { ids?: string[]; tags?: string[] }
  governorOverrides?: {
    maxPerScenarioAttempts?: number
    maxRunHours?: number
    maxTotalAttempts?: number
  }
}
```

**触发途径**：UI / IM / API / scheduled。第一期 UI + IM。

**前置**：图启动时立刻在 git 上创建 `iteration_branch = test-iter/<runId>`，从 `sourceBranch` 切出来。所有 bugfix commit 都在这个 branch 上。汇总 MR 是 `iteration_branch → sourceBranch`。

### 4.2 整体图

```
START
  ▼
[init_run]            — INSERT e2e_runs(status=pending)，创建 iteration_branch
  ▼
[setup_sandbox]       — sandbox.sh --provision --branch=sourceBranch
  ▼
[deploy_initial]      — build → package → deploy 三步串
  ▼
[discover]            — test.sh --discover → state.pendingScenarios
  ▼
┌────────────────────────────────── 主循环 ─────────────────────────────┐
│  [main_switch]                                                        │
│   ├─ pendingScenarios 空 → [create_summary_mr] → [notify_success] →   │
│   │                          (finally) → END (passed)                 │
│   ├─ governor 超限      → [finalize_failed] → (finally) → END (failed)│
│   └─ 还有 pending                                                     │
│        ▼                                                              │
│      [pick_next_scenario]                                             │
│        ▼                                                              │
│      [run_scenario]          — test.sh --run <id> --evidence-dir=...  │
│        ▼                                                              │
│      [switch: result?]                                                │
│        ├─ pass → [mark_green] → 回 main_switch                        │
│        └─ fail                                                        │
│            ▼                                                          │
│          [collect_evidence]   — 拷出 evidence dir → 上传 storage →    │
│                                  落 manifest 入表                     │
│            ▼                                                          │
│          [diagnose_and_create_issue]                                  │
│             ├─ llm_agent: 读 manifest 写 bug 标题/正文                │
│             └─ db_update: INSERT bug_analysis_reports(               │
│                 triggering_e2e_run_id, sandbox_branch=iteration_branch)│
│            ▼                                                          │
│          [dispatch_bugfix]    — coordinator.triggerCapability         │
│                                  ('analyze_bug', report_id)           │
│                                  run.status = awaiting_fix            │
│            ▼                                                          │
│          [wait_webhook]       — 挂起，等 bugfix callback              │
│            ▼ resumed                                                  │
│          [switch: bugfix.success?]                                    │
│            ├─ true                                                    │
│            │   ├─ [redeploy]   deploy --redeploy --branch=iter        │
│            │   │                       [--module=A --module=B]        │
│            │   ├─ [healthcheck] sandbox --healthcheck                 │
│            │   └─ 回 run_scenario（同 scenario，attempt++）           │
│            └─ false → [mark_unfixable] → 该 scenario 永久失败 →       │
│                       从 pending 移除 → 回 main_switch                │
└───────────────────────────────────────────────────────────────────────┘

任何错误路径汇 → (finally) [teardown_sandbox]
```

### 4.3 Bugfix 对接（关键协同）

**dispatch 时传给 bugfix**：

```typescript
coordinator.triggerCapability('analyze_bug', {
  reportId: <bug_analysis_reports.id>,
  context: {
    sandboxBranch: 'test-iter/<runId>',   // commit 到这个 branch（不是 main）
    autoMerge: true,                       // 沙盒迭代 branch 内自动合 commit，不开 MR
    sourceE2eRunId: <runId>,
    sourceScenarioId: 'login-success',
  },
  callback: {
    method: 'POST',
    url: 'http://chatops:3000/internal/e2e/bugfix-callback/<runId>/<stageIdx>',
    schema: {
      success: 'boolean',
      commitSha: 'string?',
      affectedModules: 'string[]?',
      reason: 'string?',
    }
  }
})
```

**Callback 路由**：

```typescript
// src/admin/routes/e2e-callback.ts
fastify.post('/internal/e2e/bugfix-callback/:runId/:stageIdx', async (req, res) => {
  // HMAC token 校验
  await graphRunner.resumeFromWebhook({
    threadId: String(req.params.runId),
    stageIdx: Number(req.params.stageIdx),
    payload: req.body,
  })
  res.send({ ok: true })
})
```

`resumeFromWebhook` 跟现有 `resumeFromImInput` 是同构的 —— 都是 LangGraph `Command` 注入挂起节点。

**Bugfix 永远在 sandbox_branch 上 commit + push，不开 MR**。汇总 MR 由 Pipeline B 在所有 scenario 全绿后统一开，PR body 列出迭代过程（attempt 历史 + 修了哪些 bug）。

### 4.4 Governor

```typescript
function governorCheck(state: E2eRunState): 'continue' | 'over_budget' {
  const g = state.governor

  // 1. 单 scenario 重试上限
  for (const [sid, attempts] of Object.entries(g.perScenarioAttempts)) {
    if (attempts >= g.limits.maxPerScenarioAttempts) {
      // 该 scenario 标 unfixable，从 pending 移除（不立即终结整个 run）
      // 若所有剩余 pending scenario 都 unfixable → over_budget
    }
  }

  // 2. run 总时长上限
  if (Date.now() - g.runStartedAt > g.limits.maxRunHours * 3600 * 1000) {
    return 'over_budget'
  }

  // 3. 总尝试数上限
  if (g.totalAttempts >= g.limits.maxTotalAttempts) {
    return 'over_budget'
  }

  // 4. Ping-pong 检测（第一期不做）
  return 'continue'
}
```

**默认值**：

| 限制 | 默认 |
|---|---|
| `maxPerScenarioAttempts` | 3 |
| `maxRunHours` | 4 |
| `maxTotalAttempts` | 30 |

### 4.5 多模块 redeploy 优化（contract 留好，第一期不主动用）

```typescript
const args = ['--redeploy', '--branch', iterationBranch]
const affected = state.lastBugfix.affectedModules
if (affected && affected.length > 0 && targetProject.capabilities.multiModule) {
  for (const m of affected) args.push('--module', m)
}
// 否则全量重部
```

第一期 ChatOps 单模块，全量重部够用。

### 4.6 第一期范围

**做**：完整图 / 同步闭环 / 单 scenario 串行 / 全量 redeploy / governor 三个预算 / 失败直接 teardown / 汇总 MR / IM 通知

**不做**：scenario 并行 / ping-pong 检测 / `affected_modules` redeploy（contract 留好）/ 进程重启图状态恢复 / 失败留沙盒

---

## 5. 前端 UI 与 IM 入口

### 5.1 页面拓扑

```
/admin
  ├─ /e2e-targets        被测项目登记 (e2e_target_projects 的 CRUD)
  ├─ /e2e-specs          测试规约管理 (Pipeline A 的入口 + 状态)
  ├─ /e2e-runs           E2E 运行列表
  └─ /e2e-runs/:runId    E2E 运行详情（核心页）
```

侧边栏新增「自动化测试」菜单。**注意**：现有 `/test-runs` 是流水线测试运行（test_runs 表）的不同概念，本模块全部用 `e2e-` 前缀避免歧义。

### 5.2 `/e2e-targets`

简单 CRUD 表格。`scripts` 字段 JSON 编辑器，每个脚本路径调 GitLab API 现查是否存在，UI 上 ✓/✗ 标记。`defaultSandboxKind` 第一期只有一个选项 `docker-compose-local`。

### 5.3 `/e2e-specs`（Pipeline A 入口）

列表 + 操作：
- 状态 Badge: `pending / generating / pr_open / committed / baseline_failed / blocked_on_baseline_bug / skipped`
- 「生成」/「重生成」触发 Pipeline A
- 「查看 baseline 失败 evidence」（仅 baseline_failed）
- 「查看脚本」跳到 GitLab 文件
- 「跳过 Stage 1」开关

markdown spec 内容主数据是 git 仓库，UI 通过 GitLab API 现读。

### 5.4 `/e2e-runs`

列表 + 「新建 Run」按钮。Modal 表单：项目 Select、源分支、场景过滤（全部 / tag / IDs）、governor 覆盖（折叠面板）。

### 5.5 `/e2e-runs/:runId`（核心页）

```
┌────────────────────────────────────────────────────────────────────┐
│  Run #42 · ChatOps · main                          [中止] [刷新]   │
│  状态: awaiting_fix                                                 │
│  Governor: 尝试 8/30 · 用时 1h12m / 4h · 单场景重试 ≤ 3            │
│  迭代分支: test-iter/42  →  GitLab                                  │
└────────────────────────────────────────────────────────────────────┘

┌── 沙盒 ────────────────────────────────────────────────────────────┐
│  kind: docker-compose-local · status: ready                         │
│  endpoints: web → http://localhost:13042 · pg → localhost:5442      │
│  modules: chatops（单模块）                                         │
└────────────────────────────────────────────────────────────────────┘

┌── 场景时间线 ──────────────────────────────────────────────────────┐
│  ✅ login-success            1 attempt   · 12s                      │
│                                                                     │
│  ✅ create-prd               2 attempts  · 失败→修复→通过           │
│     └─ attempt #1 ❌ → bug #1234 (修了 src/agent/prd-submit/*)     │
│     └─ attempt #2 ✅                                                │
│                                                                     │
│  🔄 approval-flow            3 attempts  · 修复中                   │
│     └─ attempt #1 ❌ → bug #1235                                    │
│     └─ attempt #2 ❌ → bug #1236                                    │
│     └─ attempt #3 (awaiting_fix) → bug #1237 [跳到 bugfix]          │
│                                                                     │
│  ⏳ list-pipelines           待跑                                    │
└────────────────────────────────────────────────────────────────────┘
```

点开 attempt → 右侧 Drawer：summary / contextHint / artifacts 按 mimeType 分组渲染（image 缩略图、text/json viewer、其他下载链接）/ 关联 bug 跳转。

**SSE 实时刷新**：复用现有 stage log SSE 模式（commit `73f9759`），URL `/admin/e2e-runs/<runId>/stream`，事件: `scenario_started / scenario_finished / status_changed / governor_update / sandbox_status`。

### 5.6 IM 入口

新增 capability `e2e_run`，绑 default_pipeline_id 到 Pipeline B。

走现有 IM-Driven Pipeline Flow 多轮 im_input 收参：

```
用户:  @bot 跑 chatops 的 e2e 测试
Bot:   要跑 chatops 项目的所有场景吗？
       1. 全部 (15 个场景)
       2. 仅 smoke 标签 (5 个场景)
       3. 取消
用户:  1
Bot:   ✅ 已启动 Run #42 · 跑 15 个场景
       ▶ http://chatops-admin/e2e-runs/42

[关键节点推送]
Bot:   📊 Run #42 · 5/15 通过 · approval-flow 失败 · 启动 bugfix
       ▶ bug #1235

Bot:   🔧 Run #42 · approval-flow bug 已修复，重新部署沙盒并重试中

[run 完成]
Bot:   ✅ Run #42 PASSED
       共 15 个场景，3 个一次过、5 个修复后通过、7 个原本就过
       共修复 8 个 bug · 沙盒已销毁
       汇总 MR ▶ https://gitlab.../merge_requests/789
```

**别的 IM 命令**：`@bot 查 e2e run 42` / `@bot 中止 e2e run 42` / `@bot 生成测试 docs/test-specs/login.md`

### 5.7 通知策略（不打扰原则）

| 事件 | 推？ |
|---|---|
| Run 启动 | ✅ |
| 第一个 scenario 失败、启动 bugfix | ✅ |
| `awaiting_fix` 期间的 bugfix 内部进度 | ❌ |
| Bugfix 完成、redeploy 中 | ✅（一句话）|
| Scenario 通过（中间过程）| ❌ |
| Run 完成 | ✅ 必推 |
| Governor 触发的 unfixable | ✅ |

### 5.8 第一期范围

**做**：四个页面完整 + IM `e2e_run` capability + 关键节点推送

**不做**：「Lint 接入」远程跑 / 「重试某个 scenario」按钮 / 跨项目聚合 / in-page markdown 编辑器

---

## 6. 部署、测试、风险与第一期里程碑

### 6.1 部署 & 运行时考量

#### 沙盒怎么起 — 单机 docker-in-docker

第一期沙盒 `docker-compose-local`，宿主就是 ChatOps 自己的容器。需要在 ChatOps 容器里调 docker（起新 postgres + chatops 沙盒容器）。现有部署已经做了 docker socket 挂载（commit `cc2a62f`），**沙盒能力本身在现有部署上零额外配置**。

**端口分配**：每个沙盒 run 用 `13000 + runId % 1000`（postgres 5400+ / chatops 13000+）。第一期 `max_concurrency=1` 不会撞端口。

**网络隔离**：沙盒里的 chatops 不连真生产，IM token / GitLab token 通过环境变量切到 mock / 测试租户。**沙盒里的 chatops 不能往真 IM 群发消息、不能往真 GitLab push 代码**。复用现有 `_e2e.ts` mock 端点。

#### Evidence 存储

第一期本地 fs：`/var/chatops/e2e-evidence/<runId>/<scenarioId>/<attempt>/`。Fastify static 路由 `/admin/e2e-runs/:runId/evidence/...` 暴露给 UI（仅限已登录 admin）。每个 run 完成 + 30 天后 cron 自动清理。第二期切 S3/MinIO 时换 URI scheme，节点和 UI 不动。

#### 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `E2E_SANDBOX_DOCKER_HOST` | `unix:///var/run/docker.sock` | 起沙盒的 docker daemon |
| `E2E_EVIDENCE_ROOT` | `/var/chatops/e2e-evidence` | evidence 落地根目录 |
| `E2E_EVIDENCE_RETENTION_DAYS` | `30` | 自动清理阈值 |
| `E2E_DEFAULT_MAX_RUN_HOURS` | `4` | governor 默认 |
| `E2E_DEFAULT_MAX_PER_SCENARIO_ATTEMPTS` | `3` | governor 默认 |
| `E2E_DEFAULT_MAX_TOTAL_ATTEMPTS` | `30` | governor 默认 |
| `E2E_BUGFIX_CALLBACK_BASE_URL` | `http://chatops:3000` | webhook 回调 base URL |
| `E2E_RUN_CONCURRENCY` | `1` | 第一期固定 1 |

走 `src/config.ts` 的 Zod 校验。

### 6.2 自动化测试自身的测试

| 层 | 怎么测 | 用什么 |
|---|---|---|
| `invoke_target_script` 节点 | 单测：mock 子进程 stdout/exit code | vitest，无 DB |
| Governor 逻辑 | 单测：构造各种 governor_state | vitest，无 DB |
| `loop` 节点 | 单测：mock 子图 | vitest |
| Pipeline B 图 | 集成测：mock 所有 invoke_target_script，跑完整图 | vitest + testcontainer pg |
| Pipeline A 图 | 同上 | |
| Bugfix callback 路由 | 集成测：HTTP POST 触发 resume | vitest + Fastify inject |
| 端到端 dogfood | 1 spec → A 生成 → 故意改坏一个文件 → B 跑通自动修复 | 手工，里程碑验收 |

**关键约定**：所有 invoke_target_script 测试**走 mock 子进程接口**（注入假 spawn），不真起 docker / 跑 playwright。真实"跑沙盒 + Playwright"只在端到端 dogfood 跑一次。

### 6.3 风险清单 & 缓解

| 风险 | 严重 | 缓解 |
|---|---|---|
| **Bugfix capability 现有逻辑写死 commit 到 main**，新加 `sandbox_branch` 字段时改不动 | 🔴 高 | 周 1 优先验证 `src/agent/bug-fix/*` / `src/pipeline` 里 fix 写文件的部分能否注入 branch 参数。整个回路的关键集成点 |
| **沙盒里的 chatops 误打真生产** | 🔴 高 | sandbox 启动强制覆盖 IM/GitLab token 为测试租户；测试租户没有则用 mock 模式（`_e2e.ts` 已有 mock 入口）|
| **Playwright 跑 chatops 自身需要测试账号 + IM 模拟** | 🟡 中 | 复用 `_e2e.ts` 的 IM 消息注入、Claude mock 端点，让 Playwright POST 这些端点而不是真 IM |
| AI 生成的脚本反复过不了 baseline | 🟡 中 | governor `baseline_attempts ≤ 3`；UI 留 evidence 给人调脚本 |
| 沙盒资源耗尽 | 🟡 中 | `E2E_RUN_CONCURRENCY=1`；teardown 严格幂等；监控 disk/memory |
| 长时间 awaiting_fix（>1h）时进程重启 | 🟢 低 | LangGraph thread_id 持久化已支持；沙盒可能被 docker 重启清掉，第一期遇到直接标 run 失败 |
| Evidence 文件爆磁盘 | 🟢 低 | 30 天 retention cron；单 run >100MB 警告 |
| Wait_webhook callback URL 被外部恶意调用 | 🟢 低 | URL 加 HMAC 签名 token 校验；只接受内部网络请求 |

**最高优先级是第一条 —— bugfix 接 sandbox_branch 的能力**。必须先验证。

### 6.4 第一期里程碑（5 周）

| 周 | 重点 | 验收 |
|---|---|---|
| **周 1** | 集成点验证 + DB schema + 通用节点 | • bugfix 接 `sandbox_branch` 跑通（手工触发）<br>• schema-v1000.sql 上线<br>• `invoke_target_script` + 单测<br>• `loop` + 单测 |
| **周 2** | ChatOps 自身 sandbox 脚本改造 | • `chatops/{sandbox,build,package,deploy,test}.sh` 子命令完整<br>• 本地手工 `./sandbox.sh --provision && ./deploy.sh && ./test.sh --discover` 跑通 |
| **周 3** | Pipeline B 图 + bugfix 对接 + e2e_run capability | • Pipeline B 集成测过<br>• `e2e_run` capability + IM 多轮收参<br>• callback 路由 + HMAC token<br>• 命令行能触发完整 run（不带 UI） |
| **周 4** | UI（runs 列表 + 详情页 SSE）+ e2e_targets 页 | • 列表 + 详情时间线 + drawer 渲染各 mimeType<br>• SSE 实时更新<br>• `/e2e-targets` CRUD |
| **周 5** | Pipeline A + 规约页 + IM 完整路径 + dogfood 验收 | • Pipeline A 单 spec 跑通<br>• `/e2e-specs` 管理页<br>• IM 完整路径<br>• **dogfood 验收**：手写 2 spec → A 生成 → B 跑通；故意改坏一个产品文件 → 自动诊断 → 修复 → 重跑通过 |

**dogfood 验收即第一期 done 的标志**。

### 6.5 后续阶段路线图（仅记录）

- **第二期**：ssh-proxy 接入（验证多项目 contract）+ scenario 并行 + 失败留沙盒
- **第三期**：多模块多机环境编排独立需求（k8s / VM pool / remote-multi-host）
- **第四期**：PRD → Spec 自动派生
- **第五期**：跨项目 dashboard

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
| sandbox handle | `sandbox.sh --provision` 输出的 JSON，记录环境元信息 |
| Evidence | 失败现场的证据集合（manifest.json + artifacts/）|
| Governor | run-level 的回路保护机制（重试上限 / 总时长 / 总尝试数）|
| affected_modules | bugfix 修了哪些模块，给增量 redeploy 用（多模块产品）|

## 附录 B — 与现有架构的集成清单

| 现有机制 | 怎么复用 |
|---|---|
| LangGraph Pipeline 引擎（`src/pipeline/`）| Pipeline A / B 都是 LangGraph，复用现有 graph-builder / graph-runner / interrupt-resume / wait_webhook |
| `_e2e.ts` mock 端点 | Playwright 跑 ChatOps 自身时通过这些端点注入 IM 消息 / 模拟 Claude 响应 |
| Bugfix capability `analyze_bug` | 不修改 capability 接口；通过 `bug_analysis_reports` 新加的 `sandbox_branch` 字段 + `affected_modules` 输出协同。**周 1 重点验证**这个 capability 的现有实现能否接受 sandbox_branch 参数 |
| `internal_capability_pipelines` 映射 | 新增 `e2e_run` / `e2e_generate_script` 两条映射 |
| IM-Driven Pipeline Flow | `e2e_run` capability 走现有 IM input 多轮 interrupt 路径 |
| `pipeline_node_types` 表 | 新增 `invoke_target_script` 和 `loop` 两个 node 类型 |
| stage log SSE（commit `73f9759`）| 详情页 SSE 复用同一通道模式 |
| `resolveGitlabConfig()`（`src/config/gitlab.ts`）| commit / push / 创 MR 的代码统一走它读 GitLab token |
| 现有 `chatops/build.sh / build-base.sh / deploy.sh / test.sh` | dogfood 时的脚本契约改造在它们之上扩子命令，不另起新文件 |
