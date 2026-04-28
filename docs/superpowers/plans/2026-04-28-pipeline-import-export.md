# Pipeline Import/Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在流水线管理页面新增导出（下载 JSON 文件）和导入（上传 JSON 文件覆盖或新建）功能。

**Architecture:** 纯前端实现，零后端改动。导出直接从行数据构造 JSON 对象触发浏览器下载；导入通过隐藏 `<input type="file">` 读取文件，检查 `id` 是否存在后决定 PUT（覆盖）或 POST（新建），复用现有 API 函数。

**Tech Stack:** React 18, Ant Design 5, axios (via existing API layer)

---

## 涉及文件

| 文件 | 变更类型 |
|---|---|
| `web/src/pages/TestPipelinesPage.tsx` | 修改 |

---

### Task 1: 新增导出功能

**Files:**
- Modify: `web/src/pages/TestPipelinesPage.tsx`

- [ ] **Step 1: 更新 imports — 添加 `useRef`、`ExportOutlined` 和 `ChangeEvent`**

将文件头部 imports 改为：

```tsx
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Table, Button, Modal, Form, Input, Switch, Popconfirm, Space, Tag, message } from 'antd'
import { DeleteOutlined, EditOutlined, ExportOutlined, ImportOutlined, PartitionOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { getTestPipelines, getTestPipeline, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../api/test-pipelines'
import { triggerTestRun } from '../api/test-runs'
import type { TestPipeline } from '../types'
```

- [ ] **Step 2: 在组件内添加 `fileInputRef` 和 `importBusy` 状态**

在 `const [triggeringId, setTriggeringId] = useState<number | null>(null)` 之后添加：

```tsx
const [importBusy, setImportBusy] = useState(false)
const fileInputRef = useRef<HTMLInputElement>(null)
```

- [ ] **Step 3: 实现 `handleExport` 函数**

在 `handleTriggerRun` 函数之后添加：

```tsx
function handleExport(r: TestPipeline) {
  const exportFields = {
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    graph: r.graph,
    stages: r.stages,
    variables: r.variables,
    triggerParams: r.triggerParams,
    containerImage: r.containerImage,
    artifactInputs: r.artifactInputs,
    serverRoles: r.serverRoles,
    _exportedAt: new Date().toISOString(),
  }
  const json = JSON.stringify(exportFields, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const safeName = r.name.replace(/[^a-zA-Z0-9一-龥_]/g, '-')
  const a = document.createElement('a')
  a.href = url
  a.download = `pipeline-${r.id}-${safeName}.json`
  a.click()
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 4: 在操作列中添加「导出」按钮（运行和编辑之间）**

将 `columns` 中 `'操作'` 的 `render` 改为：

```tsx
render: (_: unknown, r: TestPipeline) => (
  <Space>
    <Popconfirm title="确认运行？" onConfirm={() => handleTriggerRun(r.id)}>
      <a style={{ opacity: triggeringId === r.id ? 0.5 : 1 }}>
        <PlayCircleOutlined /> 运行
      </a>
    </Popconfirm>
    <a onClick={() => handleExport(r)}>
      <ExportOutlined /> 导出
    </a>
    <a onClick={() => nav(`/test-pipelines/${r.id}/canvas`)}>
      <EditOutlined /> 编辑
    </a>
    <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}>
      <a style={{ color: 'red' }}>
        <DeleteOutlined /> 删除
      </a>
    </Popconfirm>
  </Space>
),
```

- [ ] **Step 5: 在浏览器中手动测试导出**

启动前端开发服务器（`cd web && pnpm dev`），打开流水线管理页，对任意一条流水线点击「导出」，验证：
- 浏览器弹出下载，文件名格式为 `pipeline-<id>-<name>.json`
- 文件内容包含 `id, name, description, enabled, graph, stages, variables, triggerParams, _exportedAt` 等字段

---

### Task 2: 新增导入功能

**Files:**
- Modify: `web/src/pages/TestPipelinesPage.tsx`

- [ ] **Step 1: 实现 `handleImportFile` 函数**

在 `handleExport` 函数之后添加：

```tsx
async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0]
  if (!file) return
  setImportBusy(true)
  try {
    const text = await file.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch (err) {
      message.error(`导入失败：JSON 解析错误 - ${(err as Error).message}`)
      return
    }
    if (!data.name) {
      message.error('导入失败：JSON 中缺少 name 字段')
      return
    }
    const payload: Partial<TestPipeline> = {
      name: data.name,
      description: data.description,
      enabled: data.enabled,
      graph: data.graph,
      stages: data.stages,
      variables: data.variables,
      triggerParams: data.triggerParams,
      containerImage: data.containerImage,
      artifactInputs: data.artifactInputs,
      serverRoles: data.serverRoles,
    }
    if (data.id) {
      try {
        await getTestPipeline(data.id)
        await updateTestPipeline(data.id, payload)
        message.success(`导入成功，已更新「${data.name}」`)
      } catch (err: any) {
        if (err?.response?.status === 404) {
          await createTestPipeline(payload)
          message.success(`导入成功，已创建「${data.name}」`)
        } else {
          message.error(`导入失败：${err?.response?.data?.error ?? err.message}`)
          return
        }
      }
    } else {
      try {
        await createTestPipeline(payload)
        message.success(`导入成功，已创建「${data.name}」`)
      } catch (err: any) {
        message.error(`导入失败：${err?.response?.data?.error ?? err.message}`)
        return
      }
    }
    await load()
  } finally {
    setImportBusy(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }
}
```

- [ ] **Step 2: 在 Card extra 中添加「导入 JSON」按钮**

将 `return` 中的 `<Card ...>` 的 `extra` 改为：

```tsx
extra={
  <Space>
    <Button
      icon={<ImportOutlined />}
      loading={importBusy}
      onClick={() => {
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
          fileInputRef.current.click()
        }
      }}
    >
      导入 JSON
    </Button>
    <Button type="primary" icon={<PartitionOutlined />} onClick={openCanvasCreate}>画布新建</Button>
  </Space>
}
```

- [ ] **Step 3: 在 JSX 末尾添加隐藏 file input**

在 `</Card>` 之前、`<Modal ...>` 之后添加：

```tsx
<input
  ref={fileInputRef}
  type="file"
  accept=".json"
  style={{ display: 'none' }}
  onChange={handleImportFile}
/>
```

- [ ] **Step 4: 在浏览器中手动测试导入**

用已导出的 JSON 文件测试：
1. **覆盖场景**：直接导入刚导出的文件（含 `id`），验证提示「已更新」
2. **新建场景**：删除 JSON 中的 `id` 字段后导入，验证提示「已创建」并出现新行
3. **错误场景**：导入一个内容为 `{not json}` 的文件，验证提示「JSON 解析错误」
4. **缺少 name 场景**：导入 `{"description":"test"}` 文件，验证提示「缺少 name 字段」

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/TestPipelinesPage.tsx
git commit -m "feat(frontend): 流水线管理列表新增导入/导出 JSON 功能"
```
