# 服务器与环境配置统一设计

## 1. 背景与动机

### 问题

当前平台中，服务器连接信息在两处维护：

1. **ProductLineEnv（产线环境配置）**：Docker 模式下存储 `host`、`username`、`password` 在 `connection_config` JSONB 中
2. **TestServer（测试服务器）**：独立表存储 `host`、`port`、`username`、`credential`、`auth_type`、`role`、`status`

两者数据高度重叠，但 TestServer 功能更完整（角色分组、状态管理、密钥认证、连接测试），而 ProductLineEnv 的 Docker 连接配置是 TestServer 的简陋子集。

### 目标

TestServer 作为**统一服务器注册表**，ProductLineEnv 的 Docker 模式改为**引用 TestServer**，消除重复。

## 2. 设计方案

### 2.1 数据模型变更

**ProductLineEnv 表变更：**

Docker 模式下，`connection_config` 从存储连接信息改为存储 TestServer 引用：

```
// 旧（Docker 模式）
connection_config: { "host": "192.168.1.100", "username": "root", "password": "***" }

// 新（Docker 模式）
connection_config: { "serverIds": [3, 7, 12] }
```

K8s 模式保持不变：
```
connection_config: { "namespace": "pam-prod" }
```

**TestServer 表不变**，现有字段已足够。`role` 字段自由输入，可以是 `db`、`app`、`test`、`deploy` 等任意值。

### 2.2 前端 UI 变更

**产线详情页 - 环境配置 Tab：**

Docker 模式下：
- **移除**：手动输入 host、username、password 的表单
- **替换为**：从该产线的 TestServer 列表中多选服务器（Select mode="multiple"），展示 `名称 (host) - 角色`

K8s 模式下：保持现有 namespace 输入不变。

**测试服务器管理：**

保持现有 TestServersPage 不变。它是服务器的统一管理入口。

### 2.3 后端 API 变更

**ProductLineEnv 保存逻辑**：Docker 模式下验证 `serverIds` 中的服务器属于当前产线。

**AI Agent 部署流程**：
- 当前：从 ProductLineEnv 的 `connection_config` 获取连接信息
- 改为：从 `connection_config.serverIds` 查询 TestServer 记录获取连接信息

### 2.4 数据迁移

对于已有的 Docker 模式 ProductLineEnv 记录：
1. 根据 `connection_config.host` 在 TestServer 中查找匹配的服务器
2. 如果找到，替换为 `{ "serverIds": [matchedId] }`
3. 如果未找到，自动创建 TestServer 记录，再引用

## 3. 影响范围

### 需要修改的文件

**前端：**
- `web/src/pages/ProductLineDetailPage.tsx` — EnvConfigTab 中 Docker 模式的表单改为服务器选择器
- `web/src/types/index.ts` — 更新 ProductLineEnv 的 connectionConfig 类型

**后端：**
- `src/db/repositories/product-line-envs.ts` — 保存/读取逻辑适配新格式
- `src/admin/routes/product-lines.ts` — 环境配置 API 验证逻辑

**Agent 层（如果有直接读取 connectionConfig 的地方）：**
- 需要检查 `src/agent/` 下是否有代码直接从 connectionConfig 读取 host/username/password

## 4. 验证方式

1. 产线详情页 → 环境配置 Tab → 选择 Docker 运行时 → 确认显示服务器多选器而非手动输入
2. 选择服务器后保存 → 重新打开确认回填正确
3. K8s 模式不受影响，仍显示 namespace 输入
4. Pipeline 执行不受影响（Pipeline 直接用 TestServer，不经过 ProductLineEnv）
