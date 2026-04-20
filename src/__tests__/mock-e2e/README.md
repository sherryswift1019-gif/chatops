# Mock E2E 集成测试

> ⚠️ **重要：这不是真正的 E2E 测试**
>
> 这里是 **Playwright + Mock 的集成测试**，外部依赖（Claude CLI、GitLab API）全部被 mock 掉，不打真网络。
> 它覆盖的是"UI + Fastify 后端 + PostgreSQL + 本地 mock server"这一圈的集成行为，
> 不保证真环境下（真 GitLab / 真 Claude）的端到端正确性——那需要 staging 或人工验收补。
>
> 目录名从 `e2e/` 迁移到 `mock-e2e/` 就是为了避免被误读为真端到端测试。

## 目录

| 路径 | 用途 |
|---|---|
| `fixtures/base.sql` | 基础 seed（productLine / projects / pipelines / capabilities） |
| `mocks/gitlab-server.ts` | Express mock，拦截 GitLab API 调用（4001 端口） |
| `helpers/global-setup.ts` | 启后端 + 前端 + mock + reset DB |
| `helpers/per-test.ts` | 每个 spec 的 before/after 逻辑 + seedClaudeMock |
| `*.spec.ts` | 测试脚本 |

## 跑

```bash
# 本地（必须显式指定测试库，绝不能用开发/生产库）
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test:e2e
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test:e2e --headed     # 看浏览器
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test:e2e --ui         # Playwright UI mode
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test:e2e specname     # 单个 spec
```

> ⚠️ **必须显式指定 DATABASE_URL=chatops_test 测试库** ⚠️
>
> `global-setup.ts` 在每次 e2e run 开始前会 `DROP SCHEMA public CASCADE`，**全量重置**所连接的数据库。
> 如果忘记传 `DATABASE_URL`，会 fallback 到 `.env` 里的开发库 `postgres://chatops:chatops@localhost:5432/chatops`——**开发/验收数据全部被清空**。
>
> 本项目有过一次这种事故：`bug_analysis_reports` 里残留了一条 mock seed 脏数据（`[PAM/pas-api] 跨服务字段不一致...`），就是 e2e 没分流 DATABASE_URL 导致的。2026-04-20 清理完毕。
>
> **前置检查脚本**（可以贴到你的 shell alias 里）：
> ```bash
> # alias test:e2e='DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test:e2e'
> ```
> 或者 CI 里把 DATABASE_URL 固化在 job env 里，本地开发机靠这个前置检查。

> npm script 名保留 `test:e2e` 未改，避免破坏现有习惯。Playwright 官方术语也仍用 "e2e"。

## 约定

1. **DB**：每个 spec 开始前 reset + 重新 seed，保证独立。**必须指向 chatops_test 库**（见上）
2. **Mock**：外部依赖（Claude CLI、GitLab API）全部 mock，不打真网络
3. **并发**：workers=1，避免 DB 冲突
4. **Build**：自动跑 `web && pnpm build` 生成前端产物，后端 fastify-static serve

## 与"真 E2E"的差异

| 维度 | Mock E2E（本目录） | 真 E2E（未来补充） |
|---|---|---|
| Claude CLI | mock server 吐预置响应 | 真实调 `@snack-kit/porygon` |
| GitLab API | Express mock 在 4001 端口 | 真 GitLab 实例（staging） |
| 钉钉 / 飞书 | 未接 | 沙盒群 webhook |
| 适用场景 | CI / PR gate / 本地回归 | 重大版本人工验收 |

## 与 `integration/` 的差异

项目里 `src/__tests__/` 下同时存在 `integration/` 和 `mock-e2e/`，两者都"带 mock"，但粒度和覆盖层完全不同——不是替代关系，是**测试倒金字塔里的两层**。

| 维度 | `integration/`（Vitest） | `mock-e2e/`（Playwright） |
|---|---|---|
| 测试框架 | Vitest | Playwright |
| Mock 方式 | `vi.mock()` 在**代码层**替换模块 | 独立 **HTTP 进程**冒充 GitLab，Claude 由 e2e-store 种 fake 响应 |
| 被测载体 | 直接 import handler 函数，Node 进程内跑 | 真启 Fastify（3001）+ 真启 Chromium 访问 `web/dist` |
| 前端 UI | 完全不涉及 | 真渲染，页面点击 + 断言 DOM |
| 数据库 | 真 PostgreSQL | 真 PostgreSQL |
| 网络层 | 无（函数直接返回 mock 值） | 真 HTTP 请求穿到 mock server |
| 跑法 | `pnpm test` | `pnpm test:e2e` |
| 速度 | 秒级 | 分钟级 |
| 典型场景 | "handleAnalysisComplete 在 L2 多 project 下事件流是否对" | "用户点重试按钮 → 后端 → UI 显示新 run" |

选择原则：

- 测**后端模块之间的协同**（handler + coordinator + repository + capability）→ 写在 `integration/`，快、稳、易调试
- 测**用户可见的 UI 路径 + HTTP 链路**（按钮状态、筛选、翻页、跨页面数据流）→ 写在 `mock-e2e/`
- 测**纯函数 / 分支逻辑** → 写在 `unit/`

```
       mock-e2e（少，覆盖 UI 路径）
              ↑
     integration（中，覆盖后端模块协同）
              ↑
            unit（多，覆盖纯函数分支）
```

## 范围

当前覆盖场景分布在 `.spec.ts` 文件里，按业务域命名：
- **approval-cmd-***：群内审批命令（approve / reject / reanalyze）
- **bug-l1/l2/l3/l4-***：不同等级 bug 的修复链路
- **bug-handover / bug-fix-exhausted-handover / bug-non-bug-flow**：V2 handover 相关
- **bug-retry / bug-pipeline-retry-idempotency**：重试路径
- **bugpage-***：BugRunsPage UI 交互

## 已知盲区（Growth Backlog）

### Claude 输出解析层未被 mock-e2e 覆盖

**现状**：`runFilterStage` / `runDetailStage` 等调 Claude 的函数都有 `isClaudeMock()` short-circuit 分支，**直接返回已解析好的 JS 对象**（`popMockResponseValidated` 返回 spec seed 的原始 object）。这样设计是为了 e2e 稳定性和速度——但代价是：

```typescript
// 生产路径（e2e 永远跳过）：
const rawOutput = await runClaudeCli(prompt)        // ← 未测
const jsonStr = extractJsonFromOutput(rawOutput)    // ← 未测
const parsed = JSON.parse(extractJson(jsonStr))      // ← 未测
// 字段校验...                                        // ← 未测
```

**踩坑案例**：2026-04-20 发现 `extractJsonFromOutput` 用 `lastIndexOf('{')` 定位 JSON 起点——在嵌套 JSON 时会抓到内层对象，外层 `involvedProjects` / `primaryProjectPath` 结构全丢。**本地真实钉钉 @机器人才暴露**，commit `2b587b5` 修复，单测补齐（`src/__tests__/unit/extract-json-from-output.test.ts` 6 case）。

**改进选项**（未来做）：
1. 新增 integration 测试，`vi.mock` 掉 `runClaudeCli` 使其返回**原始文本字符串**，让 `runFilterStage` 走真实的 `extractJsonFromOutput` + `JSON.parse` + 字段校验链路
2. `popMockResponseValidated` 框架扩展：支持 seed "文本模式"（返回 string，调用方仍走解析）和 "对象模式"（现状，short-circuit）
3. 选项 1 成本低（一个测试文件），选项 2 最彻底但改动大

**当前兜底**：单测层 `extract-json-from-output.test.ts` 覆盖纯函数行为。够回归保护，不够端到端真实性验证。

- **health**：基础连通性
