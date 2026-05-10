# 代码风格约定

> 来源：综合 [CLAUDE.md](../../CLAUDE.md) "Tech Stack" + 项目规范
> 消费 role：dev-loop / code-quality-reviewer

## 必须（MUST）

### TypeScript

- TypeScript strict mode；`pnpm exec tsc --noEmit` 必须通过
- ES2022 + NodeNext modules
- import 路径用 `.js` 后缀（NodeNext 要求），即使源文件是 `.ts`：
  ```typescript
  import { foo } from './foo.js'  // ✓ 即使 foo.ts
  ```

### 错误处理边界

- 错误处理仅在系统边界：
  - 用户输入（HTTP / IM 消息 / CLI 参数）
  - 外部 API（GitLab / Anthropic / DB）
- 内部代码信任 framework 提供的不变量
- 不要用 try/catch 包整段函数把所有错误吞掉

### 命名一致性

- 起名前先 `grep` 类似实现，对齐既有模式
- snake_case：DB 字段 / SQL
- camelCase：TypeScript 变量 / 函数
- PascalCase：TypeScript 类 / 类型 / React 组件

### React

- 函数组件 + hooks（不写 class component）
- antd 5 + Vite 体系
- 组件级 state（无全局状态管理）
- API 层在 `web/src/api/` 用 axios

## 不得（MUST NOT）

### 注释

- **默认不写注释**。只在 WHY 非显然时加：
  - 隐藏约束（`// 必须先 acquireLock 否则 race condition`）
  - 不变量（`// 此时 stage_results[i] 必非空`）
  - workaround（`// 绕过 X 的已知 bug，详见 issue #123`）
  - 反直觉行为（`// 故意不 await，让它在后台跑`）

- **不得写**这些注释：
  - 解释 WHAT（well-named identifier 已经做了这件事）
  - "used by X" / "added for Y" / "fix issue #123"（这些属 PR description / git log）
  - 多行 docstring（除非是公开 API 的 JSDoc）

### 防御性编程

- **不得**为不可能发生的场景加 try/catch / fallback / 验证
- **不得**对 framework guarantee 的内部代码做参数校验
- **不得**写 feature flag / backwards-compat shim（除非有明确理由）

### 依赖

- **不得**未授权新增 npm dependency（plan 中没列的不能加）
- **不得**引入与现有模式冲突的库（如已有 axios 不要再装 fetch wrapper）

## 检查方式（HOW TO VERIFY）

```bash
# 1. typecheck
pnpm exec tsc --noEmit
# 退出码非 0 → error

# 2. 注释检查（启发式）
git -C {worktree_path} diff origin/main..HEAD --unified=0 | \
  grep -E "^\+.*\/\/ (used by|added for|fix.*#[0-9]+)" && \
  echo "WARN: 注释含 used by / added for / fix #X 等不应留的引用"

# 3. 新增依赖检查
git diff origin/main..HEAD -- package.json | grep "^+\s*\"" | grep -v "^+\s*\"version\""
```

reviewer 输出 JSON 中：
- tsc 失败 → error
- 注释违规 → warn
- 新增依赖未在 plan 中 → error
- 通过 → `evidence.selfCheck` 加 `{item: "代码风格（tsc / 注释 / 依赖）", passed: true}`
