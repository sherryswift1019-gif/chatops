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
| 场景库源头 | 人手维护的 markdown 规约 + **Playwright codegen 录制入口**（D6）|
| 浏览器驱动 | Playwright + Playwright MCP（AI 探索时通过 MCP）|
| Bugfix 应用方式 | 沙盒内 iteration_branch 直接 commit；全绿后才开汇总 MR 给人审 |
| 项目接入抽象 | **shell 脚本契约**（5 个约定脚本 + 子命令协议），平台一边只有一个通用节点 + 一张登记表 |
| TestSpec → TestArtifacts | Pipeline A 独立步骤（可跳过；项目自带测试就跳过）|
| 生成的脚本存放位置 | 被测项目仓库的 `tests/e2e/` 子目录 |
| **Pipeline A PR 处理** | **平台自动 merge**（D5），不走人审 |
| **Pipeline B 主入口** | **GitLab MR webhook 自动触发**（D3），结果 comment + status check 回 MR；IM/UI 辅助 |
| **IM 触发协议** | **单句语法**（D4）`@bot 跑 chatops e2e [--tag=smoke]`，不再多轮 im_input 收参 |
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

```
build.sh           # 必需 — 编译产物
package.sh         # 必需 — 打包成可部署形态（image / tar / ...）
sandbox.sh         # 必需 — 沙盒生命周期 (provision / teardown / healthcheck)
deploy.sh          # 必需 — 在已 provision 的沙盒里部署产物
test.sh            # 必需 — 跑测试 + 收证据 + 可选生成
fix.sh             # 可选 — 应用补丁；不实现就由平台用 git CLI 兜底
```

平台一边只有 **一个通用节点类型** `invoke_target_script` + **一张登记表** `e2e_target_projects`。所有项目特异性下沉到 shell 脚本里。

**为什么是 shell 脚本而不是 Node module 契约**：另一种设计是让被测项目实现 `tests/e2e/contract.ts` export 一组函数，平台调一个 `invoke_target_module` 节点。Node module 契约的优点是**类型安全 + IDE 友好 + 容易单测**；缺点是**锁死 Node 生态**——ssh-proxy（Go）、其他 Python / Rust / 嵌入式项目接入时必须包一层 Node wrapper，反而把"通用"打折扣。脚本契约虽然弱类型、stdout JSON 协议要靠 lint 工具保证，但**任何语言任何项目都能直接接入**。第一期 dogfood ChatOps 自己（Node）虽然类型安全损失明显，但为了第二期 ssh-proxy 接入的零负担，**架构层面坚持 shell 契约**。

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
  evidence_manifest    JSONB,                   -- manifest.json 内联（限 32KB，超大走 evidence_dir_uri）
  evidence_dir_uri     TEXT,                    -- 完整 evidence 目录的存储位置
  linked_bug_report_id BIGINT REFERENCES bug_analysis_reports(id) ON DELETE SET NULL,
  started_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ,
  UNIQUE (e2e_run_id, scenario_id, attempt_number),
  CHECK (evidence_manifest IS NULL OR length(evidence_manifest::text) < 32768)
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
  ADD COLUMN sandbox_branch                 TEXT;                           -- bugfix 应在该 branch 上 commit
```

**注意 V1 不加 `affected_modules`**：第一期 ChatOps 单模块全量 redeploy，加了这列会让 fix prompt 强制输出额外字段，徒增 fail 率；推迟到 V2 ssh-proxy / 多模块产品接入时再加（届时配合 multiModule 增量 redeploy 一起上线）。

E2E 测试触发的 bug 走同一个 `analyze_bug` capability，但携带这几个字段；bugfix capability 看到 `sandbox_branch` 不为空就在沙盒迭代 branch 上 commit，**不开 MR**。

**注意：bugfix capability 改造范围远超"加列"**。详见 §4.3 "Bugfix 对接" + §6.4 周 1 任务。

#### `pipeline_node_types`（已有 12 种）+ 1 种

| 新节点 | 描述 |
|---|---|
| `invoke_target_script` | 通用 — 调被测项目的某个脚本，按 stdout JSON / exit code 协议解析。**所有项目特异性走这个节点**。**仅作为 pipeline node 注册，不暴露为 MCP 工具** |

**不新增 `loop` 节点**：Pipeline B 主循环用 LangGraph **原生 `conditional_edge` 自循环**（main_switch 节点的条件边连回自己），这是 LangGraph 子图 + checkpointer 上下文里唯一被验证可行的循环范式（fan_out 已明确禁套 interrupt 子节点，见 `src/pipeline/node-types/fan-out.ts` 注释）。"loop 节点"不登记进 `pipeline_node_types`，避免画布渲染暴露给用户编辑。

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

**Schema 编号策略**：本模块用 `v1000` 开头独立段位，跟主干 `v1..v59+` 永远不撞号。

- `src/db/schema-v1000.sql` — 包含本节所有内容：
  - `CREATE TABLE` 4 张新表
  - `ALTER TABLE bug_analysis_reports` 加 3 列（`triggering_e2e_run_id` / `triggering_e2e_scenario_run_id` / `sandbox_branch`；`affected_modules` 推迟到 V2 ssh-proxy 接入再加）
  - `INSERT INTO pipeline_node_types` 1 个新节点（`invoke_target_script`；不新增 `loop`，因为 Pipeline B 用 LangGraph 原生 `conditional_edge` 自循环）
  - `INSERT INTO internal_capability_pipelines` 2 条映射
  - **末尾追加** `pipeline_node_types.enabled` 行数 ≥ 13 的硬断言（跟 schema-v35 同形式），保证未来若有人新增节点不会破坏不变量

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

### 3.7 TestSpec 模板与 lint（P10）

写一份能被 LLM 稳定生成可执行测试的 markdown 是有门槛的（前置条件、断言粒度、验收点）。第一期沉淀：

**金标 spec 模板**（2-3 份，dogfood 之前写好放进 `docs/test-specs/_templates/`）：
- `web-feature-template.md` — 适合 ChatOps 自身这类带 web UI 的功能（含 Playwright codegen 入口）
- `api-flow-template.md` — 适合纯 API 流程
- `cli-command-template.md` — 适合 ssh-proxy 这类 CLI 项目（V2 接入时用）

UI `/e2e-specs` 新建页提供「从模板创建」选项，把模板内容预填进 markdown 编辑器（编辑器是简化版，第一期实际还是在 GitLab 上 commit）。

**spec lint 节点**（在 Pipeline A `[generate_or_skip]` 之前）：
跑一段 LLM prompt 检查 spec markdown 是否含必备元素（验收点、前置条件、scenario_id），缺了就拒绝进入 generation，建议回写 spec markdown 提示用户补全。

**spec_failed 时给改写建议**：Pipeline A `baseline_failed` 时，诊断 LLM 顺便输出"是不是 spec 写得不够清楚"建议，写到 spec 关联的 GitLab issue 评论里，让人改 spec 而不是改脚本（`git reset` 后重新触发）。

### 3.8 Playwright codegen 入口（D6 — 第二种 spec 来源）

人写 markdown 不是唯一入口。**第一期同时支持 Playwright codegen 录制 → AI 转 spec** 路径：

```
[/e2e-specs] 页面新增「录制场景」按钮
       ▼
弹出说明：在沙盒环境里用浏览器演示一遍正确流程（Playwright codegen 模式）
       ▼
浏览器打开 sandbox 里的 chatops，用户演示流程；操作录入 .spec.ts
       ▼
[ai_synthesize_spec] llm_agent: 拿录像产物 + 用户填的标题 → 反推出 markdown spec
       ▼
落到 docs/test-specs/<id>.md + 进入正常 Pipeline A 流程（baseline self-correct + auto merge）
```

**适用范围**：
- ChatOps 自身（有 web UI）—— 第一期主要走这条路径，因为录像比写规约门槛低 10 倍
- 外部 web 项目接入也走这条
- 纯 CLI 项目（ssh-proxy）走人写 spec 路径

**实施位置**：第一期周 5 dogfood 之前完成。`/e2e-specs` 页面 codegen 入口跟"从模板创建"并列。

### 3.9 第一期范围

**做**：平台兜底 generator / static_check / baseline self-correct / commit + PR + **自动 merge**（取代人审）/ 单 spec 触发 / 模板 + lint / **Playwright codegen 录制入口**

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

**触发途径（按主辅顺序）**：

1. **🥇 主入口 — GitLab MR webhook 自动触发**：MR 创建 / 更新（push commit）时自动触发一次 e2e_run，结果以 comment + status check 形式回 MR。这是 dev 工作流的自然集成点，绿勾红叉直接成为 PR review 的一等公民信号。第一期默认开启。
2. **🥈 IM 命令** — `@bot 跑 chatops e2e [--tag=smoke]` 单句语法（D4 决策：不再多轮 im_input 收参，默认全跑，`--tag` / `--id` 参数可选）。用于"不在 MR context 里的特殊跑"
3. **🥉 后台 UI** — `/e2e-runs` 列表的「新建 Run」按钮。用于复杂参数（governor 覆盖）/ 调试场景
4. **API / scheduled** — 第一期不主推；预留接口

#### MR webhook 触发协议

GitLab MR webhook 发送 `merge_request` 事件（action: opened / update）时，平台路由：

```
GitLab MR webhook → /admin/_webhook/gitlab/mr → 路由到 e2e 处理器
                                                       ▼
  匹配 e2e_target_projects.gitlab_repo？
       ▼
  match → 取 MR.source_branch 当 sourceBranch、跑全部 scenario（默认）
       ▼
  调 createE2eRun({ targetProjectId, sourceBranch, trigger='gitlab_mr', triggerActor=mr_author })
       ▼
  启动 Pipeline B（受 maxQueuedRuns 限制，超了就 IM 提示等待，不跑当前 MR 的）
       ▼
  完成时调 GitLab API: 在 MR 上发 comment + 设 commit status check
                       comment 内容: "✅ E2E 通过 12/12 scenario · 修了 3 个 bug · 详情 [Run #42](...)"
                       status check: success / failed / pending
```

dev 在 MR 页面就能看到绿勾红叉 + 摘要 comment，不用进 ChatOps UI 也不用看 IM 群。

**iteration_branch 跟 MR 的关系**：MR 自己的 source branch 就当 sourceBranch 用；iteration_branch 仍然是 `test-iter/<runId>` 从 MR.source_branch 切出来。汇总 MR（如果有 bug 被修）也开到 MR.source_branch（不直接到 main），合进去后 dev 在原 MR 上能看到测试修复 commit 自然流入。

**前置**：图启动时立刻在 git 上创建 `iteration_branch = test-iter/<runId>`，从 `sourceBranch` 切出来。所有 bugfix commit 都在这个 branch 上。汇总 MR 是 `iteration_branch → sourceBranch`。**git 凭据走 `resolveGitlabConfig()`**（CLAUDE.md 约束）。

**iteration_branch 累积 commit 策略 — 每次 attempt 先 reset**：

每次 attempt 在调 bugfix 之前**先 `git reset --hard origin/<sourceBranch>`** 然后才让 bugfix 跑。这是为了避免「attempt #2 修不好 #1 引入的坏修，但 #1 的 commit 还在 branch 上，redeploy 部署的是叠加结果，最终汇总 MR 带坏 commit」这个工程坑。

代价：跨 scenario 的修复不能累积（scenario A 的 fix 也修了 B，但下次 reset 就丢了）。第一期 ChatOps 单仓库且 scenario 数量有限，这个代价可接受。**V2 改进路径**：squash + revert 或 cherry-pick 跨 attempt 累积，第二期评估。

**iteration_branch 垃圾回收**：

run 完成（passed / failed / aborted）时 teardown 阶段 **delete remote branch**（`git push origin :test-iter/<runId>`）。GitLab 侧再配 stale branch retention 策略兜底（30 天没活动的 `test-iter/*` 自动清）。

### 4.2 整体图

主循环用 **LangGraph 原生 `conditional_edge` 自循环**（不引入 `loop` 节点）：`main_switch` 节点的条件边一头连 END / 继续路径，另一头连回 `pick_next_scenario` 形成循环。这是 LangGraph 子图 + checkpointer 上下文里唯一被验证可行的循环范式。

**bugfix 分发改为同进程同步 `await`**（不引入 `wait_webhook` + HTTP callback）：第一期 max_concurrency=1 + 单进程，`coordinator.triggerCapability('analyze_bug', ...)` 直接 await 拿返回值就够。当未来 fix 跑独立 worker 时再切回 webhook 解耦——那是 V3 后续期的事。

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
┌────────────────────────────────── 主循环（conditional_edge 自循环）─────┐
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
│          [collect_evidence]   — 拷出 evidence dir → mask sensitive    │
│                                  → 上传 storage → 落 manifest 入表    │
│            ▼                                                          │
│          [diagnose_and_create_issue]                                  │
│             ├─ llm_agent: 读 manifest 写 bug 标题/正文                │
│             └─ db_update: INSERT bug_analysis_reports(               │
│                 triggering_e2e_run_id, sandbox_branch=iteration_branch,│
│                 labels=['e2e-auto'])  ← GitLab issue 加专属 label     │
│            ▼                                                          │
│          [reset_iteration_branch]                                     │
│             — git fetch + git reset --hard origin/<sourceBranch>      │
│             — 在 iteration_branch 上保持 sourceBranch HEAD 状态       │
│            ▼                                                          │
│          [dispatch_bugfix_sync]                                       │
│             — await coordinator.triggerCapability('analyze_bug', {    │
│                 reportId, iterationBranch, skipMr: true })            │
│             — 同进程同步等待返回（status 仅在 UI 上显示为              │
│               awaiting_fix，但 LangGraph 没有 interrupt）             │
│             — 返回值: { success, commitSha?, reason? }                │
│            ▼                                                          │
│          [switch: bugfix.success?]                                    │
│            ├─ true                                                    │
│            │   ├─ [redeploy]   deploy --redeploy --branch=iter        │
│            │   ├─ [healthcheck] sandbox --healthcheck                 │
│            │   └─ 回 run_scenario（同 scenario，attempt++）           │
│            └─ false → [mark_unfixable] → 该 scenario 永久失败 →       │
│                       从 pending 移除 → 回 main_switch                │
└───────────────────────────────────────────────────────────────────────┘

任何错误路径汇 → (finally) [teardown_sandbox + delete remote iteration_branch]
```

### 4.2.1 关于 `awaiting_fix` 状态

虽然 LangGraph 内部是同步 `await`（没有真正的 interrupt），但 UI 层和数据库层仍然用 `awaiting_fix` 这个状态：

- `dispatch_bugfix_sync` 节点入口 → `UPDATE e2e_runs SET status='awaiting_fix'`
- bugfix 同步返回后 → `UPDATE e2e_runs SET status='running'`，回到 redeploy / mark_unfixable

UI / IM 通知拿这个状态做语义判断（"修复中"），跟图引擎是否 interrupt 解耦。**第一期不暴露 wait_webhook + callback URL 协议**——这意味着 §4.3 callback 路由 / HMAC token 的设计也都不用做。

### 4.3 Bugfix 对接（关键集成点 + 改造范围）

#### 4.3.1 现有 bugfix capability 改造范围（不是"加列"）

第一期最大的工程风险是「现有 `src/agent/fix/` 跟 spec 假设的协议有相当差距」。**verify 后的现状**：

- `branch-manager.ts:createFixBranch(cwd, issueId, attempt)` 把分支名**写死**成 `fix/issue-<id>` 或 `fix/issue-<id>-attempt-<n>`，没有外部传入 branch 的入口
- `fix-logic.ts:rebaseOnTarget(worktree.path, input.sourceBranch)` 写死把 fix 分支 rebase 到 sourceBranch（=main）
- `fix-logic.ts` 每次 attempt 都 `createFixBranch -b` 新建 branch — 跟 spec "在同一个 iteration_branch 上累积" 直接冲突
- 现有路径最后一步是 `pushBranch` + 创 MR；spec 要求 "skipMr=true 时不创 MR"，需新增分支

#### 4.3.2 周 1 必须落地的 bugfix 改造（具体到代码）

| 改动 | 文件 | 改法 |
|---|---|---|
| `RunFixForProjectInput` 加参数 | `src/agent/fix/fix-runner.ts` | 加 `iterationBranch?: string` + `skipMr?: boolean` 字段（透传到 fix-logic）|
| `createFixBranch` 支持已存在 branch | `src/agent/fix/branch-manager.ts` | 当 `iterationBranch` 已传入时，`git checkout <branch>` 而不是 `-b`；不存在时 fallback 走原 `fix/issue-<id>` 命名 |
| `rebaseOnTarget` 跳过 | `src/agent/fix/fix-logic.ts:170` | 当 `iterationBranch` 模式下跳过 rebase（沙盒里不需要 rebase 到 main，每个 attempt 入图前已经 reset 过）|
| `pushBranch + createMr` 路径分支 | `src/agent/fix/fix-logic.ts` | `skipMr=true` 时只 push 不创 MR |
| coordinator 路由透传 | `src/agent/coordinator.ts:triggerCapability` | `extraParams.iterationBranch` / `extraParams.skipMr` 透到 fix-runner |

**没做这些改造前，spec 的 §4.2 主循环根本跑不通**。所以这是周 1 不可省略项，acceptance criteria 见 §6.4。

#### 4.3.3 dispatch 协议（同步 await）

```typescript
// pipeline 的 dispatch_bugfix_sync 节点内部
const fixResult = await coordinator.triggerCapability('analyze_bug', {
  reportId: <bug_analysis_reports.id>,
  extraParams: {
    iterationBranch: 'test-iter/<runId>',   // ← 周 1 改造后能识别
    skipMr: true,                            // ← 不开 MR，只 push
    sourceE2eRunId: <runId>,
    sourceScenarioId: 'login-success',
  },
})
// fixResult 形如: { success: boolean, commitSha?: string, reason?: string }
```

**同步语义**：`triggerCapability` 在第一期 `max_concurrency=1` 下直接 `await` 拿返回值。整个分发期间 `e2e_runs.status='awaiting_fix'`（UI / IM 显示需要），但 LangGraph 没有真 interrupt，进程不重启则一直挂在这个节点的 await。

**进程重启时怎么办**：见 §4.5 startup recovery。

**未来切回 webhook 解耦**：当 fix 跑独立 worker / max_concurrency>1 时，把 `dispatch_bugfix_sync` 换成「`dispatch_bugfix_async + wait_webhook`」二节点形态，加 callback URL + HMAC 协议。这是 V3+ 的事，第一期不做。

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
| **`maxQueuedRuns`** | **2**（除当前 running 外排队等待中 run 数上限）|

**队列拒绝**：第一期 `E2E_RUN_CONCURRENCY=1`，期间所有别的 IM/UI 触发的 e2e_run 都得等。如果排队中的 run 数已达 `maxQueuedRuns`，**新触发的 run 直接拒绝 + 反馈错误**（IM 提示「当前已有 N 个 run 在等待，请稍后再试或 abort 现有 run」），避免队列堆死、IM 触发体感差。

### 4.5 多模块 redeploy（V2 引入，第一期不实现）

第一期 ChatOps 单模块，全量 redeploy 够用，**`affected_modules` 字段不在 V1 schema 里**（详见 §2.2）。V2 ssh-proxy / 多模块产品接入时一起加：

- `ALTER TABLE bug_analysis_reports ADD COLUMN affected_modules TEXT[]`
- `redeploy` 节点读 affected_modules → 加 `--module=A --module=B` 增量重部
- bugfix capability 输出 affected_modules（fix prompt 加输出字段）

第一期 redeploy 节点直接调 `deploy.sh --redeploy --branch=iteration_branch`，全量重启沙盒。

### 4.6 第一期范围

**做**：
- 完整图 + LangGraph 原生 conditional_edge 自循环
- bugfix 同步 await（不引入 wait_webhook）
- 单 scenario 串行
- 全量 redeploy
- governor 4 个预算（含 `maxQueuedRuns`）
- run 完成或异常都 teardown sandbox + delete remote iteration_branch
- 汇总 MR + 自动 close 临时 e2e-auto issue
- IM 通知关键节点
- **进程启动时 startup recovery**（见下）

**不做**：
- scenario 并行
- ping-pong 检测
- `affected_modules` redeploy（V2 引入）
- `wait_webhook + HTTP callback` 协议（V3+ fix 跑独立 worker 时再加）
- 失败留沙盒（V2）

### 4.7 进程重启 startup recovery（必须做）

ChatOps 服务重启时所有跑到一半的 e2e_runs 都会卡 — 因为 dispatch_bugfix_sync 是同进程 await，进程死了就丢了。**必须**在 server 启动时跑一段 recovery 脚本：

```typescript
// src/server.ts startup hook（伪代码）
async function recoverInflightE2eRuns() {
  const stuck = await db.query(`
    SELECT id, sandbox_id FROM e2e_runs
    WHERE status IN ('running', 'awaiting_fix')
  `)
  for (const run of stuck.rows) {
    // 标记 aborted + 触发 teardown
    await db.query(`UPDATE e2e_runs SET status='aborted', abort_reason='process_restart',
                    finished_at=NOW() WHERE id=$1`, [run.id])
    // teardown 沙盒 + delete remote branch（best-effort，失败也继续）
    await teardownSandboxBestEffort(run.sandbox_id).catch(...)
    await deleteRemoteBranchBestEffort(`test-iter/${run.id}`).catch(...)
    // 标这个 run 关联的所有 e2e-auto issue 为 closed-due-to-abort（IM 通知人手）
    await closeE2eAutoIssuesForRun(run.id).catch(...)
  }
}
```

**这是不可省略项**（不能放第一期"不做"列表）。否则上线第一次部署 / 重启就会有沙盒泄漏 + 卡死的 awaiting_fix run。周 1 跟 bugfix 改造一起完成。

### 4.8 e2e-auto issue 生命周期

E2E 触发的 `analyze_bug` 会创建 GitLab issue（现有 `analyze_bug` 流程默认行为）。这些 issue 第一期统一加 `e2e-auto` label，避免污染人审 issue tracker：

| 事件 | issue 处理 |
|---|---|
| Pipeline B run **passed** | 自动 close 这个 run 关联的所有 e2e-auto issue + 创一个 summary issue 链 MR + 列修了哪些 bug |
| Pipeline B run **failed**（governor unfixable）| 该失败 scenario 关联的 issue **保留**给人看；其他已经修好的 e2e-auto issue 自动 close |
| Pipeline B run **aborted** | 全部关联 issue 标 `closed-due-to-abort`，正文加一行说明 |
| 人审场景的 analyze_bug（非 e2e 触发，`triggering_e2e_run_id IS NULL`）| 不加 e2e-auto label，正常人审流程 |

UI / 通知策略默认折叠 e2e-auto label 的 issue，避免 IM 群被几十个临时 issue 刷屏。

### 4.9 汇总 MR 的人审形态（P3 — 最后一公里）

汇总 MR 是这功能"真正交付价值的最后一公里"——reviewer 看到一坨 8 个 bugfix commit 是产品体验崩溃的灾难。第一期必须把汇总 MR 设计好。

#### 4.9.1 PR 描述模板

```markdown
## 🤖 E2E 自动修复汇总 — Run #42

> 本 MR 由 ChatOps E2E 自动产生：跑了 15 个 scenario，过程中 AI 修了 8 个 bug。
> Reviewer 请逐 commit 查看，可勾选「拒绝某个 commit」让平台 cherry-pick 剩余的开新 MR。

### 摘要
- 测试源分支: `main` ← `feature/x`（如果是 MR webhook 触发，写 MR 链接）
- 修复 commit 数: 8
- 涉及主要文件: `src/agent/prd-submit/*`、`src/admin/routes/approval.ts`...
- 关联 issue: #1234, #1235, ..., #1241（全部 e2e-auto label，已 closed）
- Run 详情: ▶ http://chatops-admin/e2e-runs/42
- 汇总 evidence: ▶ http://chatops-admin/e2e-runs/42/summary

### 修复清单（逐 commit 接受 / 拒绝）

reviewer 在下面 comment "❌ <commit-sha>" 即拒绝该 commit。所有 review 完成后点击下方 "🔄 Apply Selection" 触发 cherry-pick 重开 MR。

| ✓ | Commit | Scenario | Bug Issue | 修改文件 | 评论 |
|---|---|---|---|---|---|
| ☑ | a3f4c2d | login-success | #1234 | src/agent/login.ts | 修复 session token 过期判定逻辑 |
| ☑ | b1e8a99 | create-prd | #1235 | src/agent/prd-submit/handler.ts | 修复 PRD 标题校验 |
| ☑ | c5d7b41 | approval-flow | #1236 | src/admin/routes/approval.ts | 修复审批拒绝场景的 race condition |
...

### Evidence 抽样（高风险 commit）

平台自动挑选 1-2 个 confidence 最低的 commit 附 evidence 截图，提示 reviewer 重点看。

> 🔍 **建议重点 review**: c5d7b41 — 诊断置信度 0.62，涉及并发逻辑改动
```

#### 4.9.2 逐 commit 接受 / 拒绝交互

reviewer 在 GitLab MR comment 区写 `❌ c5d7b41` 表达拒绝特定 commit。**ChatOps 监听 MR comment webhook**：

```
GitLab MR comment webhook → /admin/_webhook/gitlab/mr-comment
   ▼
解析 ❌ <sha> 模式 → 写入 e2e_summary_mr_decisions 表
   ▼
reviewer 点击 PR 描述里的 "🔄 Apply Selection" 链接（实际是发到 ChatOps API 的 trigger）
   ▼
平台重建 cherry-pick 流程：
  - 在新 branch test-iter/<runId>-rev2 上从 sourceBranch HEAD 切出
  - 按 reviewer 接受清单顺序 cherry-pick
  - 强制跑 e2e 一次（小型 verify run）
  - 全过则强制覆盖原汇总 MR
```

**reviewer 想直接改某行代码**：正常 push 到 iteration_branch（PR 是从 iteration_branch 发的）即可，不需要走平台。

#### 4.9.3 数据模型补充

新增表 `e2e_summary_mr_decisions`：

```sql
CREATE TABLE e2e_summary_mr_decisions (
  id           BIGSERIAL PRIMARY KEY,
  e2e_run_id   BIGINT NOT NULL REFERENCES e2e_runs(id) ON DELETE CASCADE,
  commit_sha   TEXT NOT NULL,
  decision     TEXT NOT NULL,  -- accepted | rejected
  reviewer     TEXT NOT NULL,
  reason       TEXT,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (e2e_run_id, commit_sha)
);
```

加进 schema-v1000.sql。

### 4.10 AI 改坏代码合 main 后的回滚机制（P4）

汇总 MR 人审是最后一道闸，但人不是神 — 8 个 bugfix commit 堆一起，reviewer 漏掉一个隐性破坏概率不低。如果不设防，会变成"上次自动修复 → 这次自动再修 → 越改越坏"的兔子洞。

#### 4.10.1 Auto-verify on merge

汇总 MR 合并后**自动跑一次 e2e**（"verify run"）：

```
GitLab MR merged webhook → 平台识别为 e2e 汇总 MR（PR 描述带特定 marker）
   ▼
立即调 createE2eRun({ trigger='post_merge_verify', sourceBranch=<merged target>,
                     scenarioFilter={ ids: <原 run 跑过的 scenario 列表> } })
   ▼
全过 → run 标 "verified"，正常通知
全不过 → 立即 IM 高优先级告警 + UI 在原 run 详情页加红色 banner "Auto-verify 失败！"
        （不自动 revert，让人介入）
```

#### 4.10.2 自动修复溯源链

在 git commit message 里加固定 marker：

```
fix(e2e-auto): repair approval-flow scenario

🤖 generated by ChatOps E2E auto-fix
e2e-run: 42
e2e-scenario: approval-flow
e2e-bug-report: 1236
```

诊断 LLM 在 `[diagnose_and_create_issue]` 节点里**必读**最近 7 天 main 上有这条 marker 的 commit 历史，特别留意"最近自动修过当前失败 scenario 涉及的代码区域"——把这个信息塞进 issue 正文，让人审或后续 fix 一眼能看出"上次自动修是不是错的"。

#### 4.10.3 一键 revert 一次 e2e run 的所有 commit

UI 在 `/e2e-runs/:runId` 详情页加 "🔙 Revert this run's commits"  按钮（admin / 项目 owner 可见）：

```
点击 → 弹确认 Modal："这将创建一个 revert MR，撤销 Run #42 在 main 上的所有 commit"
   ▼
确认 → 平台扫该 run 的 attempt 历史拿到所有 commit_sha
   ▼
   git checkout -b revert/e2e-run-42 main
   git revert <commit_sha_8> <commit_sha_7> ... <commit_sha_1>  （逆序）
   git push + glab mr create --title "Revert E2E Run #42 fixes"
   ▼
人审合并即完成回滚
```

dogfood 期间这功能至关重要——AI 修错了能立刻撤回。第二期接入外部项目时这个按钮甚至应该是 lead 看板的固定操作。

### 4.11 角色与权限矩阵（P1）

复用现有 ChatOps RBAC（DEFAULT_TOOL_ROLES 模式）。第一期默认值：

| 操作 | 角色要求 |
|---|---|
| 登记 / 改 `e2e_target_projects` | platform admin |
| 改 governor 默认值（项目级覆盖） | 项目 owner |
| 触发 e2e_run（IM / UI / API） | 项目成员 + 触发者必须有该项目 read 权限 |
| MR webhook 自动触发 | 不限（trigger_actor = MR 作者）|
| Abort 一个跑着的 run | 触发者本人 + 项目 owner + platform admin |
| 改 e2e_specs（创建 / 重生成） | 项目成员 |
| 切 spec 的「暂停自动 merge」开关 | 项目 owner（admin brake） |
| 在汇总 MR 上做接受 / 拒绝决策 | 项目 owner + 任何被加入 reviewer 列表的人 |
| 一键 revert e2e run commits | 项目 owner + platform admin |
| 看 evidence / 详情页 | 项目成员（read 权限） |
| 跨项目 dashboard（V2）| 任何登录用户（脱敏后）|

**第一期 dogfood ChatOps 自身**时，"项目成员"和"项目 owner"通过现有 ChatOps RBAC 映射；外部项目接入（V2）时由 `e2e_target_projects.capabilities.ownerRole` 字段映射到该项目的 RBAC role。

每个 admin API 端点入口必须挂 RBAC middleware 校验。具体 role 名遵循现有 DEFAULT_TOOL_ROLES 模式（`platform-admin / project-owner / project-member`）。

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

### 5.4 `/e2e-runs`

列表 + 「新建 Run」按钮。Modal 表单：项目 Select（来自 e2e_target_projects，按 CLAUDE.md 枚举字段约定）、**源分支 Input**（自由文本，按 CLAUDE.md "GitLab 路径 / 分支名等自由文本字段保持 Input"）、场景过滤（全部 / tag / IDs，从 `test.sh --discover` 现拿 scenario 列表 Select）、governor 覆盖（折叠面板）。

行内按钮：`「中止」` —— status 在 `running` 或 `awaiting_fix` 时可见。**中止操作的清理顺序**（M3）：

1. UI 点击 `「中止」` → 调 `POST /admin/e2e-runs/:runId/abort`，body 含 `reason`
2. 后端 `UPDATE e2e_runs SET status='aborted', abort_reason=$1, finished_at=NOW()` 立刻完成
3. 异步触发：(a) 若图节点正跑 bugfix capability（`dispatch_bugfix_sync` 在 await 中），向其底层 Claude CLI 子进程发 `SIGTERM`；(b) 调 `teardown_sandbox`（best-effort，错误 swallow + 记 log）；(c) `delete remote iteration_branch`；(d) close 关联 e2e-auto issue 标 closed-due-to-abort
4. UI / IM 收到 status 变更 SSE，标 run 为已中止

中止是 best-effort 操作 — 即便某一步失败也不会回滚 status，避免 run 永远卡 "正在中止" 中间态。

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

#### 5.5.1 SSE 事件 schema

每个事件 payload 都是 JSON。`id` 字段单调递增（基于 DB 序列或时间戳-runId 组合），客户端 reconnect 时通过 `Last-Event-ID` 头拉取自该 id 之后的事件。run 进入终态（passed / failed / aborted）后服务端发一个 `final` 事件然后关流。

| 事件 | payload schema |
|---|---|
| `scenario_started` | `{ scenarioId, scenarioName, attemptNumber, startedAt }` |
| `scenario_finished` | `{ scenarioId, attemptNumber, result: 'pass'\|'fail'\|...,  durationMs, evidenceUri?, linkedBugReportId? }` |
| `status_changed` | `{ from: <old status>, to: <new status>, version: <int>, changedAt }`，`version` 单调递增；客户端用 version 做幂等防 reorder |
| `governor_update` | `{ totalElapsedMs, totalAttempts, perScenarioAttempts: {...}, limits: {...} }` |
| `sandbox_status` | `{ sandboxId, status, kind, endpoints?, modules? }` |
| `final` | `{ status: 'passed'\|'failed'\|'aborted', summary: {...} }`，**发完即关流** |

服务端每 30 秒发一个 `: keepalive\n\n` 注释行防 proxy 关连接。客户端 reconnect 自动用 `Last-Event-ID`。

### 5.6 IM 入口（辅助路径）

D3 决策后，**IM 不再是主入口**（主入口是 MR webhook 自动触发），但保留作为"不在 MR context 的特殊跑"。

新增 capability `e2e_run`，绑 default_pipeline_id 到 Pipeline B。

**单句语法**（D4 — 不再多轮 im_input 收参）：

```
@bot 跑 chatops e2e                    → 默认全部 scenario
@bot 跑 chatops e2e --tag=smoke        → 仅 smoke 标签
@bot 跑 chatops e2e --id=login-success → 单 scenario
@bot 跑 chatops e2e --branch=feat-x    → 指定源分支（默认 main）
```

dogfood 95% 用户都选"全部"，多轮收参是噪音。复杂参数（governor 覆盖）走 UI。

**关键节点推送**（沿用 §5.7 通知策略）：

```
用户:  @bot 跑 chatops e2e
Bot:   ✅ 已启动 Run #42 · 跑 15 个场景 · ▶ http://chatops-admin/e2e-runs/42

[关键节点]
Bot:   📊 Run #42 · 5/15 通过 · approval-flow 失败 · 启动 bugfix · ▶ bug #1235
Bot:   🔧 Run #42 · approval-flow bug 已修复，重新部署沙盒并重试中

[run 完成]
Bot:   ✅ Run #42 PASSED · 15 个场景全过 · 共修复 8 个 bug · 沙盒已销毁
       汇总 MR ▶ https://gitlab.../merge_requests/789
```

**别的 IM 命令**：`@bot 查 e2e run 42` / `@bot 中止 e2e run 42`

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

#### 沙盒怎么起 — 独立 docker network + 强制 token 覆盖 + sentinel

第一期沙盒 `docker-compose-local`，宿主就是 ChatOps 自己的容器。需要在 ChatOps 容器里调 docker socket（commit `cc2a62f` 已挂载）。

但**绝不能直接复用宿主的 network / 配置**。每个 run 的沙盒按下面隔离：

| 隔离维度 | 做法 |
|---|---|
| Docker network | 独立 network `chatops-e2e-sandbox-<runId>`，跟生产 network 不连通 |
| 端口分配 | **`find-free-port` 动态分配**（不用 `13000 + runId%1000` 模数 — 第 1001 个 run 会撞）；分配结果写进 sandbox handle |
| DB URL | `sandbox.sh --provision` 强制覆盖 `DATABASE_URL` 指向沙盒内的临时 PG，**不继承宿主环境** |
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
| Pipeline B 图 | 集成测：mock 所有 invoke_target_script，跑完整图（含 reset_iteration_branch / dispatch_bugfix_sync）| vitest + testcontainer pg |
| Pipeline A 图 | 同上 | |
| Startup recovery | 单测：构造 inflight runs（status='running' / 'awaiting_fix'），调 recovery 函数 → 全部 aborted + teardown 调用 | vitest + testcontainer pg |
| Run abort 清理顺序 | 集成测：触发 abort → 验证 status / sandbox teardown / branch delete / issue close 调用顺序 | vitest |
| Sentinel 校验 | 单测：连真生产库名时拒启动 | vitest |
| 端到端 dogfood | 1 spec → A 生成 → 故意改坏一个文件 → B 跑通自动修复；中间 kill chatops 验 recovery | 手工，里程碑验收 |

**关键约定**：所有 invoke_target_script 测试**走 mock 子进程接口**（注入假 spawn），不真起 docker / 跑 playwright。真实"跑沙盒 + Playwright"只在端到端 dogfood 跑一次。

### 6.3 风险清单 & 缓解

| 风险 | 严重 | 缓解 |
|---|---|---|
| **bugfix capability 改造范围远超"加列"** | 🔴 高 | spec §4.3.1 / §4.3.2 已明示 5 处 fix-logic 改动；周 1 不可省略项，acceptance criteria 见 §6.4 |
| **沙盒里的 chatops 误打真生产** | 🔴 高 | §6.1 三道防线：独立 docker network + 强制覆盖 token / DB URL + 启动 sentinel 校验 `current_database()` |
| **进程重启时 awaiting_fix run 卡死** | 🔴 高 | §4.7 强制 startup recovery hook：扫表 → 全部标 aborted + teardown sandbox + delete branch + close issue。**周 1 不可省略** |
| **Playwright 跑 chatops 自身需要测试账号 + IM 模拟** | 🟡 中 | 复用 `_e2e.ts` mock 端点；Playwright 不通过真 IM，直接 POST `_e2e.ts` 的 inject 端点 |
| AI 生成的脚本反复过不了 baseline | 🟡 中 | governor `baseline_attempts ≤ 3`；UI 留 evidence 给人调脚本 |
| 沙盒资源耗尽 | 🟡 中 | `E2E_RUN_CONCURRENCY=1`；teardown 严格幂等；监控 disk / memory |
| Evidence 文件爆磁盘 | 🟢 低 | 30 天 retention cron；单 run > 100MB 警告；mask 后文本 artifact 通常不大 |
| Evidence 里 secrets 泄露 | 🟢 低 | §6.1 收 evidence 时对所有 `text/*` artifact 跑 mask() |

**最高优先级是前 3 条**：bugfix 改造、沙盒安全、进程重启 recovery。三者任一缺失，第一期就上不了线。

### 6.4 第一期里程碑（5 周）

| 周 | 重点 | Acceptance Criteria（M6 — 具体到可验证条目）|
|---|---|---|
| **周 1** | 集成基础设施：bugfix 改造 + DB schema + startup recovery + 通用节点 | • [bugfix] 单测：`fix-logic.ts` 接受 `iterationBranch + skipMr` 参数，`createFixBranch` checkout 已存在 branch（不 -b）<br>• [bugfix] 集成测：在测试 GitLab 项目里 push 到 `test-iter/<id>` branch，不创 MR<br>• [bugfix] 端到端手工：在 chatops 项目实跑一次 — bug_analysis_reports 带 `sandbox_branch`，commit 落到 `test-iter/<id>`，main 上无变化<br>• [DB] schema-v1000.sql 上线，`pipeline_node_types` enabled ≥ 13 断言通过<br>• [recovery] 单测：进程启动时扫 `running/awaiting_fix` runs → 全部 aborted + 触发 teardown<br>• [节点] `invoke_target_script` 单测（mock spawn，验 stdout JSON / exit code 解析）|
| **周 2** | ChatOps 自身 sandbox 脚本改造 + 沙盒安全防线 | • `chatops/{sandbox,build,package,deploy,test}.sh` 子命令完整<br>• 本地手工 `./sandbox.sh --provision && ./deploy.sh && ./test.sh --discover` 跑通<br>• Sentinel：沙盒里 chatops 启动时校验 `current_database()`，连到生产库时拒启动<br>• 沙盒 docker network 独立 + 端口动态分配可验证 |
| **周 3** | Pipeline B 图 + bugfix 同步 await + e2e_run capability | • Pipeline B 集成测过（mock 所有 invoke_target_script，跑完整图，验状态转移 + governor + reset_iteration_branch）<br>• `e2e_run` capability + IM 多轮收参<br>• 命令行能触发完整 run（不带 UI）<br>• 进程 kill 后重启，inflight run 被 recovery 标 aborted |
| **周 4** | UI（runs 列表 + 详情页 SSE）+ e2e-targets 只读详情 | • 列表 + 详情时间线 + drawer 渲染各 mimeType<br>• SSE 事件 schema 完整（含 lastEventId / final 关流）<br>• 「中止」按钮触发 §5.4 清理顺序，验沙盒被销毁、branch 被删、issue 被 close<br>• `/e2e-targets` 只读详情页 |
| **周 5** | Pipeline A 完整 + 规约页 + IM/MR-webhook 入口 + dogfood 验收 | • Pipeline A 单 spec 跑通（生成 → static check → baseline self-correct → commit + 出 PR + **自动 merge**，**不走人审**）<br>• Playwright codegen 录制入口（D6）跑通 — 录一次 + AI 转 spec<br>• `/e2e-specs` 管理页 + 模板/lint（P10）<br>• IM 单句语法（D4）<br>• **GitLab MR webhook 自动触发（D3）+ comment + status check 回 MR**<br>• 汇总 MR 完整设计（P3）：PR 描述模板 + 逐 commit 接受/拒绝 + cherry-pick<br>• Auto-verify on merge（P4）+ 一键 revert 按钮<br>• 业务指标采集（P2）：`e2e_value_estimates` 表 + verify-run-passed 后弹表单<br>• **dogfood 验收**：手写 2 spec + 录 1 spec → A 生成 → B 跑通；故意改坏一个产品文件 → 自动诊断 → 修复 → 重跑通过；中间故意 kill chatops 进程 → 重启后 run 被 recovery；**沉淀 ≥ 3 个失败案例（P6）+ 输出 4 个业务指标 PPT 一页（P2）** |

**dogfood 验收即第一期 done 的标志**。

### 6.5 指标与日志（可观察性）

#### 6.5.1 业务指标（P2 — 决策者拍板继续投资的依据）

工程指标（§6.5.2）回答"系统跑得好不好"，业务指标回答"这功能值不值得继续投"。**周 5 dogfood 验收必须输出这 4 个指标**，不然第二期立项就是拍脑袋。

| 业务指标 | 定义 | 怎么采集 |
|---|---|---|
| **AI 修复成功率** | 修复 attempt 中 success 的比例 = `bugfix_attempt(success=true) / total_bugfix_attempt` | 来自 `e2e_bugfix_attempt_total` counter，按 `success` label 聚合 |
| **bug 误报率** | governor 标 unfixable 的 scenario 里，多少最终人审判定是脚本 bug 而非产品 bug | UI 详情页给"unfixable scenario"加一个表单字段「人审判定」（`real_bug` / `script_bug` / `infra_issue`），dogfood 用户填一行 |
| **节省人时估算** | 每个修复成功的 case，dogfood 用户在 PR 上填一行"如果人来修预计多少分钟"，跟实际平台耗时对照 | UI 在 verify run passed 后弹一个轻量表单（30s 填完），数据落 `e2e_value_estimates` 表 |
| **重测覆盖率** | 一段时间内触发 e2e 的 MR 数 / 当周仓库总 MR 数 | 主入口是 MR webhook 自动触发，分母从 GitLab API 拉，分子从 `e2e_runs WHERE trigger_type='gitlab_mr'` |

新增表 `e2e_value_estimates`：

```sql
CREATE TABLE e2e_value_estimates (
  id              BIGSERIAL PRIMARY KEY,
  e2e_run_id      BIGINT NOT NULL REFERENCES e2e_runs(id) ON DELETE CASCADE,
  scenario_id     TEXT NOT NULL,
  estimated_human_minutes INT,    -- "如果人来修预计多少分钟"
  actual_platform_seconds INT,    -- 实际平台耗时
  human_verdict   TEXT,           -- real_bug | script_bug | infra_issue | uncertain（unfixable 才填）
  filled_by       TEXT,
  filled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

加进 schema-v1000.sql。

dogfood 期间在每条 verify-run-passed 之后弹这个表单收集数据。第二期立项 review 时，把这 4 个指标做成 PPT 一页：

> "ChatOps E2E dogfood 4 周数据：MR 重测覆盖率 X%、AI 修复成功率 Y%、误报率 Z%、累计节省人时 N 小时。"

没有这页 PPT，第二期不立项。

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
{ "module": "e2e", "runId": 42, "scenarioId": "login-success", "attempt": 2, "stage": "dispatch_bugfix_sync", ... }
```

便于按 runId 抽时间线，按 scenarioId 抽 attempt 轨迹。沙盒里 chatops 自己的 log 走 docker logs `chatops-e2e-sandbox-<runId>`，平台扫这个标签拉沙盒视角的 log（evidence 收集时一并落到 evidence dir）。

#### 6.5.4 Tracing（V2 引入）

第一期不做分布式 tracing。等 V2 ssh-proxy 接入、多模块产品落地后引入 OpenTelemetry。

### 6.6 预算与成本控制（P7）

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

### 6.7 上线推广方案（P5）

dogfood 验收完不等于产品 done — 怎么 scale 到团队 / 公司其他项目，必须有明确路径。

#### 6.7.1 接入新项目的标准步骤（V2 起用，第一期写好文档）

```
1. 项目方在自己仓库根目录加 5 个脚本（参考 chatops 自己的实现）：
     build.sh / package.sh / sandbox.sh / deploy.sh / test.sh
2. 项目方写 1-2 份 TestSpec markdown（用 docs/test-specs/_templates/ 做基础）
3. Platform admin 在 ChatOps 后台 /e2e-targets 登记项目（V2 实现 CRUD UI；V1 期间手 INSERT）
4. 项目方在自己仓库 .gitlab-ci.yml 加一个步骤跑 chatops-test-target lint，
   验证 5 个脚本子命令完整 + stdout JSON 协议合法（V2 提供这个 lint 工具）
5. 项目方在 GitLab 仓库 webhook 配置加 ChatOps 平台地址 → 自动触发 e2e on MR
6. 跑通第一次 → 加入"已接入"列表
```

#### 6.7.2 接入手册 + demo

- 周 5 dogfood 完成后，整理 dogfood 期间的实际经验出 `docs/e2e-onboarding.md`
- 录一段 30 分钟 demo 视频：「从零接入 + 看 dogfood Run 详情」
- 提供 sample 仓库 `chatops-e2e-sample` —— 项目方 fork 改改就能跑

#### 6.7.3 失败案例库（P6）

dogfood 期间会出现各种 AI 改错、误诊、卡死的 case。**必须沉淀成「已知失败模式」** 给后续接入方避坑：

- 在 ChatOps 仓库新建 `docs/e2e-failure-modes/` 目录
- 每个 case 一个 markdown：现象 / 诊断过程 / 根因 / 缓解方法 / 是否影响产品决策
- dogfood 周 5 验收时**必须沉淀 ≥ 3 个 case**，否则不算合格

### 6.8 跨项目 dashboard 提前到 V2（P9）

原计划第六期才做"跨项目 dashboard"，但第二期 ssh-proxy 接入开始就需要 — lead 想看公司所有项目的 e2e 健康度。提前到 V2：

| 视图 | 内容 |
|---|---|
| 项目列表 | 每个项目最近 7 天的 run 通过率 / 平均修复时长 / 关键告警 |
| 趋势图 | 修复成功率随时间变化、token 消耗趋势、误报率趋势 |
| 高风险项目预警 | 修复成功率连续 3 天下降 / governor abort 频率上升 |

第一期不实现 UI，但**业务指标的数据 schema 第一期就要打好基础**（§6.5.1 的 `e2e_value_estimates` 表 + 业务指标统一通过 `e2e_runs` JOIN 聚合），避免 V2 才发现没数据可拉。

### 6.9 撤回 / sunset 路径（P8）

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

### 6.10 后续阶段路线图（仅记录）

- **第二期**：ssh-proxy 接入（验证多项目 contract）+ scenario 并行 + 失败留沙盒 + `affected_modules` 增量 redeploy + e2e-targets 完整 CRUD + ping-pong 检测 + **跨项目 dashboard（P9 提前）**
- **第三期**：多模块多机环境编排独立需求（k8s / VM pool / remote-multi-host）+ 资源池调度
- **第四期**：bugfix 跑独立 worker → 切回 `wait_webhook + HTTP callback + HMAC` 协议；max_concurrency > 1
- **第五期**：PRD → Spec 自动派生

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

| 现有机制 | 怎么复用 / 改造 |
|---|---|
| LangGraph Pipeline 引擎（`src/pipeline/`）| Pipeline A / B 都是 LangGraph，复用现有 graph-builder / graph-runner / interrupt-resume / `wait_webhook`（仅 PRD/IM input 用，本模块第一期不用）。Pipeline B 主循环用 LangGraph 原生 `conditional_edge` 自循环 |
| `_e2e.ts` mock 端点 | Playwright 跑 ChatOps 自身时通过这些端点注入 IM 消息 / 模拟 Claude 响应；沙盒里 chatops 的 Claude mock 也走这套 |
| Bugfix capability `analyze_bug` / `src/agent/fix/*` | **需要 5 处改造**（详见 §4.3.2）：`fix-runner.RunFixForProjectInput` 加 `iterationBranch` + `skipMr`；`branch-manager.createFixBranch` 支持 checkout 已存在 branch；`fix-logic.rebaseOnTarget` 跳过；`pushBranch + createMr` 路径分支；coordinator extraParams 透传。**周 1 不可省略** |
| `internal_capability_pipelines` 映射 | 新增 `e2e_run` / `e2e_generate_script` 两条映射 |
| IM-Driven Pipeline Flow | `e2e_run` capability 走现有 IM input 多轮 interrupt 路径（im_input 节点真用 LangGraph interrupt；本模块的 dispatch_bugfix_sync 是同进程 await，不用 interrupt）|
| `pipeline_node_types` 表 | 新增 `invoke_target_script` 一个 node 类型；不新增 `loop`（用 LangGraph 原生 conditional_edge）|
| stage log SSE（commit `73f9759`）| 详情页 SSE 复用同一通道模式，事件 schema 见 §5.5.1 |
| `resolveGitlabConfig()`（`src/config/gitlab.ts`）| commit / push / 创 MR 的代码统一走它读 GitLab token（CLAUDE.md 硬约束）—— `[init_run]` `[reset_iteration_branch]` `[create_summary_mr]` `[commit_and_pr]` 节点都受此约束 |
| `mask()`（`src/agent/masking/sensitive-info.ts`）| `[collect_evidence]` 节点对所有 `text/*` artifact 跑 mask，避免 evidence 泄露 token |
| 现有 `chatops/build.sh / build-base.sh / deploy.sh / test.sh` | dogfood 时的脚本契约改造在它们之上扩子命令；新增 `chatops/sandbox.sh`（项目目前没有这个）|
| Server startup hook | **新增** `recoverInflightE2eRuns()`（详见 §4.7）—— 进程启动时扫 inflight runs 全部标 aborted + teardown，**不可省略** |
