# Spec 03: docs/standards/ 内容大纲

> 主 PRD：[prd-quick-impl-roles-v2.md](../prd-quick-impl-roles-v2.md)
> 关联：[02-data-flow.md](02-data-flow.md)（symlink 机制）· [01-roles.md](01-roles.md)（消费 standards 的 role）

本文定义 `docs/standards/` 8 篇文件的预期内容与编写约定。所有内容**从 [CLAUDE.md](../../../CLAUDE.md) 抽取**，保持单一来源；CLAUDE.md 后续重构为摘要 + link（见 §3）。

实现 Phase 1 写 standards 文件时按本文 outline 落地。

---

## 1. 编写约定（所有 standards 文件）

### 1.1 文件结构（三段式）

每篇 standards 必须按这个结构：

```markdown
# {标准名}

## 必须（MUST）
- 必须遵守的规则，违反 = error

## 不得（MUST NOT）
- 禁止的模式，违反 = error

## 检查方式（HOW TO VERIFY）
- 具体 grep 命令 / 文件路径 / 校验工具
- reviewer 能直接复用执行
```

### 1.2 长度约束

- 每篇 ≤ 100 行
- 没有冗余背景（背景已在 CLAUDE.md / 关联 issue / 关联 commit）
- 例子简短，1-2 行代码足够

### 1.3 链接到代码锚点

约定来源处的代码 / 配置必须给 file:line 链接：

```markdown
**例外**：[src/pipeline/executor.ts:29](../../src/pipeline/executor.ts#L29) 保持 `process.env.GITLAB_URL` 不动
```

---

## 2. 8 篇 standards 内容大纲

### 2.1 gitlab-config.md

**内容**（来自 CLAUDE.md "GitLab 配置读取约定"）：

- **必须**：调 [resolveGitlabConfig()](../../src/config/gitlab.ts) 读 GitLab 配置（url / token / skipTlsVerify）
- **不得**：直接 `process.env.GITLAB_URL` / `GITLAB_TOKEN` / `GITLAB_SKIP_TLS_VERIFY`；不得裸调 `getConfig('gitlab')`
- **例外**：[src/pipeline/executor.ts:29](../../src/pipeline/executor.ts#L29) 严益昌原创代码保持现状（6 文件零改动硬约束）
- **检查方式**：`git diff origin/main..HEAD | grep -E "process\.env\.GITLAB_(URL|TOKEN|SKIP_TLS_VERIFY)"`，命中即 error（除 executor.ts:29 外）

### 2.2 tool-registration.md

**内容**（来自 CLAUDE.md "Tool 自注册"）：

- **必须**（新增 MCP 工具时）：
  1. 在 `src/agent/tools/` 创建文件，实现 `AgentTool` 接口并调 `registerTool()`
  2. 在 `src/server.ts` 添加 `import './tools/<name>.js'`
  3. 在 `src/agent/mcp-server.ts` 添加同样的 import
  4. 如需 RBAC 默认角色，在 `src/agent/tools/types.ts` 的 `DEFAULT_TOOL_ROLES` 添加
- **不得**：只加 1 处 import 漏另一处（registry 不一致 → 工具消失）
- **检查方式**：
  - 如果 `git diff --name-only` 含新增 `src/agent/tools/*.ts`，grep `src/server.ts` 和 `src/agent/mcp-server.ts` 确认 import 都加了

### 2.3 db-schema-versioning.md

**内容**（来自 CLAUDE.md "Schema 编号顺序" + "DB Repository 约定"中 schema 部分）：

- **必须**：
  - 新建 `src/db/schema-vN.sql`，N 必须早于所有引用其表/列的 schema 文件
  - 用 `IF NOT EXISTS` / `ALTER TABLE IF` 保证幂等
  - 同步两份 SCHEMA_FILES 列表：[src/db/migrate.ts](../../src/db/migrate.ts) + [src/__tests__/helpers/db.ts](../../src/__tests__/helpers/db.ts)
- **不得**：版本号撞车（同号不同内容）；忘记同步任一 SCHEMA_FILES
- **检查方式**：
  - `ls src/db/schema-v*.sql | sort -V | tail -3` 看最近 3 个版本号
  - 新文件不在 SCHEMA_FILES 双列表 → error
  - 引用未在前序 schema 创建的表 → error

### 2.4 repository-pattern.md

**内容**（来自 CLAUDE.md "DB Repository 约定"）：

- **必须**：
  - 直接写参数化 SQL（`$1, $2...`），无 ORM
  - 数据库字段 snake_case，TypeScript camelCase
  - Repository 中 `mapRow()` 函数做转换
- **不得**：字符串拼接 SQL（SQL 注入风险）；省略 mapRow 直接返回 raw row
- **检查方式**：
  - 新增 `src/db/repositories/*.ts` 中 grep 字符串拼接（如 ``${...}`` 在 SQL 字符串中）→ error
  - grep 没有 mapRow 函数 / 直接 return query.rows[0] → warn

### 2.5 frontend-enum-select.md

**内容**（来自 CLAUDE.md "前端表单：枚举字段下拉规范"）：

- **必须**（使用枚举 = 引用已有记录时）：
  - 用 `<Select>` 而非 `<Input>`
  - 数据源从对应 admin API 拉
  - 通配（如 `*`）作为列表首项 + 显式 Tag 标记
  - Stale 兼容：值不在当前列表时显示 warning icon + `（不在列表中）`
- **不得**（在使用枚举场景）：用 Input 让用户手填
- **必须**（定义枚举 = 创建新记录时）：保持 Input
- **检查方式**：
  - 新增 `web/src/**/*.tsx` 中 grep `<Input>`，结合上下文判断是否枚举字段
  - 如属枚举 → error；如属定义 / 自由文本 → 跳过

### 2.6 commit-conventions.md

**内容**（来自本 PRD §3.2.3 dev-loop commit 策略 + 现有 git log 风格）：

- **必须**：
  - dev-loop 按任务 commit，不一次性大 commit
  - commit message 格式：`feat(qi-{requirement_id}): T{n} {任务标题}`
  - round 2+ 修订用 `fix(qi-{requirement_id}): T{n} 修订 — {反馈摘要}`
  - 不 push（quick-impl 由 mr_create 节点统一推）
- **不得**：
  - 一次性大 commit（含多个任务）
  - rebase / amend 已 commit 的任务（用追加 fix 代替）
  - 跳过 hooks（`--no-verify`）
- **检查方式**：
  - reviewer 收到的 dev-loop 输出 `commits[]` 长度 ≥ 任务数（除 skipped）
  - commit message 不符合格式 → warn

### 2.7 test-conventions.md

**内容**（来自 CLAUDE.md "测试基础设施"）：

- **必须**：
  - canonical 入口：`./test.sh`（自动启 testcontainer postgres + tee logs）
  - 不依赖 DB 的纯单测可绕开 setup（不 import db client）
  - 新增测试用 `*.test.ts` 命名，放 `src/__tests__/{unit,integration,e2e}/`
  - 数据库 fixture 用 `resetTestDb()`，校验 marker 表
- **不得**：
  - 测试中 hardcode 测试库 URL
  - 未通过 `resetTestDb()` 直接 `DROP SCHEMA`（marker 表防误删业务库）
  - 测试中调外部网络（除非有 mock）
- **检查方式**：
  - 新增 `src/__tests__/**/*.test.ts` grep `pg.Client` / `Pool` → 检查是否走标准 fixture
  - vitest 命令优先 `pnpm exec vitest --related --run <file>` 而非全跑

### 2.8 code-style.md

**内容**（综合 CLAUDE.md "Tech Stack" + 项目规范）：

- **必须**：
  - TypeScript strict mode 通过 tsc --noEmit
  - 错误处理仅在系统边界（用户输入 / 外部 API），内部代码信任 framework guarantees
  - 命名一致性：先 grep 类似实现再起名，不创造新模式
- **不得**：
  - 默认写注释（除非 WHY 非显然：隐藏约束 / 不变量 / workaround / 反直觉行为）
  - 写"used by X" / "added for Y" / "fix issue #123" 这类引用代码 / PR 的注释
  - 解释 WHAT（well-named identifier 已经做了这件事）
  - feature flag / backwards-compat shim（除非有明确理由）
- **检查方式**：
  - tsc 通过 = 必要条件
  - reviewer 看 git diff 中新增的 // 注释，逐条评估是否符合 WHY 规则

---

## 3. CLAUDE.md 同步策略（Phase 5）

为避免 CLAUDE.md 与 docs/standards/ 双写漂移，重构为摘要 + link 模式：

### 重构前（当前 CLAUDE.md）

```markdown
### GitLab 配置读取约定（2026-04-20）

所有访问 GitLab 的代码必须调 `resolveGitlabConfig()`...
（30 行详细规则）
```

### 重构后

```markdown
### GitLab 配置读取约定

→ 详见 [docs/standards/gitlab-config.md](docs/standards/gitlab-config.md)

**摘要**：所有访问 GitLab 的代码调 `resolveGitlabConfig()`，不要直接读 env vars。例外：`src/pipeline/executor.ts:29`。
```

### 漂移检查 lint（Phase 5）

`scripts/qi-standards-lint.ts`：
- 扫 CLAUDE.md 找 `→ 详见 docs/standards/` 链接
- 校验链接对应文件存在
- 校验 CLAUDE.md 摘要里提到的关键词（如 `resolveGitlabConfig`）在对应 standards 文件里都出现过（防摘要错位）
- CI per-PR 跑

---

## 4. 跨 skill 复用的 namespace（暂不解决）

当前 `docs/standards/` 是项目级，仅 quick-impl 用。后续如其他 skill 也用，可能：
- 同名文件冲突（不同 skill 对"commit-conventions"理解不同）
- 谁拥有目录归属权不明

**当前不解决**。如真有第二个 skill 要用，再讨论 namespace 方案（如 `docs/standards/<skill-name>/`）。
