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
# 本地
pnpm test:e2e              # headless 跑全部
pnpm test:e2e --headed     # 看浏览器
pnpm test:e2e --ui         # Playwright UI mode
pnpm test:e2e specname     # 单个 spec
```

> npm script 名保留 `test:e2e` 未改，避免破坏现有习惯。Playwright 官方术语也仍用 "e2e"。

## 约定

1. **DB**：每个 spec 开始前 reset + 重新 seed，保证独立
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
- **health**：基础连通性
