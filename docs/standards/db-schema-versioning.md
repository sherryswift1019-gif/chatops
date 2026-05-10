# DB Schema 编号顺序约定

> 来源：[CLAUDE.md](../../CLAUDE.md) "Schema 编号顺序（2026-04-28）" + "DB Repository 约定"
> 消费 role：plan-decomposer / dev-loop / code-quality-reviewer

## 必须（MUST）

新建 `src/db/schema-vN.sql` 时：

1. **版本号必须早于所有引用其表/列的 schema 文件**
   - 例：`pipeline_node_types` 表的 CREATE 在 v27 → v34/v35/v36/v44 才能 INSERT/UPDATE 它

2. **DDL 必须幂等**
   - 用 `CREATE TABLE IF NOT EXISTS`
   - 用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   - 用 `CREATE INDEX IF NOT EXISTS`

3. **同步两份 SCHEMA_FILES 列表**：
   - [src/db/migrate.ts](../../src/db/migrate.ts) — 生产 / 部署 / 本地 dev 用
   - [src/__tests__/helpers/db.ts](../../src/__tests__/helpers/db.ts) — `resetTestDb()` 用，**故意排除 v21..v28 大部分**避免 seed 数据污染 fixture

4. **plan-decomposer 拆 migration 任务**：涉及 schema 变更必须有 `type='migration'` 任务，`migrations[]` 字段标记新 schema 文件号

## 不得（MUST NOT）

- **不得**版本号撞车（同号不同内容）。合并 main 时若撞车，**优先让出占用历史 squash 空号**（如 v27 / 未来其它空号）而非简单往尾追加
- **不得**忘记同步任一 SCHEMA_FILES 列表（两份都要更新）
- **不得**引用未在前序 schema 创建的表/列
- **不得**写不可逆的 `DROP COLUMN` 不加 IF EXISTS

## 检查方式（HOW TO VERIFY）

```bash
# 1. 找新增的 schema 文件
NEW_SCHEMAS=$(git -C {worktree_path} diff origin/main..HEAD --name-only --diff-filter=A | grep "^src/db/schema-v.*\.sql$")

# 2. 对每个新文件，检查两份 SCHEMA_FILES 都加了
for f in $NEW_SCHEMAS; do
  basename=$(basename "$f")
  in_migrate=$(grep -c "${basename}" src/db/migrate.ts)
  in_helper=$(grep -c "${basename}" src/__tests__/helpers/db.ts)
  if [ "$in_migrate" -lt 1 ]; then
    echo "ERROR: $f 未在 src/db/migrate.ts SCHEMA_FILES 注册"
  fi
  # helper 可能故意排除（v21..v28 等），不强制；只 warn
  if [ "$in_helper" -lt 1 ]; then
    echo "WARN: $f 未在 src/__tests__/helpers/db.ts 注册（如属故意排除请说明）"
  fi
done

# 3. 检查 DDL 幂等
for f in $NEW_SCHEMAS; do
  if grep -q "CREATE TABLE \w" "$f" && ! grep -q "CREATE TABLE IF NOT EXISTS" "$f"; then
    echo "ERROR: $f CREATE TABLE 缺 IF NOT EXISTS"
  fi
done
```

reviewer 输出 JSON 中：
- 缺 SCHEMA_FILES 注册 → error
- DDL 不幂等 → error
- 通过 → `evidence.selfCheck` 加 `{item: "Schema 编号 + 双同步 + 幂等", passed: true}`
