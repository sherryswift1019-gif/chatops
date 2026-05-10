# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ChatOps 是一个 DevOps 自动化平台，通过 IM（钉钉/飞书）群聊接入 Claude AI Agent，使团队成员能以对话方式执行部署、日志查看、回滚等运维操作。后端同时提供管理后台 API 和前端 SPA。

## Commands

```bash
# 后端开发（热重载）
pnpm dev

# 前端开发（Vite dev server，端口 5173，代理 /admin → localhost:3000）
cd web && pnpm dev

# 测试
./test.sh              # 全套（vitest run），自动启 testcontainer postgres + tee 到 logs/
                       # 200s+ 单次跑完落盘，绝不"先 tail 再 grep"两遍跑
./test.sh --filter <pattern>   # 透传给 vitest run，跑匹配文件
./test.sh --typecheck          # 仅 tsc --noEmit（前后端）
pnpm test              # 直接 vitest run，但不走 test.sh 的环境准备
npx vitest run src/__tests__/unit/approval-router.test.ts  # 单个测试文件

# 前端构建
cd web && pnpm build   # TypeScript 类型检查 + Vite 产物输出到 web/dist

# 数据库迁移
pnpm migrate           # 跑 src/db/migrate.ts：按 SCHEMA_FILES 列表（v1..v45+）顺序应用
                       # _migrations 表登记已 applied 版本，避免重复跑
                       # 老库（无 _migrations 表）按 fingerprint 推断 bootstrap 到 v33/v37/v38

# Docker 镜像构建（两层：base 依赖层 + 业务层）
# base 只在 pnpm-lock.yaml / package.json / Node/pnpm 版本变化时重建
./build-base.sh        # 构建并 push linux/amd64 base 到 harbor.paraview.cn/chatops/chatops-base
                       # 同时打 :latest 和 :deps-<lockfileSha8> 两个 tag
./build.sh             # 日常业务构建：docker build 多阶段（前端在内部编译 + 后端 tsc）
                       # 环境变量：IMAGE_NAME / IMAGE_TAG / BASE_IMAGE / PLATFORM
                       # 依赖已在 base 里，业务镜像仅装前端依赖 + COPY src/

# GitLab CI（code.paraview.cn，推送 master 或打 tag 自动触发）
# .gitlab-ci.yml 定义两个 stage：
#   build-base — 仅 pnpm-lock.yaml / package.json / Dockerfile.base 变更时触发
#   build-app  — master 推送或 tag 推送时触发
# CI Variables: HARBOR_USERNAME / HARBOR_PASSWORD（GitLab 项目设置）
# Runner: amd64, Docker-in-Docker, Paraview 内网

# Docker 部署
./deploy.sh up         # 启动全栈（postgres + migrate + chatops），自动 --build
./deploy.sh down | restart | logs | status | migrate
```

## Architecture

### 请求流

```
IM 消息 → Adapter(DingTalk/Feishu) → SessionManager → ClaudeRunner → MCP Server → Tools → DB
                                                                                         ↓
                                                                              IM 回复 ← Adapter
```

### IM-Driven Pipeline Flow（schema-v19 起）

当 IM 消息触发某 capability 时，若 `capabilities.default_pipeline_id` 非空则走
Pipeline 路径而非裸 Agent：

```
IM 消息 → Adapter → SessionManager.handleMessage
                          │
                          ├── findImInputWaiter 命中？（已有 pipeline 等输入）
                          │   └── resumeFromImInput → graph.stream(Command)
                          │
                          └── 无 waiter → queue → Agent
                                                 │
                          ┌── coordinator.triggerCapability ←─┘
                          │         │
                          │         ├── capability.defaultPipelineId != null
                          │         │   └── runPipeline(triggerType='im',
                          │         │                   imContext={platform,groupId,userId})
                          │         │        └── im_input stage interrupt()
                          │         │             ├── graph-runner 注册 im-router waiter
                          │         │             ├── notifyImGroup 推 prompt 到群
                          │         │             └── 等下一条 IM 消息 resume
                          │         │
                          │         └── 无绑定 → 走旧 handler（零回归）
```

关键模块：
- `src/pipeline/im-router.ts` — `(platform, groupId)` ↔ `(runId, stageIndex)` 双向映射
- `src/pipeline/im-input-agent.ts` — 启发式参数判定（key=value / 单字段 / enum / 取消）
- `src/pipeline/im-notifier.ts` — pipeline → IM 群消息通道，adapter 启动时注册 sender
- `src/pipeline/graph-builder.ts:buildImInputNode` — im_input stage 多轮 interrupt 循环
- `src/pipeline/graph-runner.ts:resumeFromImInput` — 带 race-winner claim 的 resume 入口

冒烟手册：`docs/smoke-im-pipeline.md`

### Pipeline Dry-Run（schema-v45 起）

画布里点节点 ▶ 或工具栏「触发执行」走 SSE 流式 dry-run，副作用节点（script / dm /
db_update / http）会弹决策框（真跑 / Stub / 手填），输出按节点维度落到
`pipeline_dryrun_snapshots` 表，下游节点抽屉「上游字段」Tab 渲染 `{{steps.<id>.output.x}}`
树供复制。关键模块：
- `src/pipeline/dryrun-runner.ts` — `runDryRun` 主循环 + advisory lock + WEBHOOK_INTERRUPT 处理
- `src/pipeline/graph-builder.ts:wrapSideEffect / wrapWithSnapshot` — 节点级 dry-run 拦截
- `src/pipeline/dryrun-stub.ts` — 按 paramSchema 自动生成 stub 输出
- `src/admin/routes/dryrun.ts` — 6 个 endpoint（snapshots / decide / run-to SSE）
- `web/src/pipeline-canvas/dryrun/` — SSE hook + 启动 Modal + 决策 Modal + 等待 banner
- `im_input` 节点在 dry-run 中**跳过**真实 IM 多轮采集，直接取 triggerParams 当 collected 写
  snapshot（`buildImInputDryRunNode`）

### 后端 (`src/`)

- **server.ts** — Fastify 入口，注册适配器、审批网关、管理 API、静态文件服务
- **config.ts** — Zod 校验环境变量，必需：`DATABASE_URL`。可选：`CLAUDE_CODE_OAUTH_TOKEN`（未设置时从系统配置页面 Claude 标签读取）、`ANALYSIS_CONCURRENCY`（多 project Bug 分析并发上限，默认 3；fix-runner 固定串行即并发=1，不通过环境变量配置）、`MR_RECONCILE_INTERVAL_MS`（MR 状态对账调度间隔，默认 300000 = 5min，最小 60000）、`MR_RECONCILE_WINDOW_DAYS`（对账扫描窗口，默认 7 天）、`MR_RECONCILE_CONCURRENCY`（对账并发上限，默认 1 = 串行）
- **adapters/im/** — IM 平台适配层（`IMAdapter` 接口），钉钉用 Stream 模式、飞书用 Webhook 模式
- **agent/** — AI Agent 核心
  - `claude-runner.ts` — 通过 Porygon (`@snack-kit/porygon`) 调用 Claude CLI
  - `mcp-server.ts` — stdio MCP Server，作为子进程被 Porygon 启动，暴露自定义工具给 Claude
  - `session-manager.ts` — 按 (platform, groupId) 管理会话，8 小时 TTL
  - `task-queue.ts` — 任务队列
- **agent/tools/** — MCP 工具，通过 `registerTool()` 自注册到全局 registry（见下方模式说明）
- **approval/** — 审批工作流：Gate（请求入口）→ Router（规则路由）→ Escalation（超时升级）
- **pipeline/** — 流水线执行引擎：Scheduler（cron）、Executor、SSH 远程执行、变量插值
- **db/** — PostgreSQL 数据层，纯 SQL + Repository 模式（无 ORM）

### 前端 (`web/`)

React 18 + Ant Design 5 + React Router v6 SPA。组件级 state（无全局状态管理）。API 层在 `web/src/api/`，使用 axios。

### 数据库

PostgreSQL，pg 驱动直连。Schema 在 `src/db/schema.sql` + `schema-v2.sql..schema-v45.sql`（v27 是历史 squash 空号被 `pipeline_node_types` 占用）。`migrate.ts` 用 `_migrations` 表登记已 applied 版本；新增字段 / 表用 `IF NOT EXISTS` / `ALTER TABLE IF` 保证幂等。Repository 文件在 `src/db/repositories/`。

## Key Patterns

### Tool 自注册

> 详见 [docs/standards/tool-registration.md](docs/standards/tool-registration.md)（v2 完整版含 grep 校验）

新增 MCP 工具需要：
1. 在 `src/agent/tools/` 创建文件，实现 `AgentTool` 接口并调用 `registerTool()`
2. 在 `src/server.ts` 和 `src/agent/mcp-server.ts` 中添加 `import './tools/<name>.js'`
3. 如需 RBAC 默认角色配置，在 `src/agent/tools/types.ts` 的 `DEFAULT_TOOL_ROLES` 中添加

### GitLab 配置读取约定（2026-04-20）

> 详见 [docs/standards/gitlab-config.md](docs/standards/gitlab-config.md)（v2 完整版含 grep 校验 + 例外清单）

所有访问 GitLab 的代码必须调 `resolveGitlabConfig()`（[src/config/gitlab.ts](src/config/gitlab.ts)），**不要直接 `process.env.GITLAB_URL/TOKEN` 或裸调 `getConfig('gitlab')`**。

读取顺序：
1. DB `system_config.gitlab` 中的 `{url, token, skipTlsVerify}`
2. 任一为空时回退读 `process.env.GITLAB_URL` / `GITLAB_TOKEN` / `GITLAB_SKIP_TLS_VERIFY`（后者 `"true"` 或 `"1"` 算 true）
3. 都空则返回空值，调用方自行判断并报错

**例外**：严益昌原创 `src/pipeline/executor.ts:29` 保持 `process.env.GITLAB_URL` 不动（6 文件零改动硬约束）。

### DB Repository 约定

> 详见 [docs/standards/repository-pattern.md](docs/standards/repository-pattern.md)（v2 完整版）

- 直接写参数化 SQL（`$1, $2...`），无 ORM
- 数据库字段 snake_case，TypeScript camelCase，repository 中 `mapRow()` 做转换
- 新增迁移：创建 `src/db/schema-vN.sql`，然后在 `src/db/migrate.ts:SCHEMA_FILES` 中追加一行

### Schema 编号顺序（2026-04-28）

> 详见 [docs/standards/db-schema-versioning.md](docs/standards/db-schema-versioning.md)（v2 完整版含双 SCHEMA_FILES 同步检查）

新建 schema 文件时**版本号必须早于所有引用其表/列的 schema 文件**。例：
`pipeline_node_types` 表的 CREATE 在 v27，则 v34/v35/v36/v44 才能 INSERT/UPDATE 它。
合并 main 时若版本号跟远端撞车（同号不同内容），优先**让出占用历史 squash 空号**
（如 v27 / 未来其它空号）而非简单往尾追加，否则后续 schema 数字升序跑时会炸
"relation does not exist"。两份 `SCHEMA_FILES` 列表都要同步：
- `src/db/migrate.ts` — 生产 / 部署 / 本地 dev 用
- `src/__tests__/helpers/db.ts` — `resetTestDb()` 用，**故意排除 v21..v28 大部分**
  避免 seed 数据污染 fixture（"全新表 + 非污染 catalog seed"才能加进去）

### 测试基础设施

> 详见 [docs/standards/test-conventions.md](docs/standards/test-conventions.md)（v2 完整版含 vitest --related 命令模板）

`./test.sh` 是 canonical 入口（200s+ 全套）。本地跑时 vitest globalSetup（`src/__tests__/setup/pg-container.ts`）
会启一次性 `postgres:16-alpine` testcontainer 并扫所有 `schema-v*.sql` 跑一遍；CI 短路
（`process.env.CI === 'true'` 时复用 GitLab service postgres）。`resetTestDb()` 用 marker
表 `chatops_test_db_marker` 校验当前库是测试库后才 `DROP SCHEMA public CASCADE`，业务库
误连会被拒。新增不依赖 DB 的纯单测可绕开整个 setup（`*.test.ts` 不 import db client 即可）。

### Admin API 路由

所有管理端点在 `/admin` 前缀下，路由文件在 `src/admin/routes/`，通过 `src/admin/index.ts` 注册为 Fastify 插件。

### 前端表单：枚举字段下拉规范（2026-04-22）

> 详见 [docs/standards/frontend-enum-select.md](docs/standards/frontend-enum-select.md)（v2 完整版）

新增 / 审查任何管理后台表单时，按"**定义** vs **使用**"原则决定控件类型：

**使用枚举（引用已有记录）→ 必须 Select 下拉**，不允许手写 Input：
- 典型例子：审批规则里的 `action`（引用 capability.key）、`env`（引用 environment.name）；pipeline 画布节点的 `capabilityKey`；产线环境配置里的 runtime、server 选择
- 数据源从对应 admin API 拉（`getCapabilities / getEnvironments / getTestServers / ...`）
- 允许通配（如审批规则的 `*`）时，Select 里额外加一项作为列表首项，带明显标记（`<Tag color="purple">*</Tag> 任意 XX（通配）`）
- **Stale 兼容**：如果记录里保存的值不在当前列表（源记录被删 / 重命名），不清空该值，Select 显示为 `<ExclamationCircleTwoTone twoToneColor="#faad14" /> {value}（不在列表中）`，允许用户保留或替换
- `showSearch` + 自定义 `filterOption`（按 key + displayName 双字段匹配）；option label 建议 `{displayName} <small>({key})</small>` 的形式

**定义枚举（创建新记录）→ 保持 Input**：
- 典型例子：环境管理页新增环境时的 `name`；能力管理页新增 capability 时的 `key`
- 这是用户手动输入新枚举值的地方，不能下拉

**自由文本 / 动态外部数据 → 保持 Input**：
- GitLab 路径、Docker 容器名、分支名等自由文本字段
- 可选：字段下方 `extra` 文字给出格式提示，或支持 `{{vars.xxx}}` 模板提示

**要改下拉但 API 缺失怎么办**：先加 admin GET 端点（哪怕读只读），不要因为"没 API 就留 Input"。

参考实现：`web/src/pipeline-canvas/panels/NodeInspector.tsx`（capability Select + stale 兼容）、`web/src/pages/ApprovalRulesPage.tsx`（action/env 含通配符 Select）。

### Commit 约定

> 详见 [docs/standards/commit-conventions.md](docs/standards/commit-conventions.md)（v2 完整版，dev-loop role 强制遵守）

- quick-impl pipeline 的 dev-loop role 必须**按任务 commit**，不一次性大 commit
- commit message：`feat(qi-{requirement_id}): T{n} {任务标题}` / round 2+ 修订用 `fix(qi-{requirement_id}): T{n} 修订 — {反馈摘要}`
- dev-loop **不 push**（mr_create 节点统一推）
- 不 rebase / amend / `--no-verify` / force push（除非用户显式要求）

### 代码风格约定

> 详见 [docs/standards/code-style.md](docs/standards/code-style.md)（v2 完整版）

- TypeScript strict mode 通过 `pnpm exec tsc --noEmit`；ES2022 + NodeNext modules，import 路径用 `.js` 后缀
- 错误处理仅在系统边界（用户输入 / 外部 API），内部代码信任 framework guarantees
- **默认不写注释**；仅在 WHY 非显然时加（隐藏约束 / 不变量 / workaround / 反直觉行为）
- 不写"used by X" / "added for Y" / "fix issue #N" 这类引用代码 / PR 的注释
- 起名前先 grep 类似实现，对齐既有模式

### Skill Reviewer 设计约定（2026-05-09）

> 详见 [docs/standards/skill-reviewer-design.md](docs/standards/skill-reviewer-design.md)（v1 完整版）

新建 reviewer role 或配置含审查节点的 pipeline 时，遵循以下 6 条：
1. **双源输入**：reviewer 同时读 `devOutput`（JSON）和 `artifact_path`（文件全文），不能只信 JSON
2. **specCoverage[]**：逐条输出 AC 覆盖证据，数量 == spec.acceptanceCriteria.length，`covered: false` 必须有 missingReason
3. **Error vs Warn 分级**：失败会让 dev 工作无效 → error；只降低质量 → warn；fail 条件写进 `superRefine`
4. **条件边路由**：AI review 失败升级人工用 `onFailure: 'continue'` + `condition: { kind: 'onFailure' }` 边，而非 `onFailure: 'stop'`
5. **stepOutputs 暴露**：所有产出 artifact 的 skill 节点，success stepOutputs 必须含 `lastArtifactPath`（文件路径）和 `skillOutput`（完整 JSON）
6. **priorReviewerNotes 透传**：AI review 失败升级到人工节点时，inputs 里传入 AI reviewer 的 notes

## Tech Stack

- **Runtime**: Node.js + TypeScript (ES2022, NodeNext modules, strict mode)
- **Backend**: Fastify 5
- **Frontend**: React 18 + Vite + Ant Design 5
- **Database**: PostgreSQL 16 (pg driver, raw SQL)
- **AI**: Claude via `@snack-kit/porygon` + `@modelcontextprotocol/sdk`
- **IM**: dingtalk-stream-sdk, feishu SDK
- **Package Manager**: pnpm
- **Test**: Vitest
