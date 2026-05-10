# DB Repository 模式约定

> 来源：[CLAUDE.md](../../CLAUDE.md) "DB Repository 约定"
> 消费 role：dev-loop / code-quality-reviewer

## 必须（MUST）

新建 / 修改 `src/db/repositories/*.ts` 时：

1. **直接写参数化 SQL**：使用 `$1, $2, ...` 占位符，无 ORM
   ```typescript
   const { rows } = await pool.query(
     'SELECT * FROM users WHERE id = $1 AND status = $2',
     [userId, 'active']
   )
   ```

2. **camelCase ↔ snake_case 转换**：
   - 数据库字段 snake_case（`created_at` / `pipeline_run_id`）
   - TypeScript camelCase（`createdAt` / `pipelineRunId`）
   - 用 `mapRow()` 函数做转换，不要直接 `return query.rows[0]`

3. **mapRow 函数签名**：
   ```typescript
   function mapRow(row: Record<string, unknown>): SomeDto {
     return {
       id: row.id as number,
       createdAt: row.created_at as Date,
       pipelineRunId: row.pipeline_run_id as number,
       // ...
     }
   }
   ```

## 不得（MUST NOT）

- **不得**字符串拼接 SQL（SQL 注入风险）：
  ```typescript
  // ✗ 错误
  await pool.query(`SELECT * FROM users WHERE id = ${userId}`)
  ```
- **不得**省略 mapRow 直接返回 raw row
- **不得**在 repository 文件里写业务逻辑（only data access）
- **不得**让 repository 函数抛业务异常（应返回 null / 空数组让上层处理）

## 检查方式（HOW TO VERIFY）

```bash
# 1. 找新增 / 修改的 repo 文件
REPOS=$(git -C {worktree_path} diff origin/main..HEAD --name-only | grep "^src/db/repositories/.*\.ts$")

for f in $REPOS; do
  # 2. 检查字符串拼接 SQL（启发式：含 `${` 的 SQL 字符串）
  if grep -E '`[^`]*\$\{[^}]+\}[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b' "$f"; then
    echo "ERROR: $f 疑似字符串拼接 SQL"
  fi

  # 3. 检查 mapRow 存在
  if grep -E "(SELECT.*FROM|INSERT INTO|UPDATE)" "$f" >/dev/null && \
     ! grep -E "(function|const) mapRow" "$f" >/dev/null; then
    echo "WARN: $f 含 SQL 但没 mapRow 函数"
  fi
done
```

reviewer 输出 JSON 中：
- 字符串拼接 SQL → error
- 缺 mapRow → warn（除非该 repo 仅做 INSERT 不 SELECT）
- 通过 → `evidence.selfCheck` 加 `{item: "Repository 模式（参数化 + mapRow）", passed: true}`
