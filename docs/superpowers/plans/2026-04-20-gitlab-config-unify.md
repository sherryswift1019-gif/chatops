# GitLab Config Unify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement.

**Goal:** 消除 GitLab 配置读取的 env/DB 分裂现状，统一到 **"DB 优先 + env fallback"** 模式。韩凤锋提交的 8 处代码调同一封装函数，严益昌原创 `executor.ts` 保持不动。

**Architecture:** 新封装函数 `resolveGitlabConfig()` 内部先查 DB `system_config.gitlab`，缺 url/token 时回退读 env。所有调用方改为调封装，不再直接 `process.env.GITLAB_*` 或裸调 `getConfig('gitlab')`。

**Tech Stack:** TypeScript + Fastify + PostgreSQL + Vitest

---

## 决策依据（溯源）

2026-04-18 commit `5a4cfb7 feat(system-config): 钉钉 Stream 连接状态 + GitLab/Harbor 测试连接` 新增了 `system_config.gitlab` 的 DB 存储 + admin UI 测试连接，但**只改了 4 处代码用 `getConfig`**，没迁 env 读取的老代码（5 处）。结果：

- `.env` 有配置时，env 路径能工作
- 只在 admin UI 改 DB 时，DB 路径能工作
- 两边都需要填，才能保证所有代码路径正常

2026-04-20 用户指示："韩凤锋提交的代码如果 DB 有配置项，都要求使用 DB；DB 没有才使用 env；严益昌提交的代码不管"。本 plan 按此收敛。

**硬约束**：`src/pipeline/executor.ts`（严益昌原创 6 文件之一，executor.ts:29 直读 `process.env.GITLAB_URL`）零改动。

---

## File Structure

**Create:**
- `src/config/gitlab.ts` —— 封装 `resolveGitlabConfig()`
- `src/__tests__/unit/resolve-gitlab-config.test.ts` —— 单测覆盖 DB hit / DB miss fallback env / 全空 3 分支

**Modify（韩凤锋代码，共 8 文件）：**
- 读 env 的 4 处 → 改调封装：
  - `src/agent/tools/create-mr.ts:28-29`
  - `src/agent/tools/review-mr-diff.ts:21-22`
  - `src/agent/tools/create-issue.ts:28-29`
  - `src/agent/analysis/gitlab-issue.ts:31-35` (`getGitlabEnv` 函数重写或整体替换)
- 读 DB 的 4 处 → 改调封装（享 env fallback）：
  - `src/agent/tools/get-gitlab-commits.ts:7-16` (`getGitLabConfig` 函数)
  - `src/agent/tools/env-status/gitlab.ts:17-27` (`gitlabConfig` 函数)
  - `src/agent/tools/deploy.ts:76-85` (`getGitLabConfig` 函数)
  - `src/admin/routes/system-config.ts:111-120` (test-gitlab-connection 端点)

**NOT Modified（严益昌原创硬约束）：**
- `src/pipeline/executor.ts:29` —— `const gitlabUrl = process.env.GITLAB_URL ?? ''` 保持原样

**Docs（可选）：**
- spec 在 design doc 或 CLAUDE.md 加一段 "GitLab 配置读取约定"

---

## 新封装签名

```typescript
// src/config/gitlab.ts
import { getConfig } from '../db/repositories/system-config.js'

export interface GitlabConfig {
  url: string
  token: string
  skipTlsVerify: boolean
}

/**
 * 解析 GitLab 配置（DB 优先，env fallback）
 *
 * 读取顺序：
 * 1. `system_config.gitlab` 中的 `{ url, token, skipTlsVerify }`
 * 2. 若 url 或 token 任一为空，回退读 `process.env.GITLAB_URL` / `GITLAB_TOKEN` / `GITLAB_SKIP_TLS_VERIFY`
 * 3. 全部为空则返回 `{ url: '', token: '', skipTlsVerify: false }`（调用方自行判断并报错）
 *
 * skipTlsVerify 取值规则：DB 里存的是 string 或 boolean；env 里是 `"true"` 或 `"1"` 才算 true。
 *
 * @returns 统一 shape 的配置
 */
export async function resolveGitlabConfig(): Promise<GitlabConfig> {
  const cfg = await getConfig('gitlab')
  const v = (cfg?.value ?? {}) as Record<string, unknown>

  const dbUrl = typeof v.url === 'string' ? v.url : ''
  const dbToken = typeof v.token === 'string' ? v.token : ''

  if (dbUrl && dbToken) {
    return {
      url: dbUrl,
      token: dbToken,
      skipTlsVerify: v.skipTlsVerify === 'true' || v.skipTlsVerify === true,
    }
  }

  // env fallback
  const envUrl = process.env.GITLAB_URL ?? ''
  const envToken = process.env.GITLAB_TOKEN ?? ''
  const envSkip = process.env.GITLAB_SKIP_TLS_VERIFY
  return {
    url: envUrl,
    token: envToken,
    skipTlsVerify: envSkip === 'true' || envSkip === '1',
  }
}
```

---

## Tasks

### Task 1: 新建封装 + 单测

**Files:**
- Create: `src/config/gitlab.ts`
- Create: `src/__tests__/unit/resolve-gitlab-config.test.ts`

**TDD Steps:**

- [ ] **Step 1: 写失败单测**

单测覆盖 5 个 case（使用 `vi.mock` 掉 `getConfig`）：
1. DB 有完整 `{url, token, skipTlsVerify:true}` → 返回 DB 值
2. DB 有 `{url, token}` 但无 `skipTlsVerify` → `skipTlsVerify=false`
3. DB 为空 + env 有 `GITLAB_URL/TOKEN` → 返回 env 值
4. DB 为空 + env 有 `GITLAB_SKIP_TLS_VERIFY=true` → `skipTlsVerify=true`
5. DB 和 env 都空 → 返回 `{url:'', token:'', skipTlsVerify:false}`（不抛异常）

- [ ] **Step 2: 跑测试验证失败**

```bash
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test src/__tests__/unit/resolve-gitlab-config.test.ts
```

Expected: 5 fail（`resolveGitlabConfig` 不存在）

- [ ] **Step 3: 实现封装**

按上面"新封装签名"小节创建 `src/config/gitlab.ts`。

- [ ] **Step 4: 测试通过**

全仓回归：
```bash
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test
```

Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/config/gitlab.ts src/__tests__/unit/resolve-gitlab-config.test.ts
git commit -m "feat(config): resolveGitlabConfig 封装 DB 优先 env fallback"
```

---

### Task 2: 替换 4 处直读 env 的调用点

**Files:**
- Modify: `src/agent/tools/create-mr.ts`
- Modify: `src/agent/tools/review-mr-diff.ts`
- Modify: `src/agent/tools/create-issue.ts`
- Modify: `src/agent/analysis/gitlab-issue.ts`

**Pattern（每处都类似）：**

旧：
```typescript
const gitlabUrl = process.env.GITLAB_URL
const gitlabToken = process.env.GITLAB_TOKEN
if (!gitlabUrl || !gitlabToken) {
  return { success: false, output: '缺少 GITLAB_URL 或 GITLAB_TOKEN 环境变量' }
}
```

新：
```typescript
import { resolveGitlabConfig } from '../../config/gitlab.js'

const { url: gitlabUrl, token: gitlabToken } = await resolveGitlabConfig()
if (!gitlabUrl || !gitlabToken) {
  return { success: false, output: '缺少 GitLab 配置（请在 admin UI 或 .env 中设置 URL 和 Token）' }
}
```

**注意点：**
- 4 个文件的 import 路径略有差异（`create-issue.ts` / `create-mr.ts` / `review-mr-diff.ts` 在 `src/agent/tools/` 下，import 路径 `../../config/gitlab.js`；`analysis/gitlab-issue.ts` 在 `src/agent/analysis/` 下也是 `../../config/gitlab.js`）
- `analysis/gitlab-issue.ts` 有 `getGitlabEnv()` 函数（同步）需要改为 async（函数签名变化），连带调用方可能需要 `await`
- 错误消息文案统一改为"请在 admin UI 或 .env 中设置"，让用户知道有两种方式

**Steps:**
- [ ] 1. 逐个文件改（`create-mr.ts` → `review-mr-diff.ts` → `create-issue.ts` → `analysis/gitlab-issue.ts`）
- [ ] 2. 跑 `pnpm typecheck`，0 error
- [ ] 3. 跑该文件相关的已有单测（`grep -rn "create-mr\|review-mr-diff\|create-issue\|gitlab-issue" src/__tests__/ --include="*.ts"` 找出测试）
- [ ] 4. 全仓回归 `pnpm test` 全绿
- [ ] 5. Commit: `refactor(agent): 4 处 GitLab env 直读改调 resolveGitlabConfig`

---

### Task 3: 替换 4 处已读 DB 但无 fallback 的调用点

**Files:**
- Modify: `src/agent/tools/get-gitlab-commits.ts`
- Modify: `src/agent/tools/env-status/gitlab.ts`
- Modify: `src/agent/tools/deploy.ts`
- Modify: `src/admin/routes/system-config.ts`（test-gitlab-connection 端点）

**Pattern：**

旧：
```typescript
async function getGitLabConfig() {
  const cfg = await getConfig('gitlab')
  if (!cfg) return { url: '', token: '', skipTlsVerify: false }
  const v = cfg.value as Record<string, string>
  return {
    url: v.url ?? '',
    token: v.token ?? '',
    skipTlsVerify: v.skipTlsVerify === 'true',
  }
}
```

新：直接调 `resolveGitlabConfig()`（删除本地 `getGitLabConfig` / `gitlabConfig` 函数，或改为调用封装）。

**注意点：**
- 本地函数删除后调用方要同步改名（e.g. `await getGitLabConfig()` → `await resolveGitlabConfig()`）
- 保留本地函数作为"转发给封装"的 shim 也可以，但更清爽是直接删掉
- `env-status/gitlab.ts` 的 `gitlabConfig()` 返回值还包含 `agent?: https.Agent` 字段，不在封装范围内，需要在调用点根据 `skipTlsVerify` 自行构造 `https.Agent({ rejectUnauthorized: false })`

**Steps:**
- [ ] 1. 逐个文件改
- [ ] 2. typecheck / 单测 / 回归
- [ ] 3. Commit: `refactor(agent): 4 处 GitLab 裸 getConfig 改调 resolveGitlabConfig（享 env fallback）`

---

### Task 4: 回归 + 文档记录

- [ ] **Step 1: 全仓最终回归**

```bash
pnpm typecheck
cd web && pnpm typecheck && cd ..
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test
```

Expected: 全绿

- [ ] **Step 2: 手工验收**

在本地 `.env` 保留 `GITLAB_URL/TOKEN`，**不往 DB 写 gitlab 配置**：
- 触发一次 bug 分析流程 → 读 env 成功（证明 fallback 有效）

然后往 DB 写 `system_config.gitlab` 带另一个 URL：
- 再触发一次 → 读 DB 新值（证明 DB 优先）

- [ ] **Step 3: 给 CLAUDE.md（或 spec）加一段约定**

在 `CLAUDE.md` 的 "Key Patterns" 节下或 `docs/superpowers/specs/` 建一个短 spec，记录：

```markdown
### GitLab 配置读取约定（2026-04-20 refactor）

所有韩凤锋提交的代码访问 GitLab 必须调 `resolveGitlabConfig()`（`src/config/gitlab.ts`），**不再直接 `process.env.GITLAB_*` 或裸调 `getConfig('gitlab')`**。

读取顺序：DB `system_config.gitlab` 优先，缺 url/token 时回退 env。

**例外**：严益昌原创 `src/pipeline/executor.ts:29` 保持原样（6 文件零改动约束）。
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: GitLab 配置读取约定补齐（resolveGitlabConfig 强制入口）"
```

---

## 实施顺序总结

```
Task 1 (新封装 + 单测)
  ↓
Task 2 (4 处 env 直读迁 DB+fallback)
  ↓
Task 3 (4 处 DB 裸调迁统一封装)
  ↓
Task 4 (回归 + 文档 + 手工验证 DB/env 两条路径)
```

---

## 边界 & 注意事项

- **不改 `executor.ts`**（严益昌硬约束）
- **不新加 schema**（`system_config` 表结构不变）
- **不加 bootstrap**（DB 空不会自动从 env 写入 DB，每次调用都走 DB 优先 env fallback 的决策）
- **向后兼容**：若现有部署只配 env，refactor 后行为完全不变（DB 空 → fallback env）
- **向前兼容**：admin UI 改 DB 立即生效，下一次 `resolveGitlabConfig()` 调用就取新值

## Growth Backlog（本次不做）

- 把其它（Harbor / Claude / 钉钉 / 飞书）配置也统一到"DB 优先 env fallback"模式
- Admin UI 显示"当前生效配置来自 DB 还是 env"指示
- 配置 hot reload（本次每次调用都从 DB 读，天然 hot reload，已满足）
