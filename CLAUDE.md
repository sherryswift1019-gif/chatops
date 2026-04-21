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
pnpm test              # 单次运行
pnpm test:watch        # watch 模式
npx vitest run src/__tests__/unit/approval-router.test.ts  # 单个测试文件

# 前端构建
cd web && pnpm build   # TypeScript 类型检查 + Vite 产物输出到 web/dist

# 数据库迁移
pnpm migrate           # 顺序执行 schema.sql → schema-v7.sql

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

PostgreSQL，pg 驱动直连。Schema 通过 `src/db/schema.sql` 至 `schema-v7.sql` 顺序迁移，每个版本使用 `IF NOT EXISTS` / `ALTER TABLE IF` 保证幂等。Repository 文件在 `src/db/repositories/`。

## Key Patterns

### Tool 自注册

新增 MCP 工具需要：
1. 在 `src/agent/tools/` 创建文件，实现 `AgentTool` 接口并调用 `registerTool()`
2. 在 `src/server.ts` 和 `src/agent/mcp-server.ts` 中添加 `import './tools/<name>.js'`
3. 如需 RBAC 默认角色配置，在 `src/agent/tools/types.ts` 的 `DEFAULT_TOOL_ROLES` 中添加

### GitLab 配置读取约定（2026-04-20）

所有访问 GitLab 的代码必须调 `resolveGitlabConfig()`（[src/config/gitlab.ts](src/config/gitlab.ts)），**不要直接 `process.env.GITLAB_URL/TOKEN` 或裸调 `getConfig('gitlab')`**。

读取顺序：
1. DB `system_config.gitlab` 中的 `{url, token, skipTlsVerify}`
2. 任一为空时回退读 `process.env.GITLAB_URL` / `GITLAB_TOKEN` / `GITLAB_SKIP_TLS_VERIFY`（后者 `"true"` 或 `"1"` 算 true）
3. 都空则返回空值，调用方自行判断并报错

**例外**：严益昌原创 `src/pipeline/executor.ts:29` 保持 `process.env.GITLAB_URL` 不动（6 文件零改动硬约束）。

### DB Repository 约定

- 直接写参数化 SQL（`$1, $2...`），无 ORM
- 数据库字段 snake_case，TypeScript camelCase，repository 中 `mapRow()` 做转换
- 新增迁移：创建 `src/db/schema-vN.sql`，然后在 `src/db/migrate.ts` 中追加执行

### Admin API 路由

所有管理端点在 `/admin` 前缀下，路由文件在 `src/admin/routes/`，通过 `src/admin/index.ts` 注册为 Fastify 插件。

## Tech Stack

- **Runtime**: Node.js + TypeScript (ES2022, NodeNext modules, strict mode)
- **Backend**: Fastify 5
- **Frontend**: React 18 + Vite + Ant Design 5
- **Database**: PostgreSQL 16 (pg driver, raw SQL)
- **AI**: Claude via `@snack-kit/porygon` + `@modelcontextprotocol/sdk`
- **IM**: dingtalk-stream-sdk, feishu SDK
- **Package Manager**: pnpm
- **Test**: Vitest
