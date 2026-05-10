# 测试约定

> 来源：[CLAUDE.md](../../CLAUDE.md) "测试基础设施"
> 消费 role：plan-decomposer / dev-loop / code-quality-reviewer

## 必须（MUST）

### canonical 入口

`./test.sh` 是测试 canonical 入口（200s+ 单次跑完落盘到 `logs/`）：

```bash
./test.sh                              # 全套（vitest run）
./test.sh --filter <pattern>           # 透传 vitest，跑匹配文件
./test.sh --typecheck                  # 仅 tsc --noEmit（前后端）
```

### 单测文件位置

- 不依赖 DB 的纯单测：`src/__tests__/unit/*.test.ts`
- 依赖 DB 的集成测试：`src/__tests__/integration/*.test.ts`
- E2E：`src/__tests__/e2e/*.test.ts`

### DB fixture 使用

使用 `resetTestDb()`（[src/__tests__/helpers/db.ts](../../src/__tests__/helpers/db.ts)），它通过 marker 表 `chatops_test_db_marker` 校验当前库是测试库后才 `DROP SCHEMA public CASCADE`。

### 跑受影响测试（dev-loop）

```bash
# 优先用 vitest --related，自动追踪 import 关系
pnpm exec vitest --related --run <changed-file>

# fallback：按文件名匹配
# src/foo.ts → src/__tests__/**/foo*.test.ts
```

### plan-decomposer 强制配测试任务

每个 `type='feature'` 任务必须配 ≥1 个 `type='test'` 任务，`coverAC` 字段引用同样的 AC。

## 不得（MUST NOT）

- **不得**测试中 hardcode 测试库 URL（用 `process.env.DATABASE_URL`）
- **不得**绕过 `resetTestDb()` 直接 `DROP SCHEMA`（marker 防误删业务库）
- **不得**测试中调外部网络（除非有 mock）
- **不得**plan 中只有 feature 任务没有 test 任务

## 检查方式（HOW TO VERIFY）

```bash
# 1. 找新增的测试文件
NEW_TESTS=$(git -C {worktree_path} diff origin/main..HEAD --name-only --diff-filter=A | grep "\.test\.ts$")

# 2. 检查测试文件是否走标准 fixture
for f in $NEW_TESTS; do
  if grep -E "new (Pool|Client)\(" "$f" && ! grep "resetTestDb" "$f"; then
    echo "WARN: $f 直接建 pg 连接但没用 resetTestDb"
  fi
done

# 3. plan-decomposer 输出校验
TYPE_FEATURE=$(jq -r '.tasks[] | select(.type == "feature") | .id' planOutput.json)
TYPE_TEST=$(jq -r '.tasks[] | select(.type == "test") | .id' planOutput.json)
# 每个 feature 必须有 ≥1 个 test 任务的 dependsOn 包含它
```

reviewer 输出 JSON 中：
- 测试不走标准 fixture → warn
- plan 中 feature 任务无对应 test 任务 → error
- 通过 → `evidence.selfCheck` 加 `{item: "测试约定（fixture / 配对）", passed: true}`
