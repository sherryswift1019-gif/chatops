# Server-Env Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Docker mode's manual host/username/password fields in ProductLineEnv with a server selector that references TestServer records.

**Architecture:** Docker mode's `connectionConfig` changes from `{ host, username, password }` to `{ serverIds: [id1, id2] }`. The EnvConfigTab fetches the product line's TestServer list and renders a multi-select. K8s mode and all backend storage remain unchanged (JSONB is schemaless). No DB migration needed.

**Tech Stack:** React 18, Ant Design 5 Select, existing API endpoints

**Spec:** `docs/superpowers/specs/2026-04-14-server-env-unification-design.md`

---

### Task 1: Replace Docker connection fields with server selector

**Files:**
- Modify: `web/src/pages/ProductLineDetailPage.tsx` (lines 374-523, the `EnvConfigTab` component)

- [ ] **Step 1: Add TestServer import and state**

At the top of `ProductLineDetailPage.tsx`, find the existing imports from `../api/test-servers` or add the import:

```typescript
import { getTestServers } from '../api/test-servers'
```

Also add `TestServer` to the types import:

```typescript
import type { ..., TestServer } from '../types'
```

Inside the `EnvConfigTab` component, after the existing state declarations (line 389), add:

```typescript
const [servers, setServers] = useState<TestServer[]>([])
```

- [ ] **Step 2: Load servers alongside environments**

In the `load()` function inside `EnvConfigTab` (line 393-416), add `getTestServers(productLineId)` to the `Promise.all`:

```typescript
async function load() {
  setLoading(true)
  try {
    const [allEnvs, plEnvs, plServers] = await Promise.all([
      getEnvironments(),
      getProductLineEnvs(productLineId),
      getTestServers(productLineId),
    ])
    setServers(plServers)
    const plEnvMap = new Map<number, ProductLineEnv>(plEnvs.map(e => [e.envId, e]))
    setRows(allEnvs.map(env => {
      const existing = plEnvMap.get(env.id)
      return {
        envId: env.id,
        envName: env.name,
        envDisplayName: env.displayName,
        enabled: existing?.enabled ?? false,
        runtime: (existing?.runtime as 'kubernetes' | 'docker') ?? 'docker',
        namespace: existing?.namespace ?? '',
        connectionConfig: existing?.connectionConfig ?? {},
      }
    }))
  } finally {
    setLoading(false)
  }
}
```

- [ ] **Step 3: Replace Docker connection form with server selector**

In the `columns` definition, find the `'连接配置'` column render function (lines 461-510). Replace the Docker branch (lines 479-508) with a server multi-select:

```typescript
{
  title: '连接配置',
  key: 'connection',
  width: 360,
  render: (_: unknown, record: EnvRow) => {
    const cfg = record.connectionConfig as Record<string, unknown>
    if (record.runtime === 'kubernetes') {
      return (
        <Input
          value={record.namespace || (cfg.namespace as string) || ''}
          placeholder="K8s Namespace，如: pam-prod"
          onChange={(e) => updateRow(record.envId, {
            namespace: e.target.value,
            connectionConfig: { ...cfg, namespace: e.target.value },
          })}
        />
      )
    }
    // Docker: select servers from TestServer pool
    const serverIds = (cfg.serverIds as number[]) ?? []
    return (
      <Select
        mode="multiple"
        value={serverIds}
        style={{ width: '100%' }}
        placeholder={servers.length > 0 ? '选择服务器' : '请先在测试服务器页面添加服务器'}
        onChange={(ids: number[]) => updateRow(record.envId, {
          connectionConfig: { serverIds: ids },
        })}
        options={servers.map(s => ({
          value: s.id,
          label: `${s.name} (${s.host}) - ${s.role || '无角色'}`,
        }))}
      />
    )
  },
},
```

- [ ] **Step 4: Verify compilation**

Run: `cd web && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ProductLineDetailPage.tsx
git commit -m "feat: replace Docker env connection fields with TestServer selector"
```

---

### Task 2: Handle backward compatibility for existing Docker configs

**Files:**
- Modify: `web/src/pages/ProductLineDetailPage.tsx` (same `EnvConfigTab`)

Existing Docker-mode records may have `{ host, username, password }` instead of `{ serverIds: [...] }`. The selector should handle both formats gracefully.

- [ ] **Step 1: Add backward-compat logic to Docker render**

In the Docker branch of the connection config column, before the `return <Select ...>`, add a fallback display for legacy configs that haven't been migrated:

```typescript
// Docker: select servers from TestServer pool
const serverIds = (cfg.serverIds as number[]) ?? []
// Legacy format: show read-only info with migration hint
if (!cfg.serverIds && cfg.host) {
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Tag color="orange">旧配置: {cfg.host as string}@{cfg.username as string ?? ''}</Tag>
      <Select
        mode="multiple"
        value={[]}
        style={{ width: '100%' }}
        placeholder="请选择服务器以替换旧配置"
        onChange={(ids: number[]) => updateRow(record.envId, {
          connectionConfig: { serverIds: ids },
        })}
        options={servers.map(s => ({
          value: s.id,
          label: `${s.name} (${s.host}) - ${s.role || '无角色'}`,
        }))}
      />
    </Space>
  )
}
return (
  <Select
    mode="multiple"
    value={serverIds}
    style={{ width: '100%' }}
    placeholder={servers.length > 0 ? '选择服务器' : '请先在测试服务器页面添加服务器'}
    onChange={(ids: number[]) => updateRow(record.envId, {
      connectionConfig: { serverIds: ids },
    })}
    options={servers.map(s => ({
      value: s.id,
      label: `${s.name} (${s.host}) - ${s.role || '无角色'}`,
    }))}
  />
)
```

- [ ] **Step 2: Verify compilation**

Run: `cd web && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/ProductLineDetailPage.tsx
git commit -m "feat: handle legacy Docker connection config with migration hint"
```

---

## Verification

After all tasks are complete:

1. **Build and deploy**: `docker compose up -d --build`
2. **Open product line detail page** → 环境配置 Tab
3. **Docker mode**: Verify server multi-select appears instead of host/username/password fields
4. **K8s mode**: Verify namespace input remains unchanged
5. **Select servers**: Pick 1-2 servers, save, reload — verify selections persist
6. **Legacy data**: If any Docker env has old `{ host, username, password }` format, verify it shows an orange tag with the old info and a selector to migrate
7. **Empty state**: If no test servers exist for the product line, verify placeholder says "请先在测试服务器页面添加服务器"
