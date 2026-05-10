# Commit 约定

> 来源：[01-roles.md](../prds/quick-impl-roles-v2/01-roles.md) §3 dev-loop commit 策略 + 现有 git log 风格
> 消费 role：dev-loop / code-quality-reviewer

## 必须（MUST）

### dev-loop 按任务 commit

每个任务一个 commit，**不一次性大 commit**。

### Commit message 格式

**Round 1（feature 实现）**：
```
feat(qi-{requirement_id}): T{n} {任务标题}
```

例：
```
feat(qi-7): T1 添加 LoginPage Checkbox 组件
feat(qi-7): T2 实现 localStorage 读写逻辑
```

**Round 2+（按 reviewer 反馈修订）**：
```
fix(qi-{requirement_id}): T{n} 修订 — {反馈摘要}
```

例：
```
fix(qi-7): T2 修订 — 处理 localStorage 配额溢出
```

### 不 push（quick-impl 流程）

dev-loop 只 commit，**不 push**。push 由 mr_create 节点统一做。

### git add 显式列文件

虽然 `.qi-context/` 已加入 worktree gitignore，仍**显式 `git add <file1> <file2>`** 而非 `git add -A`，避免误带其他改动。

### 文档类 commit（spec-author / plan-decomposer / 未来 e2e_runner）

产出文档的 role **自己**调 `commit_artifact` MCP 工具落 commit（不交给 dev-loop / mr_create 兜底）。

**Commit message 格式**：
```
docs(qi-{requirement_id}): {kind} round {N}
```

- `kind` ∈ `{spec, plan, test-spec}`
- `N` 从 1 起；spec 多轮审批每轮递增；plan 通常 N=1，acDiff 触发重跑时递增
- N 推导规则：无 `inputs.previousRound` → N=1；有 → N = `previousRound.round` + 1

例：
```
docs(qi-7): spec round 1
docs(qi-7): spec round 2
docs(qi-7): plan round 1
```

**约束**：
- 一个 commit 只动一个 docs 文件（`commit_artifact` 是单文件提交）
- 文档 commit 不夹带源码改动；同理代码 commit 也不夹带 docs 改动
- 多轮迭代每轮都 commit；内容完全没变时 commit_artifact 会报 "no changes to commit"，role 应跳过并 notes warn

## 不得（MUST NOT）

- **不得**一次性大 commit（含多个任务）
- **不得**rebase / amend / `git commit --amend` 已 commit 的任务（用追加 fix commit 代替）
- **不得**跳过 hooks（`--no-verify` / `--no-gpg-sign`），除非用户显式要求
- **不得**force push（`-f`）
- **不得**改 commit 历史

## 检查方式（HOW TO VERIFY）

```bash
# 1. 查看本分支自 base 以来的 commits
git -C {worktree_path} log --oneline origin/main..HEAD

# 2. 校验：dev-loop 输出的 commits[] 数量 ≥ 任务数（除 skipped）
COMMIT_COUNT=$(git log --oneline origin/main..HEAD | wc -l)
TASK_COUNT={planTasks.length - skippedTasks.length}
if [ "$COMMIT_COUNT" -lt "$TASK_COUNT" ]; then
  echo "ERROR: commit 数 ($COMMIT_COUNT) < 任务数 ($TASK_COUNT)，可能合并了多个任务"
fi

# 3. 校验 commit message 格式
git log origin/main..HEAD --pretty='%s' | grep -vE "^(feat|fix)\(qi-[0-9]+\): T[0-9]+|^docs\(qi-[0-9]+\):" && \
  echo "WARN: 有 commit message 不符合 feat(qi-X): T{n} / docs(qi-X): {kind} 格式"
```

reviewer 输出 JSON 中：
- commit 数 < 任务数（怀疑合并）→ error
- message 格式错 → warn
- 通过 → `evidence.selfCheck` 加 `{item: "按任务 commit + message 格式", passed: true}`
