# 流水线导入/导出功能设计

**日期**：2026-04-28  
**状态**：已批准

---

## 背景

TestPipelinesPage 目前只能通过画布新建流水线。需要支持将流水线配置以 JSON 文件导出、并从 JSON 文件导入（有 id 则覆盖，无 id 则新建），便于备份、迁移和批量生成场景。

---

## 范围

- **纯前端实现**，零后端改动，复用现有 API：
  - `GET /admin/test-pipelines/:id`
  - `POST /admin/test-pipelines`
  - `PUT /admin/test-pipelines/:id`
- 改动文件：`web/src/pages/TestPipelinesPage.tsx`（单文件）

---

## 功能设计

### 1. 导出

**入口**：操作列，排在「运行」和「编辑」之间，新增「导出」按钮（`ExportOutlined` 图标）。

**行为**：
1. 从当前行数据中取以下字段构造导出对象：
   ```
   id, name, description, enabled, graph, stages,
   variables, triggerParams, containerImage, artifactInputs, serverRoles
   ```
2. 附加元数据字段 `_exportedAt: new Date().toISOString()`。
3. `JSON.stringify(..., null, 2)` 序列化。
4. 通过动态创建 `<a download>` 触发浏览器下载。
5. 文件名：`pipeline-<id>-<safeName>.json`，其中 `safeName` 将空格和非法文件名字符替换为 `-`。

**不需要额外网络请求**（列表已含全部字段）。

---

### 2. 导入

**入口**：Card 头部右侧，与「画布新建」并列，新增「导入 JSON」按钮（`ImportOutlined` 图标）。

**实现**：
- 按钮点击触发一个隐藏的 `<input type="file" accept=".json">` 的 `.click()`，通过 `useRef` 持有引用，组件 unmount 时无需清理。
- 每次点击前将 input value 清空，保证同一文件可反复导入。

**导入流程**：
```
读取 File → FileReader.readAsText → JSON.parse
  → 校验 name 字段存在
  → 有 id 字段？
      是 → GET /test-pipelines/:id
               200 → PUT /test-pipelines/:id   （覆盖）
               404 → POST /test-pipelines       （新建，忽略 id）
      否 → POST /test-pipelines                 （新建）
  → 成功：message.success + load()
  → 失败：message.error（含具体原因）
```

**PUT 覆盖时传入的字段**（不传 `id`、`productLineId`、时间戳）：
```
name, description, enabled, graph, stages,
variables, triggerParams, containerImage, artifactInputs, serverRoles
```

**POST 新建时传入的字段**（同上，`productLineId` 不传，后端默认 null = 全局流水线）：
```
name, description, enabled, graph, stages,
variables, triggerParams, containerImage, artifactInputs, serverRoles
```

**错误处理**：
| 情形 | 提示 |
|---|---|
| 文件解析失败（非合法 JSON） | `导入失败：JSON 解析错误 - <原始错误>` |
| 缺少 `name` 字段 | `导入失败：JSON 中缺少 name 字段` |
| API 返回错误 | `导入失败：<api error message>` |
| 成功（新建） | `导入成功，已创建「<name>」` |
| 成功（覆盖） | `导入成功，已更新「<name>」` |

---

## 不纳入范围

- 批量多文件导入/导出
- 导入前预览/确认 Modal
- `productLineId` 随导入迁移（新建时不绑产线）
- 后端新增任何接口

---

## 涉及文件

| 文件 | 变更类型 |
|---|---|
| `web/src/pages/TestPipelinesPage.tsx` | 修改（新增导出按钮、导入按钮及逻辑） |
