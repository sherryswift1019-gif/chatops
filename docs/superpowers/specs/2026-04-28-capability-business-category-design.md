# 能力业务分类设计

**日期**: 2026-04-28  
**状态**: 已审批

## 背景

`capabilities` 表的旧 `category` 字段（`query`/`action`/`admin`）已在 schema-v33 中删除（phase 2 cleanup）。现需新增面向业务的分类维度，供管理后台筛选、IM 展示、调用统计使用。

## 目标

- 每个能力可归属一个业务分类（可空，NULL = 未分类）
- 四种固定分类：需求开发类、Bug 修复类、运维操作类、信息抓取类
- 管理后台能力列表可按分类筛选/展示
- 创建/编辑能力时可设置分类

## 非目标

- 多分类（每个能力只属于一个分类）
- 自定义分类（固定枚举，不提供管理界面）
- IM 分类展示（本期不实现，预留字段即可）

## 枚举值

| 内部值 | 显示名 |
|---|---|
| `feature_dev` | 需求开发类 |
| `bug_fix` | Bug 修复类 |
| `ops` | 运维操作类 |
| `info_query` | 信息抓取类 |
| NULL | 未分类 |

## 设计

### §1 数据库

新增 `src/db/schema-v48.sql`：

```sql
-- v48: capabilities 新增业务分类字段
ALTER TABLE capabilities
  ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IN ('feature_dev', 'bug_fix', 'ops', 'info_query'));
```

- 可空（NULL），现有数据无需回填，显示为「未分类」
- 在 `src/db/migrate.ts` 的 `SCHEMA_FILES` 末尾追加 `schema-v48.sql`

### §2 后端

**`src/db/repositories/capabilities.ts`**

- `Capability` interface 新增：`category: string | null`
- `mapRow` 新增：`category: (r.category ?? null) as string | null`
- `createCapability` 参数新增可选 `category?: string | null`，INSERT 加入该字段
- `updateCapability` 参数新增可选 `category?: string | null`，UPDATE SET 用 `COALESCE` 处理

**`src/admin/routes/capabilities.ts`**

- POST `/capabilities` body 增加可选 `category?: string`，透传给 `createCapability`
- PUT `/capabilities/:id` 已用 `req.body as any` 透传，无需改动

### §3 前端

**`web/src/api/capabilities.ts`**

- `Capability` 类型新增 `category: string | null`

**`web/src/pages/CapabilitiesPage.tsx`**

- 表格新增「业务分类」列，渲染彩色 Tag：
  - `feature_dev` → blue「需求开发」
  - `bug_fix` → red「Bug 修复」
  - `ops` → green「运维操作」
  - `info_query` → orange「信息抓取」
  - NULL → default 灰色「未分类」
- 表格顶部增加分类筛选 `Select`（含「全部」选项）
- 创建/编辑 Modal Form 中新增非必填「业务分类」Select 字段

## 改动文件清单

| 文件 | 改动类型 |
|---|---|
| `src/db/schema-v48.sql` | 新增 |
| `src/db/migrate.ts` | 追加一行 |
| `src/__tests__/helpers/db.ts` | SCHEMA_FILES 追加 schema-v48.sql（纯 ALTER，无 seed 污染） |
| `src/db/repositories/capabilities.ts` | 扩展 interface + mapRow + create/update |
| `src/admin/routes/capabilities.ts` | POST body 加 category |
| `web/src/api/capabilities.ts` | 类型扩展 |
| `web/src/pages/CapabilitiesPage.tsx` | 列 + 筛选 + 表单字段 |
