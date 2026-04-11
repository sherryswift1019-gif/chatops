# ChatOps Admin Configuration Backend — Design Spec

## Context

ChatOps 平台目前所有配置要么硬编码在代码中，要么只能通过直接操作数据库管理。需要开发一个配置管理后台，提供 Web 界面让管理员管理产线、项目、环境、审批规则、用户角色和系统集成凭证。

## 决策记录

| 维度 | 决定 |
|------|------|
| 前端 | React + Ant Design SPA，内嵌 Fastify（@fastify/static） |
| 认证 | 暂不做，内网部署 |
| 数据层级 | 产线 → 项目（微服务），产线隔离审批规则和角色 |
| 运行时 | 混合模式（Docker Compose + K8s，按产线/环境配置） |
| 钉钉集成 | 拉取用户列表用于选审批人 + 分配角色 |
| 配置存储 | 数据库驱动，支持热加载 |

---

## 数据模型

### 新增表

#### `product_lines` — 产线

```sql
CREATE TABLE IF NOT EXISTS product_lines (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  description   TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### `product_line_members` — 产线成员

```sql
CREATE TABLE IF NOT EXISTS product_line_members (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  user_name        TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('developer','ops','admin')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_line_id, user_id)
);
```

#### `projects` — 微服务项目

```sql
CREATE TABLE IF NOT EXISTS projects (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  name             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  gitlab_path      TEXT DEFAULT '',
  harbor_project   TEXT DEFAULT '',
  owner_id         TEXT DEFAULT '',
  owner_name       TEXT DEFAULT '',
  description      TEXT DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### `environments` — 环境定义（全局）

```sql
CREATE TABLE IF NOT EXISTS environments (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### `product_line_envs` — 产线 × 环境关联

```sql
CREATE TABLE IF NOT EXISTS product_line_envs (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  env_id           INT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  runtime          TEXT NOT NULL CHECK (runtime IN ('kubernetes','docker')),
  namespace        TEXT DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(product_line_id, env_id)
);
```

#### `dingtalk_users` — 钉钉用户缓存

```sql
CREATE TABLE IF NOT EXISTS dingtalk_users (
  user_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT DEFAULT '',
  department  TEXT DEFAULT '',
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### `system_config` — 系统键值配置

```sql
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 现有表变更

#### `approval_rules` — 增加 `product_line_id`

```sql
ALTER TABLE approval_rules ADD COLUMN product_line_id INT REFERENCES product_lines(id) ON DELETE CASCADE;
```

现有 approval_rules 仓库需增加 UPDATE 和 DELETE 操作。

---

## 后端 API

所有管理接口在 `/admin` 前缀下。请求/响应均为 JSON。

### 产线管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/product-lines` | 产线列表 |
| POST | `/admin/product-lines` | 创建产线 |
| PUT | `/admin/product-lines/:id` | 更新产线 |
| DELETE | `/admin/product-lines/:id` | 删除产线（级联删除关联数据） |
| GET | `/admin/product-lines/:id/members` | 成员列表 |
| POST | `/admin/product-lines/:id/members` | 添加成员（userId + role） |
| PUT | `/admin/product-lines/:id/members/:memberId` | 修改成员角色 |
| DELETE | `/admin/product-lines/:id/members/:memberId` | 移除成员 |
| GET | `/admin/product-lines/:id/envs` | 产线环境配置列表 |
| PUT | `/admin/product-lines/:id/envs` | 批量更新产线环境配置 |

### 项目管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/projects?product_line_id=` | 项目列表（按产线过滤） |
| POST | `/admin/projects` | 创建项目 |
| PUT | `/admin/projects/:id` | 更新项目 |
| DELETE | `/admin/projects/:id` | 删除项目 |

### 环境管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/environments` | 全局环境列表 |
| POST | `/admin/environments` | 创建环境 |
| PUT | `/admin/environments/:id` | 更新环境 |
| DELETE | `/admin/environments/:id` | 删除环境 |

### 审批规则

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/approval-rules?product_line_id=` | 规则列表（按产线过滤） |
| POST | `/admin/approval-rules` | 创建规则 |
| PUT | `/admin/approval-rules/:id` | 更新规则 |
| DELETE | `/admin/approval-rules/:id` | 删除规则 |

### 钉钉用户

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/dingtalk/users?keyword=` | 用户列表（支持搜索） |
| POST | `/admin/dingtalk/users/sync` | 手动触发从钉钉同步用户 |

同步流程：使用钉钉 OpenAPI 递归获取所有部门 → 遍历部门获取成员 → 写入 `dingtalk_users` 表。

### 系统配置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/system-config` | 所有配置 |
| PUT | `/admin/system-config/:key` | 更新某项配置 |

预定义配置键：

| key | 说明 | value 结构 |
|-----|------|-----------|
| `dingtalk` | 钉钉机器人配置 | `{ clientId, clientSecret }` |
| `gitlab` | GitLab 配置 | `{ url, token }` |
| `harbor` | Harbor 配置 | `{ url, username, password }` |
| `claude` | Claude 配置 | `{ apiKey, model }` |

GET 响应中密钥类字段脱敏（只返回后 4 位）。PUT 时如果字段值为空字符串则不更新（保留旧值）。

---

## 前端 SPA

### 技术栈

- React 18 + TypeScript
- Ant Design 5（组件库）
- React Router（路由）
- 构建工具：Vite
- 目录：`web/`（与 `src/` 同级）
- 构建产物：`web/dist/`，通过 `@fastify/static` 提供

### 页面结构

左侧菜单 + 右侧内容区，Ant Design ProLayout 风格。

```
📋 产线管理
  ├── 产线列表          — 表格 + 创建按钮
  └── 产线详情          — Tab 页切换
       ├── 基本信息      — 编辑表单
       ├── 项目列表      — 该产线的微服务列表
       ├── 成员管理      — 成员表格 + 添加（钉钉用户选择器）
       ├── 环境配置      — 该产线启用的环境 + 运行时配置
       └── 审批规则      — 该产线的审批规则列表

📦 项目管理
  └── 项目列表          — 全局视图，支持按产线筛选

🌍 环境管理
  └── 环境列表          — 全局环境定义

👥 用户管理
  ├── 钉钉用户          — 用户列表 + 同步按钮
  └── 角色分配          — 按产线查看/编辑成员角色

✅ 审批规则
  └── 规则列表          — 全局视图，按产线筛选

⚙️ 系统配置
  ├── 钉钉配置
  ├── GitLab 配置
  ├── Harbor 配置
  └── Claude 配置
```

### 关键组件

**DingTalkUserSelect** — 钉钉用户选择器
- Ant Design `Select` + `showSearch` + 远程搜索
- 选项显示头像 + 姓名 + 部门
- 支持多选（用于审批人配置）
- 数据来源：`GET /admin/dingtalk/users?keyword=`

**ProductLineDetail** — 产线详情页
- Ant Design `Tabs` 组件
- 5 个 Tab 页，每个独立加载数据
- URL 路由：`/product-lines/:id?tab=members`

**SystemConfigForm** — 系统配置表单
- 按配置分组（钉钉/GitLab/Harbor/Claude）
- 密钥字段用 `Input.Password` + placeholder 显示脱敏值
- 保存时只提交有变化的字段

---

## 钉钉用户同步

### 同步流程

1. 从 `system_config` 表读取钉钉 `clientId` 和 `clientSecret`
2. 获取 access token：`POST https://api.dingtalk.com/v1.0/oauth2/accessToken`
3. 获取根部门下所有子部门 ID：`POST /v1.0/contact/departments/listSubDepartmentIds`（递归）
4. 对每个部门获取成员：`POST /v1.0/contact/users/listByDepartment`
5. 去重后 UPSERT 到 `dingtalk_users` 表
6. 返回同步数量

### 复用现有能力

DingTalk adapter 已有获取 access token 的方法（`dingtalk.ts:204-221`），同步模块可以复用同样的 token 获取逻辑。

---

## 系统配置热加载

### 设计

- **启动必需项**（`DATABASE_URL`、`PORT`）仍从环境变量，`config.ts` 不变
- **业务配置**（GitLab/Harbor/钉钉/Claude）改为从 `system_config` 表动态读取
- 新增 `src/db/repositories/system-config.ts`：提供 `getConfig(key)` / `setConfig(key, value)` / `getAllConfig()`
- Agent 工具在执行时调用 `getConfig('gitlab')` 获取最新值，而非引用 `config.ts` 的静态值
- 首次部署时，如果 `system_config` 表为空且环境变量有值，自动迁移到数据库

### 影响范围

需要修改的现有文件：
- `src/agent/tools/list-images.ts` — Harbor 凭证改为从 system_config 读取
- `src/agent/tools/get-gitlab-commits.ts` — GitLab URL/Token 改为从 system_config 读取
- `src/agent/claude-runner.ts` — Claude model 改为从 system_config 读取
- `src/adapters/im/dingtalk.ts` — 如果需要支持运行时修改钉钉凭证（可选，因为改凭证需要重连 WebSocket）

---

## 文件结构

```
src/
  admin/
    routes/
      product-lines.ts      # 产线 CRUD + 成员/环境子路由
      projects.ts            # 项目 CRUD
      environments.ts        # 环境 CRUD
      approval-rules.ts      # 审批规则 CRUD
      dingtalk-users.ts      # 用户列表 + 同步触发
      system-config.ts       # 系统配置读写
    index.ts                 # 注册所有 admin 路由到 Fastify
  db/
    repositories/
      product-lines.ts       # 产线仓库
      product-line-members.ts
      projects.ts            # 项目仓库（新）
      environments.ts        # 环境仓库（新）
      product-line-envs.ts
      dingtalk-users.ts
      system-config.ts
    schema-v2.sql            # 新增表的 DDL

web/
  package.json               # React + Ant Design + Vite
  vite.config.ts
  src/
    main.tsx
    App.tsx
    api/                     # API 调用封装
      client.ts              # axios 实例
      product-lines.ts
      projects.ts
      environments.ts
      approval-rules.ts
      dingtalk-users.ts
      system-config.ts
    pages/
      ProductLines/
        List.tsx
        Detail.tsx
      Projects/
        List.tsx
      Environments/
        List.tsx
      Users/
        DingTalkUsers.tsx
        RoleManagement.tsx
      ApprovalRules/
        List.tsx
      SystemConfig/
        index.tsx
    components/
      DingTalkUserSelect.tsx  # 钉钉用户选择器
      Layout.tsx              # 侧边栏布局
```

---

## 验证

### 后端验证
```bash
# TypeScript 编译
npx tsc --noEmit

# 单元测试
pnpm test

# API 冒烟测试
curl http://localhost:3000/admin/product-lines
curl -X POST http://localhost:3000/admin/product-lines -H 'Content-Type: application/json' -d '{"name":"pam","displayName":"PAM"}'
curl http://localhost:3000/admin/system-config
```

### 前端验证
```bash
cd web && pnpm dev   # 开发模式
cd web && pnpm build # 构建
# 访问 http://localhost:3000/admin 查看管理页面
```

### 集成验证
```bash
# Docker 部署后
docker compose up -d --build
curl http://localhost:3000/admin/product-lines
# 浏览器访问 http://localhost:3000/admin
```
