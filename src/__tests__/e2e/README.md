# E2E 验收测试

> **角色**：开发计划完成后的末端自动化验收。集成测试验证代码逻辑，这里验证**完整链路（后端 + 前端 + 数据流）**，人只做最后一道主观验收。

## 目录

| 路径 | 用途 |
|---|---|
| `fixtures/base.sql` | 基础 seed（productLine / projects / pipelines / capabilities） |
| `mocks/server.ts` | Express mock，拦截 Claude CLI / GitLab API 调用 |
| `helpers/setup.ts` | 启后端 + 前端 + mock + reset DB |
| `*.spec.ts` | 测试脚本 |

## 跑

```bash
# 本地
pnpm test:e2e              # headless 跑全部
pnpm test:e2e --headed     # 看浏览器
pnpm test:e2e --ui         # Playwright UI mode
pnpm test:e2e specname     # 单个 spec
```

## 约定

1. **DB**：每个 spec 开始前 reset + 重新 seed，保证独立
2. **Mock**：外部依赖（Claude CLI、GitLab API）全部 mock，不打真网络
3. **并发**：workers=1，避免 DB 冲突
4. **Build**：e2e 会自动跑 `web && pnpm build` 生成前端产物，后端 serve

## 范围（本次 Pipeline 编排 plan）

共 ~18 个场景，分 3 批：
- **A 批**：Pipeline 核心链路 10 条
- **B 批**：BugRunsPage 交互 5 条
- **C 批**：审批群内命令 3 条

详见 `docs/superpowers/plans/2026-04-17-pipeline-full-orchestration.md` 的 Task 18。
