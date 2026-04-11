# ChatOps Admin Frontend SPA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a React + Ant Design SPA in `web/` that serves as the admin management interface for the ChatOps platform, connecting to the existing `/admin/*` REST API.

**Architecture:** Standalone Vite project in `web/`. Axios client layer maps 1:1 to backend routes. React Router 6 for navigation. Ant Design 5 for UI components. In production, `web/dist/` served by `@fastify/static` with SPA fallback.

**Tech Stack:** React 18, TypeScript, Ant Design 5, React Router 6, Axios, Vite 6

---

## File Map

```
web/
  index.html
  vite.config.ts
  tsconfig.json
  package.json
  src/
    main.tsx
    App.tsx
    types/
      index.ts                         # All shared TypeScript interfaces
    api/
      client.ts                        # Axios instance + base config
      product-lines.ts                 # Product line CRUD + members + envs
      projects.ts                      # Project CRUD
      environments.ts                  # Environment CRUD
      approval-rules.ts                # Approval rules CRUD
      dingtalk-users.ts                # DingTalk user list + sync
      system-config.ts                 # System config get + put
    components/
      DingTalkUserSelect.tsx           # Reusable DingTalk user picker
    layout/
      AdminLayout.tsx                  # Sider + menu + outlet
    pages/
      SystemConfigPage.tsx             # Tabbed config editor
      EnvironmentListPage.tsx          # Environment CRUD table
      ProductLineListPage.tsx          # Product line list
      ProductLineDetailPage.tsx        # Detail with 5 tabs
      ProjectsPage.tsx                 # Projects table with filter
      ApprovalRulesPage.tsx            # Approval rules table
      DingTalkUsersPage.tsx            # DingTalk user list + sync
src/
  server.ts                            # Updated: serve web/dist via @fastify/static
Dockerfile                             # Updated: multi-stage build (node + vite)
```

---

## Task 1: Project Bootstrap

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/index.html`
- Create: `web/vite.config.ts`

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "chatops-admin-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "antd": "^5.22.0",
    "axios": "^1.7.9",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.2",
    "vite": "^6.0.3"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ChatOps 管理控制台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `web/vite.config.ts`**

In development, proxy `/admin` requests to the backend at `http://localhost:3000`.

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/admin': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
```

- [ ] **Step 5: Install dependencies**

```bash
cd web && npm install
```

- [ ] **Step 6: Verify dev server starts**

```bash
cd web && npm run dev
```

Expected: Vite dev server on http://localhost:5173

- [ ] **Step 7: Commit**

```bash
git add web/
git commit -m "feat(web): bootstrap Vite + React + TS + Ant Design project"
```

---

## Task 2: API Client Layer + Types

**Files:**
- Create: `web/src/types/index.ts`
- Create: `web/src/api/client.ts`
- Create: `web/src/api/product-lines.ts`
- Create: `web/src/api/projects.ts`
- Create: `web/src/api/environments.ts`
- Create: `web/src/api/approval-rules.ts`
- Create: `web/src/api/dingtalk-users.ts`
- Create: `web/src/api/system-config.ts`

- [ ] **Step 1: Write `web/src/types/index.ts`**

```typescript
// ─── Product Lines ───────────────────────────────────────────────────────────

export interface ProductLine {
  id: number
  name: string
  displayName: string
  description: string
  createdAt: string
  updatedAt: string
}

export interface ProductLineMember {
  id: number
  productLineId: number
  userId: string
  userName: string
  role: 'developer' | 'ops' | 'admin'
  createdAt: string
}

export interface ProductLineEnv {
  id: number
  productLineId: number
  envId: number
  runtime: 'kubernetes' | 'docker'
  namespace: string
  enabled: boolean
}

// ─── Projects ────────────────────────────────────────────────────────────────

export interface Project {
  id: number
  productLineId: number
  name: string
  displayName: string
  gitlabPath: string
  harborProject: string
  ownerId: string
  ownerName: string
  description: string
  createdAt: string
  updatedAt: string
}

// ─── Environments ────────────────────────────────────────────────────────────

export interface Environment {
  id: number
  name: string
  displayName: string
  sortOrder: number
  createdAt: string
}

// ─── Approval Rules ──────────────────────────────────────────────────────────

export interface ApprovalRule {
  id: number
  productLineId: number | null
  action: string
  env: string
  primaryApprovers: string[]
  backupApprovers: string[]
  primaryTimeoutMin: number
  totalTimeoutMin: number
  createdAt: string
  updatedAt: string
}

// ─── DingTalk Users ──────────────────────────────────────────────────────────

export interface DingTalkUser {
  userId: string
  name: string
  avatar: string
  department: string
  syncedAt: string
}

export interface DingTalkUsersResponse {
  users: DingTalkUser[]
  total: number
}

export interface DingTalkSyncResult {
  success: boolean
  upserted: number
  error?: string
}

// ─── System Config ───────────────────────────────────────────────────────────

export interface SystemConfigEntry {
  key: string
  value: Record<string, unknown>
  updatedAt: string
}

// ─── API Payloads ────────────────────────────────────────────────────────────

export interface CreateProductLinePayload {
  name: string
  displayName: string
  description?: string
}

export interface UpdateProductLinePayload {
  name?: string
  displayName?: string
  description?: string
}

export interface AddMemberPayload {
  userId: string
  userName: string
  role: 'developer' | 'ops' | 'admin'
}

export interface SetProductLineEnvsPayload {
  envId: number
  runtime: 'kubernetes' | 'docker'
  namespace?: string
  enabled?: boolean
}

export interface CreateProjectPayload {
  productLineId: number
  name: string
  displayName: string
  gitlabPath?: string
  harborProject?: string
  ownerId?: string
  ownerName?: string
  description?: string
}

export interface UpdateProjectPayload {
  productLineId?: number
  name?: string
  displayName?: string
  gitlabPath?: string
  harborProject?: string
  ownerId?: string
  ownerName?: string
  description?: string
}

export interface CreateEnvironmentPayload {
  name: string
  displayName: string
  sortOrder?: number
}

export interface UpdateEnvironmentPayload {
  name?: string
  displayName?: string
  sortOrder?: number
}

export interface CreateApprovalRulePayload {
  productLineId?: number
  action: string
  env: string
  primaryApprovers: string[]
  backupApprovers: string[]
  primaryTimeoutMin: number
  totalTimeoutMin: number
}

export interface UpdateApprovalRulePayload {
  productLineId?: number | null
  action?: string
  env?: string
  primaryApprovers?: string[]
  backupApprovers?: string[]
  primaryTimeoutMin?: number
  totalTimeoutMin?: number
}
```

- [ ] **Step 2: Write `web/src/api/client.ts`**

```typescript
import axios from 'axios'

const client = axios.create({
  baseURL: '/admin',
  headers: {
    'Content-Type': 'application/json',
  },
})

client.interceptors.response.use(
  (response) => response,
  (error) => {
    const message =
      error.response?.data?.error ?? error.message ?? '请求失败'
    return Promise.reject(new Error(message))
  }
)

export default client
```

- [ ] **Step 3: Write `web/src/api/product-lines.ts`**

```typescript
import client from './client'
import type {
  ProductLine,
  ProductLineMember,
  ProductLineEnv,
  CreateProductLinePayload,
  UpdateProductLinePayload,
  AddMemberPayload,
  SetProductLineEnvsPayload,
} from '../types'

export const productLinesApi = {
  list: (): Promise<ProductLine[]> =>
    client.get<ProductLine[]>('/product-lines').then((r) => r.data),

  create: (payload: CreateProductLinePayload): Promise<ProductLine> =>
    client.post<ProductLine>('/product-lines', payload).then((r) => r.data),

  update: (id: number, payload: UpdateProductLinePayload): Promise<ProductLine> =>
    client.put<ProductLine>(`/product-lines/${id}`, payload).then((r) => r.data),

  remove: (id: number): Promise<void> =>
    client.delete(`/product-lines/${id}`).then(() => undefined),

  // Members
  listMembers: (id: number): Promise<ProductLineMember[]> =>
    client.get<ProductLineMember[]>(`/product-lines/${id}/members`).then((r) => r.data),

  addMember: (id: number, payload: AddMemberPayload): Promise<ProductLineMember> =>
    client.post<ProductLineMember>(`/product-lines/${id}/members`, payload).then((r) => r.data),

  updateMemberRole: (
    productLineId: number,
    memberId: number,
    role: 'developer' | 'ops' | 'admin'
  ): Promise<ProductLineMember> =>
    client
      .put<ProductLineMember>(`/product-lines/${productLineId}/members/${memberId}`, { role })
      .then((r) => r.data),

  removeMember: (productLineId: number, memberId: number): Promise<void> =>
    client
      .delete(`/product-lines/${productLineId}/members/${memberId}`)
      .then(() => undefined),

  // Envs
  listEnvs: (id: number): Promise<ProductLineEnv[]> =>
    client.get<ProductLineEnv[]>(`/product-lines/${id}/envs`).then((r) => r.data),

  setEnvs: (id: number, payload: SetProductLineEnvsPayload[]): Promise<ProductLineEnv[]> =>
    client
      .put<ProductLineEnv[]>(`/product-lines/${id}/envs`, payload)
      .then((r) => r.data),
}
```

- [ ] **Step 4: Write `web/src/api/projects.ts`**

```typescript
import client from './client'
import type { Project, CreateProjectPayload, UpdateProjectPayload } from '../types'

export const projectsApi = {
  list: (productLineId?: number): Promise<Project[]> =>
    client
      .get<Project[]>('/projects', { params: productLineId ? { product_line_id: productLineId } : {} })
      .then((r) => r.data),

  create: (payload: CreateProjectPayload): Promise<Project> =>
    client.post<Project>('/projects', payload).then((r) => r.data),

  update: (id: number, payload: UpdateProjectPayload): Promise<Project> =>
    client.put<Project>(`/projects/${id}`, payload).then((r) => r.data),

  remove: (id: number): Promise<void> =>
    client.delete(`/projects/${id}`).then(() => undefined),
}
```

- [ ] **Step 5: Write `web/src/api/environments.ts`**

```typescript
import client from './client'
import type { Environment, CreateEnvironmentPayload, UpdateEnvironmentPayload } from '../types'

export const environmentsApi = {
  list: (): Promise<Environment[]> =>
    client.get<Environment[]>('/environments').then((r) => r.data),

  create: (payload: CreateEnvironmentPayload): Promise<Environment> =>
    client.post<Environment>('/environments', payload).then((r) => r.data),

  update: (id: number, payload: UpdateEnvironmentPayload): Promise<Environment> =>
    client.put<Environment>(`/environments/${id}`, payload).then((r) => r.data),

  remove: (id: number): Promise<void> =>
    client.delete(`/environments/${id}`).then(() => undefined),
}
```

- [ ] **Step 6: Write `web/src/api/approval-rules.ts`**

```typescript
import client from './client'
import type {
  ApprovalRule,
  CreateApprovalRulePayload,
  UpdateApprovalRulePayload,
} from '../types'

export const approvalRulesApi = {
  list: (productLineId?: number): Promise<ApprovalRule[]> =>
    client
      .get<ApprovalRule[]>('/approval-rules', {
        params: productLineId != null ? { product_line_id: productLineId } : {},
      })
      .then((r) => r.data),

  create: (payload: CreateApprovalRulePayload): Promise<ApprovalRule> =>
    client.post<ApprovalRule>('/approval-rules', payload).then((r) => r.data),

  update: (id: number, payload: UpdateApprovalRulePayload): Promise<ApprovalRule> =>
    client.put<ApprovalRule>(`/approval-rules/${id}`, payload).then((r) => r.data),

  remove: (id: number): Promise<void> =>
    client.delete(`/approval-rules/${id}`).then(() => undefined),
}
```

- [ ] **Step 7: Write `web/src/api/dingtalk-users.ts`**

```typescript
import client from './client'
import type { DingTalkUsersResponse, DingTalkSyncResult } from '../types'

export const dingtalkUsersApi = {
  list: (keyword?: string): Promise<DingTalkUsersResponse> =>
    client
      .get<DingTalkUsersResponse>('/dingtalk/users', {
        params: keyword ? { keyword } : {},
      })
      .then((r) => r.data),

  sync: (): Promise<DingTalkSyncResult> =>
    client.post<DingTalkSyncResult>('/dingtalk/users/sync').then((r) => r.data),
}
```

- [ ] **Step 8: Write `web/src/api/system-config.ts`**

```typescript
import client from './client'
import type { SystemConfigEntry } from '../types'

export const systemConfigApi = {
  list: (): Promise<SystemConfigEntry[]> =>
    client.get<SystemConfigEntry[]>('/system-config').then((r) => r.data),

  update: (key: string, value: Record<string, unknown>): Promise<SystemConfigEntry> =>
    client.put<SystemConfigEntry>(`/system-config/${key}`, value).then((r) => r.data),
}
```

- [ ] **Step 9: Commit**

```bash
git add web/src/
git commit -m "feat(web): add API client layer and TypeScript types"
```

---

## Task 3: App Shell + Layout + Routing

**Files:**
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/layout/AdminLayout.tsx`

- [ ] **Step 1: Write `web/src/main.tsx`**

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
```

- [ ] **Step 2: Write `web/src/App.tsx`**

```typescript
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AdminLayout from './layout/AdminLayout'
import SystemConfigPage from './pages/SystemConfigPage'
import EnvironmentListPage from './pages/EnvironmentListPage'
import ProductLineListPage from './pages/ProductLineListPage'
import ProductLineDetailPage from './pages/ProductLineDetailPage'
import ProjectsPage from './pages/ProjectsPage'
import ApprovalRulesPage from './pages/ApprovalRulesPage'
import DingTalkUsersPage from './pages/DingTalkUsersPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AdminLayout />}>
          <Route index element={<Navigate to="/product-lines" replace />} />
          <Route path="product-lines" element={<ProductLineListPage />} />
          <Route path="product-lines/:id" element={<ProductLineDetailPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="environments" element={<EnvironmentListPage />} />
          <Route path="approval-rules" element={<ApprovalRulesPage />} />
          <Route path="dingtalk-users" element={<DingTalkUsersPage />} />
          <Route path="system-config" element={<SystemConfigPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
```

- [ ] **Step 3: Write `web/src/layout/AdminLayout.tsx`**

```typescript
import { useState } from 'react'
import { Layout, Menu, Typography } from 'antd'
import {
  AppstoreOutlined,
  ProjectOutlined,
  EnvironmentOutlined,
  CheckCircleOutlined,
  TeamOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'

const { Sider, Content, Header } = Layout
const { Title } = Typography

const menuItems = [
  {
    key: '/product-lines',
    icon: <AppstoreOutlined />,
    label: '产品线',
  },
  {
    key: '/projects',
    icon: <ProjectOutlined />,
    label: '项目',
  },
  {
    key: '/environments',
    icon: <EnvironmentOutlined />,
    label: '环境',
  },
  {
    key: '/approval-rules',
    icon: <CheckCircleOutlined />,
    label: '审批规则',
  },
  {
    key: '/dingtalk-users',
    icon: <TeamOutlined />,
    label: '钉钉用户',
  },
  {
    key: '/system-config',
    icon: <SettingOutlined />,
    label: '系统配置',
  },
]

export default function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)

  const selectedKey =
    menuItems.find((item) => location.pathname.startsWith(item.key))?.key ?? '/product-lines'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="dark"
        width={220}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          {!collapsed && (
            <Title level={5} style={{ color: '#fff', margin: 0 }}>
              ChatOps 管理台
            </Title>
          )}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ marginTop: 8 }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Title level={4} style={{ margin: 0 }}>
            {menuItems.find((item) => location.pathname.startsWith(item.key))?.label ?? 'ChatOps'}
          </Title>
        </Header>
        <Content style={{ padding: 24, background: '#f5f5f5' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
```

- [ ] **Step 4: Verify the app renders**

```bash
cd web && npm run dev
```

Open http://localhost:5173 — should show the layout with sider menu and redirect to /product-lines.

- [ ] **Step 5: Commit**

```bash
git add web/src/main.tsx web/src/App.tsx web/src/layout/
git commit -m "feat(web): add app shell, layout, and routing"
```

---

## Task 4: System Config Page

**Files:**
- Create: `web/src/pages/SystemConfigPage.tsx`

The system config page loads all config entries and groups them into tabs by key prefix: `dingtalk`, `gitlab`, `harbor`, `claude`. Each tab shows a form for that config section. Password/secret fields are masked. On save, the form values are PUT to `/admin/system-config/:key`. To avoid overwriting secrets with `****` placeholders, fields that still contain the mask pattern are excluded before saving.

- [ ] **Step 1: Write `web/src/pages/SystemConfigPage.tsx`**

```typescript
import { useEffect, useState } from 'react'
import {
  Tabs,
  Form,
  Input,
  Button,
  Card,
  message,
  Spin,
  Typography,
} from 'antd'
import { systemConfigApi } from '../api/system-config'
import type { SystemConfigEntry } from '../types'

const { Title } = Typography

const SECRET_PATTERN = /^[*]+.{0,4}$/

const CONFIG_TABS = [
  {
    key: 'dingtalk',
    label: '钉钉配置',
    fields: [
      { name: 'appKey', label: 'App Key', secret: false },
      { name: 'appSecret', label: 'App Secret', secret: true },
      { name: 'agentId', label: 'Agent ID', secret: false },
      { name: 'robotCode', label: 'Robot Code', secret: false },
    ],
  },
  {
    key: 'gitlab',
    label: 'GitLab 配置',
    fields: [
      { name: 'url', label: 'GitLab URL', secret: false },
      { name: 'token', label: 'Access Token', secret: true },
    ],
  },
  {
    key: 'harbor',
    label: 'Harbor 配置',
    fields: [
      { name: 'url', label: 'Harbor URL', secret: false },
      { name: 'username', label: '用户名', secret: false },
      { name: 'password', label: '密码', secret: true },
      { name: 'project', label: '默认项目', secret: false },
    ],
  },
  {
    key: 'claude',
    label: 'Claude 配置',
    fields: [
      { name: 'apiKey', label: 'API Key', secret: true },
      { name: 'model', label: '模型', secret: false },
      { name: 'maxTokens', label: '最大 Token 数', secret: false },
    ],
  },
]

function isMasked(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return SECRET_PATTERN.test(value)
}

interface ConfigTabProps {
  tabConfig: (typeof CONFIG_TABS)[number]
  initialValues: Record<string, unknown>
  onSave: (key: string, values: Record<string, unknown>) => Promise<void>
}

function ConfigTab({ tabConfig, initialValues, onSave }: ConfigTabProps) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const formValues: Record<string, string> = {}
    for (const field of tabConfig.fields) {
      formValues[field.name] = String(initialValues[field.name] ?? '')
    }
    form.setFieldsValue(formValues)
  }, [form, initialValues, tabConfig.fields])

  async function handleSave() {
    const raw = await form.validateFields()
    const payload: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) {
      // Skip masked placeholder values — don't overwrite real secrets
      if (!isMasked(v)) {
        payload[k] = v
      }
    }
    setSaving(true)
    try {
      await onSave(tabConfig.key, payload)
      message.success('保存成功')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <Form form={form} layout="vertical" style={{ maxWidth: 600 }}>
        {tabConfig.fields.map((field) => (
          <Form.Item key={field.name} name={field.name} label={field.label}>
            {field.secret ? (
              <Input.Password placeholder={`请输入 ${field.label}`} autoComplete="off" />
            ) : (
              <Input placeholder={`请输入 ${field.label}`} />
            )}
          </Form.Item>
        ))}
        <Form.Item>
          <Button type="primary" onClick={handleSave} loading={saving}>
            保存
          </Button>
        </Form.Item>
      </Form>
    </Card>
  )
}

export default function SystemConfigPage() {
  const [configs, setConfigs] = useState<SystemConfigEntry[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    try {
      const data = await systemConfigApi.list()
      setConfigs(data)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleSave(key: string, values: Record<string, unknown>) {
    const updated = await systemConfigApi.update(key, values)
    setConfigs((prev) =>
      prev.some((c) => c.key === key)
        ? prev.map((c) => (c.key === key ? updated : c))
        : [...prev, updated]
    )
  }

  function getValues(key: string): Record<string, unknown> {
    return (configs.find((c) => c.key === key)?.value ?? {}) as Record<string, unknown>
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>
        系统配置
      </Title>
      <Tabs
        items={CONFIG_TABS.map((tab) => ({
          key: tab.key,
          label: tab.label,
          children: (
            <ConfigTab
              tabConfig={tab}
              initialValues={getValues(tab.key)}
              onSave={handleSave}
            />
          ),
        }))}
      />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/SystemConfigPage.tsx
git commit -m "feat(web): add system config page with tabbed forms"
```

---

## Task 5: Environment List Page

**Files:**
- Create: `web/src/pages/EnvironmentListPage.tsx`

Simple CRUD table. Columns: 名称, 显示名, 排序, 创建时间, 操作. Modal form for create/edit.

- [ ] **Step 1: Write `web/src/pages/EnvironmentListPage.tsx`**

```typescript
import { useEffect, useState } from 'react'
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Space,
  Popconfirm,
  message,
  Typography,
} from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { environmentsApi } from '../api/environments'
import type { Environment } from '../types'

const { Title } = Typography

export default function EnvironmentListPage() {
  const [data, setData] = useState<Environment[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Environment | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  async function load() {
    setLoading(true)
    try {
      setData(await environmentsApi.list())
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(record: Environment) {
    setEditing(record)
    form.setFieldsValue({
      name: record.name,
      displayName: record.displayName,
      sortOrder: record.sortOrder,
    })
    setModalOpen(true)
  }

  async function handleDelete(id: number) {
    try {
      await environmentsApi.remove(id)
      message.success('删除成功')
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        await environmentsApi.update(editing.id, values)
        message.success('更新成功')
      } else {
        await environmentsApi.create(values)
        message.success('创建成功')
      }
      setModalOpen(false)
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '显示名', dataIndex: 'displayName', key: 'displayName' },
    { title: '排序', dataIndex: 'sortOrder', key: 'sortOrder', width: 80 },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: Environment) => (
        <Space>
          <Button type="link" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该环境？"
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          环境管理
        </Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建环境
        </Button>
      </div>

      <Table
        rowKey="id"
        dataSource={data}
        columns={columns}
        loading={loading}
        pagination={false}
      />

      <Modal
        title={editing ? '编辑环境' : '新建环境'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="如 production" />
          </Form.Item>
          <Form.Item
            name="displayName"
            label="显示名"
            rules={[{ required: true, message: '请输入显示名' }]}
          >
            <Input placeholder="如 生产环境" />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/EnvironmentListPage.tsx
git commit -m "feat(web): add environment list CRUD page"
```

---

## Task 6: Product Line List + Detail

**Files:**
- Create: `web/src/components/DingTalkUserSelect.tsx`
- Create: `web/src/pages/ProductLineListPage.tsx`
- Create: `web/src/pages/ProductLineDetailPage.tsx`

- [ ] **Step 1: Write `web/src/components/DingTalkUserSelect.tsx`**

Reusable async select component that searches DingTalk users by keyword. Supports both single and multi-select modes.

```typescript
import { useState, useCallback } from 'react'
import { Select, Avatar, Space, Typography } from 'antd'
import { UserOutlined } from '@ant-design/icons'
import { dingtalkUsersApi } from '../api/dingtalk-users'
import type { DingTalkUser } from '../types'

const { Text } = Typography

interface DingTalkUserSelectProps {
  value?: string | string[]
  onChange?: (value: string | string[]) => void
  mode?: 'single' | 'multiple'
  placeholder?: string
  style?: React.CSSProperties
}

export default function DingTalkUserSelect({
  value,
  onChange,
  mode = 'single',
  placeholder = '搜索钉钉用户',
  style,
}: DingTalkUserSelectProps) {
  const [options, setOptions] = useState<DingTalkUser[]>([])
  const [searching, setSearching] = useState(false)

  const handleSearch = useCallback(async (keyword: string) => {
    if (!keyword) {
      setOptions([])
      return
    }
    setSearching(true)
    try {
      const { users } = await dingtalkUsersApi.list(keyword)
      setOptions(users)
    } catch {
      setOptions([])
    } finally {
      setSearching(false)
    }
  }, [])

  const selectOptions = options.map((u) => ({
    value: u.userId,
    label: (
      <Space>
        {u.avatar ? (
          <Avatar src={u.avatar} size="small" />
        ) : (
          <Avatar icon={<UserOutlined />} size="small" />
        )}
        <Text>{u.name}</Text>
        {u.department && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {u.department}
          </Text>
        )}
      </Space>
    ),
  }))

  if (mode === 'multiple') {
    return (
      <Select
        mode="multiple"
        value={value as string[] | undefined}
        onChange={onChange as (v: string[]) => void}
        onSearch={handleSearch}
        loading={searching}
        options={selectOptions}
        filterOption={false}
        showSearch
        placeholder={placeholder}
        style={style}
        notFoundContent={searching ? '搜索中...' : '无结果'}
      />
    )
  }

  return (
    <Select
      value={value as string | undefined}
      onChange={onChange as (v: string) => void}
      onSearch={handleSearch}
      loading={searching}
      options={selectOptions}
      filterOption={false}
      showSearch
      placeholder={placeholder}
      style={style}
      notFoundContent={searching ? '搜索中...' : '无结果'}
    />
  )
}
```

- [ ] **Step 2: Write `web/src/pages/ProductLineListPage.tsx`**

```typescript
import { useEffect, useState } from 'react'
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Space,
  Popconfirm,
  message,
  Typography,
} from 'antd'
import { PlusOutlined, EyeOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { productLinesApi } from '../api/product-lines'
import type { ProductLine } from '../types'

const { Title } = Typography

export default function ProductLineListPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ProductLine | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  async function load() {
    setLoading(true)
    try {
      setData(await productLinesApi.list())
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(record: ProductLine) {
    setEditing(record)
    form.setFieldsValue({
      name: record.name,
      displayName: record.displayName,
      description: record.description,
    })
    setModalOpen(true)
  }

  async function handleDelete(id: number) {
    try {
      await productLinesApi.remove(id)
      message.success('删除成功')
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        await productLinesApi.update(editing.id, values)
        message.success('更新成功')
      } else {
        await productLinesApi.create(values)
        message.success('创建成功')
      }
      setModalOpen(false)
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '显示名', dataIndex: 'displayName', key: 'displayName' },
    { title: '描述', dataIndex: 'description', key: 'description', ellipsis: true },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: ProductLine) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/product-lines/${record.id}`)}
          >
            详情
          </Button>
          <Button type="link" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该产品线？所有关联数据将一并删除。"
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          产品线管理
        </Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建产品线
        </Button>
      </div>

      <Table
        rowKey="id"
        dataSource={data}
        columns={columns}
        loading={loading}
        pagination={{ pageSize: 20 }}
      />

      <Modal
        title={editing ? '编辑产品线' : '新建产品线'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="名称（英文标识）"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="如 payment-service" />
          </Form.Item>
          <Form.Item
            name="displayName"
            label="显示名"
            rules={[{ required: true, message: '请输入显示名' }]}
          >
            <Input placeholder="如 支付服务" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="产品线描述（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
```

- [ ] **Step 3: Write `web/src/pages/ProductLineDetailPage.tsx`**

This page loads a product line by ID and shows 5 tabs: 基本信息, 项目, 成员, 环境配置, 审批规则.

```typescript
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Tabs,
  Card,
  Descriptions,
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Space,
  Popconfirm,
  message,
  Spin,
  Typography,
  Switch,
  Tag,
} from 'antd'
import { PlusOutlined, ArrowLeftOutlined } from '@ant-design/icons'
import { productLinesApi } from '../api/product-lines'
import { projectsApi } from '../api/projects'
import { environmentsApi } from '../api/environments'
import { approvalRulesApi } from '../api/approval-rules'
import DingTalkUserSelect from '../components/DingTalkUserSelect'
import type {
  ProductLine,
  ProductLineMember,
  ProductLineEnv,
  Project,
  Environment,
  ApprovalRule,
} from '../types'

const { Title } = Typography

// ─── BasicInfo Tab ────────────────────────────────────────────────────────────

function BasicInfoTab({ productLine }: { productLine: ProductLine }) {
  return (
    <Card>
      <Descriptions column={2} bordered>
        <Descriptions.Item label="ID">{productLine.id}</Descriptions.Item>
        <Descriptions.Item label="名称">{productLine.name}</Descriptions.Item>
        <Descriptions.Item label="显示名">{productLine.displayName}</Descriptions.Item>
        <Descriptions.Item label="描述" span={2}>
          {productLine.description || '—'}
        </Descriptions.Item>
        <Descriptions.Item label="创建时间">
          {new Date(productLine.createdAt).toLocaleString('zh-CN')}
        </Descriptions.Item>
        <Descriptions.Item label="更新时间">
          {new Date(productLine.updatedAt).toLocaleString('zh-CN')}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  )
}

// ─── Projects Tab ─────────────────────────────────────────────────────────────

function ProjectsTab({ productLineId }: { productLineId: number }) {
  const [data, setData] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setData(await projectsApi.list(productLineId))
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [productLineId])

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '显示名', dataIndex: 'displayName', key: 'displayName' },
    { title: 'GitLab 路径', dataIndex: 'gitlabPath', key: 'gitlabPath' },
    { title: 'Harbor 项目', dataIndex: 'harborProject', key: 'harborProject' },
    { title: '负责人', dataIndex: 'ownerName', key: 'ownerName' },
  ]

  return (
    <Table
      rowKey="id"
      dataSource={data}
      columns={columns}
      loading={loading}
      pagination={false}
    />
  )
}

// ─── Members Tab ──────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  developer: '开发',
  ops: '运维',
  admin: '管理员',
}

const ROLE_COLORS: Record<string, string> = {
  developer: 'blue',
  ops: 'green',
  admin: 'red',
}

function MembersTab({ productLineId }: { productLineId: number }) {
  const [data, setData] = useState<ProductLineMember[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  async function load() {
    setLoading(true)
    try {
      setData(await productLinesApi.listMembers(productLineId))
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [productLineId])

  async function handleAdd() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      await productLinesApi.addMember(productLineId, {
        userId: values.userId,
        userName: values.userName,
        role: values.role,
      })
      message.success('成员添加成功')
      setModalOpen(false)
      form.resetFields()
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '添加失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove(memberId: number) {
    try {
      await productLinesApi.removeMember(productLineId, memberId)
      message.success('移除成功')
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '移除失败')
    }
  }

  async function handleRoleChange(
    memberId: number,
    role: 'developer' | 'ops' | 'admin'
  ) {
    try {
      await productLinesApi.updateMemberRole(productLineId, memberId, role)
      message.success('角色更新成功')
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '更新失败')
    }
  }

  const columns = [
    { title: '用户 ID', dataIndex: 'userId', key: 'userId' },
    { title: '姓名', dataIndex: 'userName', key: 'userName' },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      render: (role: string, record: ProductLineMember) => (
        <Select
          size="small"
          value={role}
          onChange={(v: 'developer' | 'ops' | 'admin') => handleRoleChange(record.id, v)}
          options={[
            { value: 'developer', label: '开发' },
            { value: 'ops', label: '运维' },
            { value: 'admin', label: '管理员' },
          ]}
          style={{ width: 100 }}
        />
      ),
    },
    {
      title: '标签',
      key: 'roleTag',
      render: (_: unknown, record: ProductLineMember) => (
        <Tag color={ROLE_COLORS[record.role]}>{ROLE_LABELS[record.role]}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: ProductLineMember) => (
        <Popconfirm
          title="确认移除该成员？"
          onConfirm={() => handleRemove(record.id)}
          okText="移除"
          cancelText="取消"
        >
          <Button type="link" size="small" danger>
            移除
          </Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields()
            setModalOpen(true)
          }}
        >
          添加成员
        </Button>
      </div>
      <Table
        rowKey="id"
        dataSource={data}
        columns={columns}
        loading={loading}
        pagination={false}
      />
      <Modal
        title="添加成员"
        open={modalOpen}
        onOk={handleAdd}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText="添加"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="userId"
            label="选择钉钉用户"
            rules={[{ required: true, message: '请选择用户' }]}
          >
            <DingTalkUserSelect
              style={{ width: '100%' }}
              onChange={(v) => {
                // When user is selected, also set the userName from options
                form.setFieldValue('userId', v)
              }}
            />
          </Form.Item>
          <Form.Item
            name="userName"
            label="姓名"
            rules={[{ required: true, message: '请输入姓名' }]}
          >
            <Input placeholder="成员姓名" />
          </Form.Item>
          <Form.Item
            name="role"
            label="角色"
            rules={[{ required: true, message: '请选择角色' }]}
          >
            <Select
              placeholder="请选择角色"
              options={[
                { value: 'developer', label: '开发' },
                { value: 'ops', label: '运维' },
                { value: 'admin', label: '管理员' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ─── EnvConfig Tab ────────────────────────────────────────────────────────────

function EnvConfigTab({ productLineId }: { productLineId: number }) {
  const [envConfigs, setEnvConfigs] = useState<ProductLineEnv[]>([])
  const [allEnvs, setAllEnvs] = useState<Environment[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [configs, envs] = await Promise.all([
        productLinesApi.listEnvs(productLineId),
        environmentsApi.list(),
      ])
      setEnvConfigs(configs)
      setAllEnvs(envs)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [productLineId])

  function getConfig(envId: number): ProductLineEnv | undefined {
    return envConfigs.find((c) => c.envId === envId)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const payload = envConfigs.map((c) => ({
        envId: c.envId,
        runtime: c.runtime,
        namespace: c.namespace,
        enabled: c.enabled,
      }))
      const updated = await productLinesApi.setEnvs(productLineId, payload)
      setEnvConfigs(updated)
      message.success('环境配置保存成功')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  function updateConfig(envId: number, patch: Partial<ProductLineEnv>) {
    setEnvConfigs((prev) => {
      const exists = prev.find((c) => c.envId === envId)
      if (exists) {
        return prev.map((c) => (c.envId === envId ? { ...c, ...patch } : c))
      }
      return [
        ...prev,
        {
          id: 0,
          productLineId,
          envId,
          runtime: 'kubernetes',
          namespace: '',
          enabled: true,
          ...patch,
        } as ProductLineEnv,
      ]
    })
  }

  if (loading) return <Spin />

  const columns = [
    {
      title: '环境',
      key: 'env',
      render: (_: unknown, env: Environment) => env.displayName,
    },
    {
      title: '启用',
      key: 'enabled',
      render: (_: unknown, env: Environment) => (
        <Switch
          checked={getConfig(env.id)?.enabled ?? false}
          onChange={(v) => updateConfig(env.id, { enabled: v })}
        />
      ),
    },
    {
      title: '运行时',
      key: 'runtime',
      render: (_: unknown, env: Environment) => (
        <Select
          value={getConfig(env.id)?.runtime ?? 'kubernetes'}
          onChange={(v: 'kubernetes' | 'docker') => updateConfig(env.id, { runtime: v })}
          options={[
            { value: 'kubernetes', label: 'Kubernetes' },
            { value: 'docker', label: 'Docker' },
          ]}
          style={{ width: 140 }}
        />
      ),
    },
    {
      title: '命名空间 / 网络',
      key: 'namespace',
      render: (_: unknown, env: Environment) => (
        <Input
          value={getConfig(env.id)?.namespace ?? ''}
          onChange={(e) => updateConfig(env.id, { namespace: e.target.value })}
          placeholder="namespace / docker network"
          style={{ width: 220 }}
        />
      ),
    },
  ]

  return (
    <div>
      <Table
        rowKey="id"
        dataSource={allEnvs}
        columns={columns}
        pagination={false}
      />
      <div style={{ marginTop: 16 }}>
        <Button type="primary" onClick={handleSave} loading={saving}>
          保存环境配置
        </Button>
      </div>
    </div>
  )
}

// ─── ApprovalRules Tab ────────────────────────────────────────────────────────

function ApprovalRulesTab({ productLineId }: { productLineId: number }) {
  const [data, setData] = useState<ApprovalRule[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ApprovalRule | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  async function load() {
    setLoading(true)
    try {
      setData(await approvalRulesApi.list(productLineId))
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [productLineId])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ primaryTimeoutMin: 10, totalTimeoutMin: 20 })
    setModalOpen(true)
  }

  function openEdit(record: ApprovalRule) {
    setEditing(record)
    form.setFieldsValue({
      action: record.action,
      env: record.env,
      primaryApprovers: record.primaryApprovers,
      backupApprovers: record.backupApprovers,
      primaryTimeoutMin: record.primaryTimeoutMin,
      totalTimeoutMin: record.totalTimeoutMin,
    })
    setModalOpen(true)
  }

  async function handleDelete(id: number) {
    try {
      await approvalRulesApi.remove(id)
      message.success('删除成功')
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        await approvalRulesApi.update(editing.id, values)
        message.success('更新成功')
      } else {
        await approvalRulesApi.create({ ...values, productLineId })
        message.success('创建成功')
      }
      setModalOpen(false)
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    { title: '动作', dataIndex: 'action', key: 'action' },
    { title: '环境', dataIndex: 'env', key: 'env' },
    {
      title: '主审批人',
      dataIndex: 'primaryApprovers',
      key: 'primaryApprovers',
      render: (v: string[]) => v.join(', '),
    },
    {
      title: '主超时（分钟）',
      dataIndex: 'primaryTimeoutMin',
      key: 'primaryTimeoutMin',
      width: 120,
    },
    {
      title: '总超时（分钟）',
      dataIndex: 'totalTimeoutMin',
      key: 'totalTimeoutMin',
      width: 120,
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: ApprovalRule) => (
        <Space>
          <Button type="link" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该审批规则？"
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建规则
        </Button>
      </div>
      <Table
        rowKey="id"
        dataSource={data}
        columns={columns}
        loading={loading}
        pagination={false}
      />
      <Modal
        title={editing ? '编辑审批规则' : '新建审批规则'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="action"
            label="动作"
            rules={[{ required: true, message: '请输入动作' }]}
          >
            <Input placeholder="如 deploy" />
          </Form.Item>
          <Form.Item
            name="env"
            label="环境"
            rules={[{ required: true, message: '请输入环境' }]}
          >
            <Input placeholder="如 production" />
          </Form.Item>
          <Form.Item
            name="primaryApprovers"
            label="主审批人（钉钉用户 ID）"
          >
            <DingTalkUserSelect mode="multiple" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="backupApprovers"
            label="备用审批人（钉钉用户 ID）"
          >
            <DingTalkUserSelect mode="multiple" style={{ width: '100%' }} />
          </Form.Item>
          <Space>
            <Form.Item name="primaryTimeoutMin" label="主审批超时（分钟）">
              <Input type="number" min={1} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="totalTimeoutMin" label="总超时（分钟）">
              <Input type="number" min={1} style={{ width: 160 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}

// ─── Main Detail Page ─────────────────────────────────────────────────────────

export default function ProductLineDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [productLine, setProductLine] = useState<ProductLine | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      if (!id) return
      try {
        const list = await productLinesApi.list()
        const found = list.find((pl) => pl.id === Number(id))
        if (!found) {
          message.error('产品线不存在')
          navigate('/product-lines')
          return
        }
        setProductLine(found)
      } catch (err) {
        message.error(err instanceof Error ? err.message : '加载失败')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id, navigate])

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    )
  }

  if (!productLine) return null

  const numId = Number(id)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 12 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/product-lines')}>
          返回列表
        </Button>
        <Title level={4} style={{ margin: 0 }}>
          {productLine.displayName}
        </Title>
      </div>

      <Tabs
        defaultActiveKey="basic"
        items={[
          {
            key: 'basic',
            label: '基本信息',
            children: <BasicInfoTab productLine={productLine} />,
          },
          {
            key: 'projects',
            label: '项目',
            children: <ProjectsTab productLineId={numId} />,
          },
          {
            key: 'members',
            label: '成员',
            children: <MembersTab productLineId={numId} />,
          },
          {
            key: 'envs',
            label: '环境配置',
            children: <EnvConfigTab productLineId={numId} />,
          },
          {
            key: 'approval-rules',
            label: '审批规则',
            children: <ApprovalRulesTab productLineId={numId} />,
          },
        ]}
      />
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add web/src/components/DingTalkUserSelect.tsx web/src/pages/ProductLineListPage.tsx web/src/pages/ProductLineDetailPage.tsx
git commit -m "feat(web): add product line list/detail pages and DingTalkUserSelect"
```

---

## Task 7: Projects Page

**Files:**
- Create: `web/src/pages/ProjectsPage.tsx`

Table with product line filter dropdown. CRUD modal includes product line selector, GitLab path, Harbor project, and owner via DingTalkUserSelect.

- [ ] **Step 1: Write `web/src/pages/ProjectsPage.tsx`**

```typescript
import { useEffect, useState } from 'react'
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Space,
  Popconfirm,
  message,
  Typography,
} from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { projectsApi } from '../api/projects'
import { productLinesApi } from '../api/product-lines'
import DingTalkUserSelect from '../components/DingTalkUserSelect'
import type { Project, ProductLine } from '../types'

const { Title } = Typography

export default function ProjectsPage() {
  const [data, setData] = useState<Project[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [filterProductLineId, setFilterProductLineId] = useState<number | undefined>()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  async function loadProductLines() {
    try {
      setProductLines(await productLinesApi.list())
    } catch {
      // ignore
    }
  }

  async function load(productLineId?: number) {
    setLoading(true)
    try {
      setData(await projectsApi.list(productLineId))
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadProductLines()
    load()
  }, [])

  function handleFilterChange(value: number | undefined) {
    setFilterProductLineId(value)
    load(value)
  }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    if (filterProductLineId) {
      form.setFieldValue('productLineId', filterProductLineId)
    }
    setModalOpen(true)
  }

  function openEdit(record: Project) {
    setEditing(record)
    form.setFieldsValue({
      productLineId: record.productLineId,
      name: record.name,
      displayName: record.displayName,
      gitlabPath: record.gitlabPath,
      harborProject: record.harborProject,
      ownerId: record.ownerId,
      ownerName: record.ownerName,
      description: record.description,
    })
    setModalOpen(true)
  }

  async function handleDelete(id: number) {
    try {
      await projectsApi.remove(id)
      message.success('删除成功')
      await load(filterProductLineId)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        await projectsApi.update(editing.id, values)
        message.success('更新成功')
      } else {
        await projectsApi.create(values)
        message.success('创建成功')
      }
      setModalOpen(false)
      await load(filterProductLineId)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const productLineOptions = productLines.map((pl) => ({
    value: pl.id,
    label: pl.displayName,
  }))

  const getProductLineName = (id: number) =>
    productLines.find((pl) => pl.id === id)?.displayName ?? String(id)

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '显示名', dataIndex: 'displayName', key: 'displayName' },
    {
      title: '产品线',
      dataIndex: 'productLineId',
      key: 'productLineId',
      render: (v: number) => getProductLineName(v),
    },
    { title: 'GitLab 路径', dataIndex: 'gitlabPath', key: 'gitlabPath' },
    { title: 'Harbor 项目', dataIndex: 'harborProject', key: 'harborProject' },
    { title: '负责人', dataIndex: 'ownerName', key: 'ownerName' },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: Project) => (
        <Space>
          <Button type="link" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该项目？"
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space>
          <Title level={4} style={{ margin: 0 }}>
            项目管理
          </Title>
          <Select
            allowClear
            placeholder="筛选产品线"
            options={productLineOptions}
            value={filterProductLineId}
            onChange={handleFilterChange}
            style={{ width: 180 }}
          />
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建项目
        </Button>
      </div>

      <Table
        rowKey="id"
        dataSource={data}
        columns={columns}
        loading={loading}
        pagination={{ pageSize: 20 }}
      />

      <Modal
        title={editing ? '编辑项目' : '新建项目'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="productLineId"
            label="所属产品线"
            rules={[{ required: true, message: '请选择产品线' }]}
          >
            <Select
              placeholder="请选择产品线"
              options={productLineOptions}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item
            name="name"
            label="名称（英文标识）"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="如 payment-api" />
          </Form.Item>
          <Form.Item
            name="displayName"
            label="显示名"
            rules={[{ required: true, message: '请输入显示名' }]}
          >
            <Input placeholder="如 支付 API" />
          </Form.Item>
          <Form.Item name="gitlabPath" label="GitLab 路径">
            <Input placeholder="如 group/payment-api" />
          </Form.Item>
          <Form.Item name="harborProject" label="Harbor 项目">
            <Input placeholder="如 payment" />
          </Form.Item>
          <Form.Item name="ownerId" label="负责人">
            <DingTalkUserSelect
              style={{ width: '100%' }}
              placeholder="搜索负责人"
              onChange={(v) => {
                form.setFieldValue('ownerId', v)
              }}
            />
          </Form.Item>
          <Form.Item name="ownerName" label="负责人姓名">
            <Input placeholder="负责人姓名" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="项目描述（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/ProjectsPage.tsx
git commit -m "feat(web): add projects page with product line filter and CRUD modal"
```

---

## Task 8: Approval Rules Page

**Files:**
- Create: `web/src/pages/ApprovalRulesPage.tsx`

Standalone approval rules page (top-level, not inside product line detail). Shows all rules with product line filter. DingTalkUserSelect in multi-mode for approvers.

- [ ] **Step 1: Write `web/src/pages/ApprovalRulesPage.tsx`**

```typescript
import { useEffect, useState } from 'react'
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Space,
  Popconfirm,
  message,
  Typography,
  Tag,
} from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { approvalRulesApi } from '../api/approval-rules'
import { productLinesApi } from '../api/product-lines'
import DingTalkUserSelect from '../components/DingTalkUserSelect'
import type { ApprovalRule, ProductLine } from '../types'

const { Title } = Typography

export default function ApprovalRulesPage() {
  const [data, setData] = useState<ApprovalRule[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [filterProductLineId, setFilterProductLineId] = useState<number | undefined>()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ApprovalRule | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  async function loadProductLines() {
    try {
      setProductLines(await productLinesApi.list())
    } catch {
      // ignore
    }
  }

  async function load(productLineId?: number) {
    setLoading(true)
    try {
      setData(await approvalRulesApi.list(productLineId))
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadProductLines()
    load()
  }, [])

  function handleFilterChange(value: number | undefined) {
    setFilterProductLineId(value)
    load(value)
  }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      primaryApprovers: [],
      backupApprovers: [],
      primaryTimeoutMin: 10,
      totalTimeoutMin: 20,
    })
    if (filterProductLineId) {
      form.setFieldValue('productLineId', filterProductLineId)
    }
    setModalOpen(true)
  }

  function openEdit(record: ApprovalRule) {
    setEditing(record)
    form.setFieldsValue({
      productLineId: record.productLineId ?? undefined,
      action: record.action,
      env: record.env,
      primaryApprovers: record.primaryApprovers,
      backupApprovers: record.backupApprovers,
      primaryTimeoutMin: record.primaryTimeoutMin,
      totalTimeoutMin: record.totalTimeoutMin,
    })
    setModalOpen(true)
  }

  async function handleDelete(id: number) {
    try {
      await approvalRulesApi.remove(id)
      message.success('删除成功')
      await load(filterProductLineId)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const payload = {
        ...values,
        productLineId: values.productLineId ?? undefined,
        primaryApprovers: values.primaryApprovers ?? [],
        backupApprovers: values.backupApprovers ?? [],
        primaryTimeoutMin: Number(values.primaryTimeoutMin),
        totalTimeoutMin: Number(values.totalTimeoutMin),
      }
      if (editing) {
        await approvalRulesApi.update(editing.id, payload)
        message.success('更新成功')
      } else {
        await approvalRulesApi.create(payload)
        message.success('创建成功')
      }
      setModalOpen(false)
      await load(filterProductLineId)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const productLineOptions = productLines.map((pl) => ({
    value: pl.id,
    label: pl.displayName,
  }))

  const getProductLineName = (id: number | null) => {
    if (id == null) return <Tag>全局</Tag>
    return productLines.find((pl) => pl.id === id)?.displayName ?? String(id)
  }

  const columns = [
    {
      title: '产品线',
      dataIndex: 'productLineId',
      key: 'productLineId',
      render: (v: number | null) => getProductLineName(v),
    },
    { title: '动作', dataIndex: 'action', key: 'action' },
    { title: '环境', dataIndex: 'env', key: 'env' },
    {
      title: '主审批人',
      dataIndex: 'primaryApprovers',
      key: 'primaryApprovers',
      render: (v: string[]) =>
        v.length > 0
          ? v.map((u) => <Tag key={u}>{u}</Tag>)
          : <Tag color="default">无</Tag>,
    },
    {
      title: '备用审批人',
      dataIndex: 'backupApprovers',
      key: 'backupApprovers',
      render: (v: string[]) =>
        v.length > 0
          ? v.map((u) => <Tag key={u}>{u}</Tag>)
          : <Tag color="default">无</Tag>,
    },
    {
      title: '主超时',
      dataIndex: 'primaryTimeoutMin',
      key: 'primaryTimeoutMin',
      width: 90,
      render: (v: number) => `${v} 分钟`,
    },
    {
      title: '总超时',
      dataIndex: 'totalTimeoutMin',
      key: 'totalTimeoutMin',
      width: 90,
      render: (v: number) => `${v} 分钟`,
    },
    {
      title: '操作',
      key: 'ops',
      render: (_: unknown, record: ApprovalRule) => (
        <Space>
          <Button type="link" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该审批规则？"
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space>
          <Title level={4} style={{ margin: 0 }}>
            审批规则
          </Title>
          <Select
            allowClear
            placeholder="筛选产品线"
            options={productLineOptions}
            value={filterProductLineId}
            onChange={handleFilterChange}
            style={{ width: 180 }}
          />
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建规则
        </Button>
      </div>

      <Table
        rowKey="id"
        dataSource={data}
        columns={columns}
        loading={loading}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 900 }}
      />

      <Modal
        title={editing ? '编辑审批规则' : '新建审批规则'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="productLineId" label="产品线（留空表示全局规则）">
            <Select
              allowClear
              placeholder="全局规则（不限产品线）"
              options={productLineOptions}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item
            name="action"
            label="动作"
            rules={[{ required: true, message: '请输入动作' }]}
          >
            <Input placeholder="如 deploy / rollback" />
          </Form.Item>
          <Form.Item
            name="env"
            label="环境"
            rules={[{ required: true, message: '请输入环境名' }]}
          >
            <Input placeholder="如 production" />
          </Form.Item>
          <Form.Item name="primaryApprovers" label="主审批人">
            <DingTalkUserSelect
              mode="multiple"
              style={{ width: '100%' }}
              placeholder="搜索并选择主审批人"
            />
          </Form.Item>
          <Form.Item name="backupApprovers" label="备用审批人">
            <DingTalkUserSelect
              mode="multiple"
              style={{ width: '100%' }}
              placeholder="搜索并选择备用审批人"
            />
          </Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item
              name="primaryTimeoutMin"
              label="主审批超时（分钟）"
              rules={[{ required: true, message: '请输入' }]}
            >
              <Input type="number" min={1} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item
              name="totalTimeoutMin"
              label="总超时（分钟）"
              rules={[{ required: true, message: '请输入' }]}
            >
              <Input type="number" min={1} style={{ width: 180 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/ApprovalRulesPage.tsx
git commit -m "feat(web): add approval rules page with product line filter"
```

---

## Task 9: DingTalk Users Page

**Files:**
- Create: `web/src/pages/DingTalkUsersPage.tsx`

Read-only table with keyword search and a sync button. Sync button triggers `POST /admin/dingtalk/users/sync` and shows the number of upserted records.

- [ ] **Step 1: Write `web/src/pages/DingTalkUsersPage.tsx`**

```typescript
import { useEffect, useState, useCallback } from 'react'
import {
  Table,
  Button,
  Input,
  Space,
  Avatar,
  message,
  Typography,
  Tag,
  Tooltip,
} from 'antd'
import { SyncOutlined, SearchOutlined, UserOutlined } from '@ant-design/icons'
import { dingtalkUsersApi } from '../api/dingtalk-users'
import type { DingTalkUser } from '../types'

const { Title } = Typography
const { Search } = Input

export default function DingTalkUsersPage() {
  const [data, setData] = useState<DingTalkUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [keyword, setKeyword] = useState('')

  const load = useCallback(async (kw?: string) => {
    setLoading(true)
    try {
      const { users, total: t } = await dingtalkUsersApi.list(kw)
      setData(users)
      setTotal(t)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function handleSearch(value: string) {
    setKeyword(value)
    load(value || undefined)
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const result = await dingtalkUsersApi.sync()
      if (result.success) {
        message.success(`同步成功，共更新 ${result.upserted} 位用户`)
        await load(keyword || undefined)
      } else {
        message.error(`同步失败：${result.error}`)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '同步失败')
    } finally {
      setSyncing(false)
    }
  }

  const columns = [
    {
      title: '头像',
      key: 'avatar',
      width: 64,
      render: (_: unknown, record: DingTalkUser) =>
        record.avatar ? (
          <Avatar src={record.avatar} />
        ) : (
          <Avatar icon={<UserOutlined />} />
        ),
    },
    { title: '用户 ID', dataIndex: 'userId', key: 'userId', width: 160 },
    { title: '姓名', dataIndex: 'name', key: 'name', width: 120 },
    {
      title: '部门',
      dataIndex: 'department',
      key: 'department',
      render: (v: string) => (v ? <Tag>{v}</Tag> : '—'),
    },
    {
      title: '最后同步',
      dataIndex: 'syncedAt',
      key: 'syncedAt',
      render: (v: string) => (
        <Tooltip title={new Date(v).toLocaleString('zh-CN')}>
          {new Date(v).toLocaleDateString('zh-CN')}
        </Tooltip>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space align="center">
          <Title level={4} style={{ margin: 0 }}>
            钉钉用户
          </Title>
          <Typography.Text type="secondary">共 {total} 位</Typography.Text>
        </Space>
        <Space>
          <Search
            placeholder="搜索姓名"
            prefix={<SearchOutlined />}
            allowClear
            onSearch={handleSearch}
            style={{ width: 220 }}
          />
          <Button
            type="primary"
            icon={<SyncOutlined spin={syncing} />}
            loading={syncing}
            onClick={handleSync}
          >
            从钉钉同步
          </Button>
        </Space>
      </div>

      <Table
        rowKey="userId"
        dataSource={data}
        columns={columns}
        loading={loading}
        pagination={{
          pageSize: 50,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
        }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/DingTalkUsersPage.tsx
git commit -m "feat(web): add DingTalk users page with sync button"
```

---

## Task 10: Fastify Static Serving + Docker

**Files:**
- Update: `src/server.ts` — register `@fastify/static` to serve `web/dist/`
- Update: `Dockerfile` — multi-stage build that builds the frontend before the final image

- [ ] **Step 1: Install `@fastify/static` in the backend**

```bash
pnpm add @fastify/static
```

- [ ] **Step 2: Update `src/server.ts`**

Add static file serving after all API routes. Serve `web/dist/` as the root. All requests that don't match an API route fall through to `index.html` (SPA fallback).

The key is to register `@fastify/static` with `wildcard: false` and then add an explicit catch-all route that sends `index.html`. This ensures React Router handles client-side navigation.

```typescript
import Fastify from 'fastify'
import staticPlugin from '@fastify/static'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import 'dotenv/config'
import { registerAdminRoutes } from './admin/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: true })

// ─── Admin API routes ─────────────────────────────────────────────────────────
await app.register(registerAdminRoutes, { prefix: '/admin' })

// ─── Static SPA serving (production only) ────────────────────────────────────
const distPath = join(__dirname, '..', 'web', 'dist')

if (existsSync(distPath)) {
  await app.register(staticPlugin, {
    root: distPath,
    prefix: '/',
    wildcard: false,
  })

  // SPA fallback: all unmatched routes → index.html
  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile('index.html')
  })
}

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'

await app.listen({ port, host })
```

- [ ] **Step 3: Update `Dockerfile`**

Use a multi-stage build. Stage 1 (`builder`) builds the frontend with Node + Vite. Stage 2 installs backend production dependencies and copies the dist output.

```dockerfile
# ── Stage 1: build frontend ───────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /build/web

COPY web/package*.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# ── Stage 2: build backend deps ───────────────────────────────────────────────
FROM node:20-alpine AS backend-builder

WORKDIR /build

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── Stage 3: production image ─────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Install only production backend deps
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

# Copy compiled backend
COPY --from=backend-builder /build/dist ./dist

# Copy built frontend
COPY --from=frontend-builder /build/web/dist ./web/dist

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

- [ ] **Step 4: Build and test locally**

```bash
# Build the frontend
cd web && npm run build && cd ..

# Build the backend
pnpm build

# Start the server and verify the SPA loads
node dist/server.js
```

Open http://localhost:3000 — should serve the React SPA.
Open http://localhost:3000/admin/product-lines — should return JSON from the API.
Open http://localhost:3000/some-unknown-path — should serve `index.html` (SPA fallback).

- [ ] **Step 5: Build Docker image**

```bash
docker build -t chatops-admin:latest .
docker run --rm -p 3000:3000 --env-file .env chatops-admin:latest
```

- [ ] **Step 6: Commit**

```bash
git add src/server.ts Dockerfile
git commit -m "feat: serve admin SPA from Fastify with @fastify/static + multi-stage Dockerfile"
```

---

## Final Integration Check

- [ ] All pages render without TypeScript errors (`cd web && npx tsc --noEmit`)
- [ ] Dev server proxies `/admin` requests correctly
- [ ] Production build serves SPA with correct API fallback
- [ ] Docker image builds and runs
- [ ] All CRUD operations work end-to-end (create, read, update, delete)
- [ ] DingTalkUserSelect searches live data
- [ ] System config masks secrets in the UI
- [ ] Sync button on DingTalk users page triggers backend sync and refreshes list
