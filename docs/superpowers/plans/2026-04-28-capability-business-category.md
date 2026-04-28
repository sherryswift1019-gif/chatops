# 能力业务分类 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `capabilities` 表新增可空 `category` 字段（`feature_dev`/`bug_fix`/`ops`/`info_query`），并在管理后台提供筛选和编辑入口。

**Architecture:** 新增 schema-v48.sql 做 `ALTER TABLE`；后端 repository + admin 路由透传该字段；前端在能力列表表格里新增「业务分类」列与顶部筛选下拉，在创建/编辑 Modal 里新增 Select 字段。

**Tech Stack:** PostgreSQL 16, Fastify 5, TypeScript strict, React 18, Ant Design 5

---

## 文件清单

| 文件 | 操作 |
|---|---|
| `src/db/schema-v48.sql` | 新增 |
| `src/db/migrate.ts` | 追加一行 |
| `src/__tests__/helpers/db.ts` | 追加一行 |
| `src/db/repositories/capabilities.ts` | 扩展 interface + mapRow + create/update |
| `src/admin/routes/capabilities.ts` | POST body 加 category |
| `web/src/api/capabilities.ts` | Capability 类型加 category |
| `web/src/pages/CapabilitiesPage.tsx` | 列 + 筛选 + 表单字段 |

---

### Task 1: 数据库迁移文件

**Files:**
- Create: `src/db/schema-v48.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/__tests__/helpers/db.ts`

- [ ] **Step 1: 新建 schema-v48.sql**

创建文件 `src/db/schema-v48.sql`，内容：

```sql
-- v48: capabilities 新增业务分类字段
ALTER TABLE capabilities
  ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IN ('feature_dev', 'bug_fix', 'ops', 'info_query'));
```

- [ ] **Step 2: 在 migrate.ts SCHEMA_FILES 末尾追加**

找到 `src/db/migrate.ts` 中包含 `['v47', 'schema-v47.sql']` 的行，在其后追加：

```typescript
  ['v48', 'schema-v48.sql'],
```

- [ ] **Step 3: 在测试 helper 末尾追加**

找到 `src/__tests__/helpers/db.ts` 中包含 `'schema-v47.sql',` 的行，在其后追加：

```typescript
  // v48: capabilities 新增业务分类字段，纯 ALTER，无 seed 数据，安全加入。
  'schema-v48.sql',
```

- [ ] **Step 4: 验证 TypeScript 类型检查通过**

```bash
./test.sh --typecheck
```

预期：无报错。

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-v48.sql src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "feat(db): capabilities 新增业务分类字段 schema-v48"
```

---

### Task 2: 后端 Repository 扩展

**Files:**
- Modify: `src/db/repositories/capabilities.ts`

- [ ] **Step 1: 在 `Capability` interface 末尾新增 category 字段**

找到 `src/db/repositories/capabilities.ts` 中：

```typescript
  updatedAt: Date | null
  createdAt: Date
```

在 `updatedAt` 前插入：

```typescript
  category: string | null
```

最终该区域为：

```typescript
  category: string | null
  updatedAt: Date | null
  createdAt: Date
```

- [ ] **Step 2: 在 `mapRow` 函数末尾新增映射**

找到 `mapRow` 函数中：

```typescript
    requiresDeployLock: (r.requires_deploy_lock ?? false) as boolean,
    updatedAt: r.updated_at as Date | null,
```

在 `requiresDeployLock` 后、`updatedAt` 前插入：

```typescript
    category: (r.category ?? null) as string | null,
```

- [ ] **Step 3: 扩展 `createCapability` 函数**

将 `createCapability` 的参数类型从：

```typescript
export async function createCapability(
  data: Pick<Capability, 'key' | 'displayName' | 'description' | 'toolNames'>
): Promise<Capability> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO capabilities (key, display_name, description, tool_names)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.key, data.displayName, data.description ?? '', JSON.stringify(data.toolNames)]
  )
  return mapRow(rows[0])
}
```

改为：

```typescript
export async function createCapability(
  data: Pick<Capability, 'key' | 'displayName' | 'description' | 'toolNames'> & { category?: string | null }
): Promise<Capability> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO capabilities (key, display_name, description, tool_names, category)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [data.key, data.displayName, data.description ?? '', JSON.stringify(data.toolNames), data.category ?? null]
  )
  return mapRow(rows[0])
}
```

- [ ] **Step 4: 扩展 `updateCapability` 函数**

将 `updateCapability` 的参数类型从：

```typescript
export async function updateCapability(
  id: number,
  data: Partial<Pick<Capability, 'displayName' | 'description' | 'toolNames'>>
): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE capabilities SET
       display_name = COALESCE($2, display_name),
       description = COALESCE($3, description),
       tool_names = COALESCE($4, tool_names),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.displayName ?? null, data.description ?? null,
     data.toolNames ? JSON.stringify(data.toolNames) : null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

改为：

```typescript
export async function updateCapability(
  id: number,
  data: Partial<Pick<Capability, 'displayName' | 'description' | 'toolNames' | 'category'>>
): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE capabilities SET
       display_name = COALESCE($2, display_name),
       description = COALESCE($3, description),
       tool_names = COALESCE($4, tool_names),
       category = COALESCE($5, category),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.displayName ?? null, data.description ?? null,
     data.toolNames ? JSON.stringify(data.toolNames) : null,
     data.category ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 5: 验证 TypeScript 类型检查**

```bash
./test.sh --typecheck
```

预期：无报错。

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/capabilities.ts
git commit -m "feat(repo): capabilities repository 支持 category 字段"
```

---

### Task 3: Admin 路由扩展

**Files:**
- Modify: `src/admin/routes/capabilities.ts`

- [ ] **Step 1: POST /capabilities body 增加 category**

找到 `src/admin/routes/capabilities.ts` 中：

```typescript
  app.post<{ Body: { key: string; displayName: string; description?: string; toolNames?: string[] } }>(
    '/capabilities', async (req, reply) => {
      const { key, displayName, description, toolNames } = req.body
      if (!key || !displayName) return reply.status(400).send({ error: 'key and displayName required' })
      const item = await createCapability({
        key, displayName,
        description: description ?? '',
        toolNames: toolNames ?? [],
      })
```

改为：

```typescript
  app.post<{ Body: { key: string; displayName: string; description?: string; toolNames?: string[]; category?: string } }>(
    '/capabilities', async (req, reply) => {
      const { key, displayName, description, toolNames, category } = req.body
      if (!key || !displayName) return reply.status(400).send({ error: 'key and displayName required' })
      const item = await createCapability({
        key, displayName,
        description: description ?? '',
        toolNames: toolNames ?? [],
        category: category ?? null,
      })
```

- [ ] **Step 2: 验证 TypeScript 类型检查**

```bash
./test.sh --typecheck
```

预期：无报错。

- [ ] **Step 3: Commit**

```bash
git add src/admin/routes/capabilities.ts
git commit -m "feat(api): POST /capabilities 支持 category 字段"
```

---

### Task 4: 前端 API 类型扩展

**Files:**
- Modify: `web/src/api/capabilities.ts`

- [ ] **Step 1: Capability interface 新增 category**

找到 `web/src/api/capabilities.ts` 中：

```typescript
export interface Capability {
  id: number
  key: string
  displayName: string
  description: string
  toolNames: string[]
  systemPrompt: string | null
  defaultSystemPrompt: string | null
  isSystem: boolean
  updatedAt: string
  createdAt: string
}
```

改为：

```typescript
export interface Capability {
  id: number
  key: string
  displayName: string
  description: string
  toolNames: string[]
  category: string | null
  systemPrompt: string | null
  defaultSystemPrompt: string | null
  isSystem: boolean
  updatedAt: string
  createdAt: string
}
```

- [ ] **Step 2: 验证前端 TypeScript 编译**

```bash
cd web && pnpm build 2>&1 | tail -20
```

预期：无 TypeScript 报错，构建成功。

- [ ] **Step 3: Commit**

```bash
git add web/src/api/capabilities.ts
git commit -m "feat(frontend): Capability 类型新增 category 字段"
```

---

### Task 5: 前端页面（列 + 筛选 + 表单字段）

**Files:**
- Modify: `web/src/pages/CapabilitiesPage.tsx`

- [ ] **Step 1: 在文件顶部添加分类常量**

找到 `web/src/pages/CapabilitiesPage.tsx` 中 `export default function CapabilitiesPage()` 之前，插入：

```typescript
const CATEGORY_OPTIONS = [
  { value: 'feature_dev', label: '需求开发类', color: 'blue' },
  { value: 'bug_fix',     label: 'Bug 修复类', color: 'red' },
  { value: 'ops',         label: '运维操作类', color: 'green' },
  { value: 'info_query',  label: '信息抓取类', color: 'orange' },
]

function CategoryTag({ category }: { category: string | null }) {
  const opt = CATEGORY_OPTIONS.find(o => o.value === category)
  return opt
    ? <Tag color={opt.color}>{opt.label}</Tag>
    : <Tag>未分类</Tag>
}
```

- [ ] **Step 2: 添加筛选 state**

找到 `CapabilitiesPage` 函数体内：

```typescript
  const [loading, setLoading] = useState(false)
```

在其后新增：

```typescript
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
```

- [ ] **Step 3: 计算过滤后的数据**

找到：

```typescript
  async function load() {
    setLoading(true)
    try { setData(await getCapabilities()) } finally { setLoading(false) }
  }
```

在 `load` 函数后、`openCreate` 函数前，新增：

```typescript
  const filteredData = categoryFilter
    ? data.filter(r => r.category === categoryFilter)
    : data
```

- [ ] **Step 4: 在表格 columns 定义中新增「业务分类」列**

找到 columns 数组中：

```typescript
    { title: '类型', dataIndex: 'isSystem',
      render: (v: boolean) => <Tag color={v ? 'default' : 'blue'}>{v ? '系统' : '自定义'}</Tag> },
```

在其前插入：

```typescript
    { title: '业务分类', dataIndex: 'category',
      render: (v: string | null) => <CategoryTag category={v} /> },
```

- [ ] **Step 5: 表格使用 filteredData 并添加顶部筛选**

找到：

```typescript
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
```

改为：

```typescript
      <div style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="按业务分类筛选"
          style={{ width: 180 }}
          value={categoryFilter ?? undefined}
          onChange={v => setCategoryFilter(v ?? null)}
          options={[
            ...CATEGORY_OPTIONS.map(o => ({ value: o.value, label: <Tag color={o.color}>{o.label}</Tag> })),
          ]}
        />
      </div>
      <Table rowKey="id" columns={columns} dataSource={filteredData} loading={loading} pagination={false} />
```

- [ ] **Step 6: 在 Form 中新增「业务分类」Select 字段**

找到 Modal Form 中：

```typescript
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="描述该能力的用途" />
          </Form.Item>
```

在其后插入：

```typescript
          <Form.Item name="category" label="业务分类">
            <Select
              allowClear
              placeholder="请选择（可选）"
              options={CATEGORY_OPTIONS.map(o => ({
                value: o.value,
                label: <Tag color={o.color}>{o.label}</Tag>,
              }))}
            />
          </Form.Item>
```

- [ ] **Step 7: 验证前端编译**

```bash
cd web && pnpm build 2>&1 | tail -20
```

预期：无 TypeScript 报错，构建成功。

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/CapabilitiesPage.tsx
git commit -m "feat(frontend): 能力列表新增业务分类列、筛选、表单字段"
```

---

### Task 6: 收尾验证

- [ ] **Step 1: 跑全套测试**

```bash
./test.sh 2>&1 | tee logs/test-capability-category.log
```

预期：所有测试通过（schema-v48 ALTER TABLE 幂等，现有测试不受影响）。

- [ ] **Step 2: 本地迁移验证**

```bash
pnpm migrate
```

预期：输出包含 `v48 applied` 或 `v48 already applied`，无报错。
