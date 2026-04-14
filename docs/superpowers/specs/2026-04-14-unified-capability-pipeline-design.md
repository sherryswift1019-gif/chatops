# 统一能力体系与流水线阶段重构设计

## 1. 背景与动机

### 问题

当前测试流水线的阶段配置存在以下问题：

1. **阶段类型边界模糊**：cleanup 和 custom 都是执行命令，download + install 总是成对出现，类型划分不自然
2. **参数过于固定**：test 阶段强制 git clone + pytest，install 强制特定配置文件格式，无法适配不同产品线
3. **类型太多且认知负担重**：7 种类型用户容易混淆，且前端只提供一个 JSON textarea，用户不知道该填什么
4. **缺少必要能力**：无法满足容器部署、文件传输、日志收集等常见需求
5. **层级划分不合理**：现有阶段是底层操作步骤（下载、安装），而用户思考的是高层意图（部署最新版本）
6. **与 AI Agent 能力体系割裂**：AI Agent 侧的 capabilities（deploy、rollback 等）和流水线侧的 stage types 是两套独立的概念，存在重复定义

### 目标

采用 **Agent → Skills → Tools** 三层架构，统一 AI Agent 和测试流水线的能力体系：

- **Tools**：原子操作，可被 Claude 直接调用
- **Capabilities (Skills)**：统一能力定义，同时服务对话模式和流水线模式
- **Pipeline**：给 Claude 的结构化执行计划，Claude 作为智能执行引擎

## 2. 架构设计

### 2.1 统一执行模型

Claude 是唯一的执行引擎。对话模式和流水线模式共享同一套能力和工具：

```
对话模式                        流水线模式
  用户自然语言请求                结构化执行计划 + 预填参数
        ↘                              ↙
          Claude (统一执行引擎)
          理解意图 → 选择能力 → 调用工具 → 智能容错
                      ↓
          Capabilities (统一能力层)
                      ↓
            Tools (统一工具层)
```

**流水线执行时 Claude 的行为：**
- 按照流水线定义的阶段顺序执行
- 每个阶段提供能力类型、参数和推荐步骤（playbook）
- 正常时按 playbook 执行
- 失败时自主分析日志、诊断问题、尝试修复
- 如果无法修复，按 onFailure 策略处理（停止/继续）

### 2.2 三层架构

```
┌─────────────────────────────────────────────┐
│  Pipeline (结构化执行计划)                      │
│  stages: [{ capabilityKey, params, ... }]    │
└─────────────────┬───────────────────────────┘
                  ↓
┌─────────────────────────────────────────────┐
│  Capabilities (统一能力层)                      │
│  每个能力声明：可用 tools + playbook + paramSchema │
│  同时服务 AI Agent 对话和 Pipeline 执行          │
└─────────────────┬───────────────────────────┘
                  ↓
┌─────────────────────────────────────────────┐
│  Tools (统一工具层)                             │
│  业务工具 (现有) + 基础设施工具 (新增 6 个)        │
│  全部注册为 Agent Tools，Claude 可直接调用       │
└─────────────────────────────────────────────┘
```

## 3. Tools 层设计

### 3.1 新增 6 个基础设施工具

与现有的业务工具（execute_deploy、get_logs 等）并列注册为 Agent Tools：

| key | 名称 | 说明 |
|-----|------|------|
| `ssh_exec` | 远程命令执行 | 通过 SSH 在远程服务器执行命令或脚本 |
| `file_transfer` | 文件传输 | SCP/SFTP 在服务器间上传/下载文件 |
| `http_probe` | 网络探测 | HTTP/TCP 连通性检查，支持重试 |
| `http_download` | HTTP 下载 | 从 URL 下载文件，支持校验和与自动解压 |
| `docker_op` | 容器镜像操作 | docker pull、docker compose 等容器操作 |
| `file_read` | 远程文件读取 | 读取远程服务器上的日志/文件内容 |

### 3.2 数据库表

```sql
CREATE TABLE IF NOT EXISTS pipeline_tools (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  param_schema JSONB NOT NULL DEFAULT '{}',  -- JSON Schema
  is_system   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

系统预置 6 条记录，用户不可创建/删除（第一阶段）。

## 4. Capabilities 层设计

### 4.1 表结构扩展

在现有 `capabilities` 表上新增字段：

```sql
ALTER TABLE capabilities
  ADD COLUMN param_schema   JSONB DEFAULT '{}',
  ADD COLUMN playbook       JSONB DEFAULT '[]',
  ADD COLUMN is_system      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN updated_at     TIMESTAMPTZ DEFAULT NOW();

-- 扩展 category 约束
ALTER TABLE capabilities
  DROP CONSTRAINT IF EXISTS capabilities_category_check,
  ADD CONSTRAINT capabilities_category_check
    CHECK (category IN ('query', 'action', 'admin', 'env_prep', 'verify', 'testing', 'result'));
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `param_schema` | JSONB | JSON Schema，前端据此动态渲染参数表单 |
| `playbook` | JSONB | 推荐执行步骤，Claude 作为参考但可灵活应变 |
| `is_system` | BOOLEAN | 系统预置（true）vs 未来用户自定义（false） |
| `updated_at` | TIMESTAMPTZ | 更新时间 |

### 4.2 完整能力清单

#### 现有能力（保持，扩展 tool_names）

| category | key | 名称 | tool_names | 变更 |
|----------|-----|------|-----------|------|
| query | `view_deployments` | 查看部署状态 | query_deployments | 不变 |
| query | `view_images` | 查看镜像列表 | list_images | 不变 |
| query | `view_logs` | 查看日志 | get_logs | 不变 |
| query | `view_commits` | 查看提交记录 | get_gitlab_commits | 不变 |
| action | `deploy` | 部署服务 | execute_deploy, **ssh_exec, http_download, docker_op** | 扩展 tools，新增 param_schema 和 playbook |
| action | `rollback` | 回滚服务 | execute_rollback, **ssh_exec** | 扩展 |
| action | `restart` | 重启服务 | execute_restart, **ssh_exec** | 扩展 |
| admin | `manage_role` | 管理角色 | manage_role | 不变 |

#### 新增能力

| category | key | 名称 | tool_names |
|----------|-----|------|-----------|
| env_prep | `env_init` | 环境初始化 | ssh_exec, file_transfer |
| env_prep | `env_cleanup` | 环境清理 | ssh_exec |
| verify | `health_check` | 健康检查 | http_probe, ssh_exec |
| testing | `auto_test` | 自动化测试 | ssh_exec, file_transfer |
| result | `log_collect` | 日志收集 | file_read, file_transfer |
| result | `report_gen` | 报告生成 | （内置系统能力） |
| action | `custom_script` | 自定义脚本 | ssh_exec |

### 4.3 各能力参数详细定义

#### env_init 环境初始化

适用场景：在新机器上从零搭建运行环境。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `commands` | textarea | 否* | shell 命令，每行一条。**支持变量** |
| `script` | string | 否* | 脚本路径（可带参数），如 `/opt/scripts/init.sh -f` |

> *commands 和 script 至少填一个。执行顺序：commands → script。

#### env_cleanup 环境清理

适用场景：在已有环境上清理旧版本、停服务，为重新部署做准备。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `commands` | textarea | 否* | shell 命令，每行一条。**支持变量** |
| `script` | string | 否* | 脚本路径（可带参数） |

> *commands 和 script 至少填一个。

#### deploy 部署服务

适用场景：下载并安装软件包，或拉取容器镜像并启动。

**公共参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `deployType` | select | 是 | `package`（软件包）/ `container`（容器） |

**deployType = package 时：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packageUrl` | string | 是 | 部署包下载地址。**支持变量**，如 `https://releases.example.com/{{branch}}/app-{{version}}.tar.gz` |
| `downloadDir` | string | 是 | 下载目录 |
| `checksum` | string | 否 | 校验和，格式 `algo:hash`，如 `md5:abc123` |
| `extract` | boolean | 否 | 是否自动解压（默认 true） |
| `silentConfig` | textarea | 否 | silent 安装配置文件**内容**。**支持变量**，如 `DB_HOST={{servers.db[0].host}}` |
| `installScript` | string | 否 | 安装脚本（可带参数），如 `/opt/app/install.sh -s` |
| `commands` | textarea | 否 | 安装命令 |

**deployType = container 时：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `image` | string | 是 | 镜像地址。**支持变量**，如 `harbor.example.com/project/{{imageName}}:{{imageTag}}` |
| `action` | select | 是 | `pull` / `compose_up` |
| `composeFile` | string | 否 | Compose 文件路径 |
| `commands` | textarea | 否 | 启动命令 |

#### rollback 回滚服务

适用场景：部署失败后回滚到上一个稳定版本。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `commands` | textarea | 否* | 回滚命令 |
| `script` | string | 否* | 回滚脚本（可带参数） |

#### restart 重启服务

适用场景：重启指定服务。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `commands` | textarea | 否* | 重启命令 |
| `script` | string | 否* | 重启脚本（可带参数） |

#### health_check 健康检查

适用场景：验证服务部署后是否正常运行。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `checkType` | select | 是 | `http` / `tcp` / `command` |
| `target` | string | 是 | 检查目标。**支持变量**，如 `http://{{servers.app[0].host}}:8080/health` |
| `intervalSeconds` | number | 否 | 检查间隔（秒），默认 5 |
| `maxRetries` | number | 否 | 最大重试次数，默认 10 |
| `expectedStatus` | number | 否 | HTTP 期望状态码，默认 200 |

#### auto_test 自动化测试

适用场景：拉取测试代码、执行测试、收集结果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `gitRepo` | string | 是 | Git 仓库地址。**支持变量** |
| `branch` | string | 是 | 分支名。**支持变量** |
| `workDir` | string | 是 | 工作目录 |
| `command` | textarea | 是 | 测试命令。**支持变量** |
| `collectArtifacts` | string[] (tags) | 否 | 收集制品的路径列表 |

#### log_collect 日志收集

适用场景：从目标服务器收集日志文件用于分析。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `logPaths` | string[] (tags) | 是 | 日志文件路径列表 |
| `grepKeywords` | string[] (tags) | 否 | 过滤关键词 |
| `maxLines` | number | 否 | 最大读取行数，默认 1000 |

#### report_gen 报告生成

适用场景：流水线执行完毕后生成汇总报告。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `format` | select | 否 | 报告格式，目前仅 `html` |
| `includeStageLogs` | boolean | 否 | 是否包含各阶段日志，默认 true |

#### custom_script 自定义脚本

适用场景：执行任意自定义命令或脚本。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `commands` | textarea | 否* | 执行命令。**支持变量** |
| `script` | string | 否* | 脚本路径（可带参数） |

## 5. 变量系统

### 5.1 变量语法

所有标注"支持变量"的参数字段使用 `{{variableName}}` 语法。

### 5.2 变量来源

| 来源 | 示例 | 解析时机 |
|------|------|---------|
| **触发时参数** | `{{branch}}`, `{{version}}` | 用户触发流水线时填写，或 AI 对话时提供 |
| **服务器上下文** | `{{servers.app[0].host}}`, `{{servers.db[0].host}}` | 运行时从服务器分配中解析 |
| **AI 对话上下文** | `{{dbHost}}`, `{{configMode}}` | Claude 在执行过程中从对话上下文获取 |

### 5.3 Pipeline 触发参数

`test_pipelines` 表新增 `trigger_params` 字段，定义流水线触发时需要用户提供的变量：

```json
{
  "branch": { "type": "string", "label": "代码分支", "default": "main", "required": true },
  "version": { "type": "string", "label": "版本号", "required": true }
}
```

触发流水线时，前端根据此 schema 渲染输入表单。

## 6. Pipeline 定义格式

### 6.1 StageDefinition 结构变更

```typescript
// 旧
interface StageDefinition {
  name: string
  type: StageType  // 'cleanup' | 'download' | ...
  params: Record<string, unknown>  // 无 schema 的 JSON
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  onFailure: 'stop' | 'continue'
}

// 新
interface StageDefinition {
  name: string
  capabilityKey: string  // 引用 capabilities.key
  params: Record<string, unknown>  // 由 capability.param_schema 约束
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  onFailure: 'stop' | 'continue'
}
```

### 6.2 test_pipelines 表变更

```sql
ALTER TABLE test_pipelines
  ADD COLUMN trigger_params JSONB DEFAULT '{}';

-- stages JSONB 内部结构变更：type → capabilityKey
-- 需要数据迁移脚本
```

### 6.3 Pipeline 执行时 Claude 收到的上下文示例

```
你正在执行流水线「全量回归测试」的第 3 阶段「部署 App 服务」。

能力: deploy
参数: {
  deployType: "package",
  packageUrl: "https://releases.example.com/main/app-2.3.0.tar.gz",
  downloadDir: "/opt/downloads",
  silentConfig: "DB_HOST=192.168.1.20\nDB_PORT=5432\nAPP_MODE=test",
  installScript: "/opt/app/install.sh -s"
}
目标服务器: app 角色 [192.168.1.10, 192.168.1.11]
可用工具: http_download, ssh_exec

推荐步骤 (playbook):
1. 使用 http_download 下载部署包到 downloadDir
2. 将 silentConfig 内容写入配置文件
3. 使用 ssh_exec 执行 installScript

如果执行失败，请使用 file_read 分析日志，诊断问题并尝试修复。
如果无法修复，标记阶段失败（onFailure: stop）。
```

## 7. 前端 UI 设计

### 7.1 能力选择器

使用 Ant Design Select 按 category 分组：

```
环境准备
  🏗 环境初始化 (env_init)
  🧹 环境清理 (env_cleanup)
操作
  🚀 部署服务 (deploy)
  ↩️ 回滚服务 (rollback)
  🔄 重启服务 (restart)
  ⚡ 自定义脚本 (custom_script)
验证
  ✅ 健康检查 (health_check)
测试
  🧪 自动化测试 (auto_test)
结果处理
  📄 日志收集 (log_collect)
  📊 报告生成 (report_gen)
```

查询类能力（view_*）和管理类能力（manage_role）不出现在流水线选择器中。

### 7.2 阶段配置卡片结构

每个阶段卡片分为三个区域：

1. **基本信息行**：阶段名称 + 能力选择器 + 目标角色
2. **通用控制行**：超时 + 重试次数 + 失败策略 + 并行执行
3. **能力参数区**（动态）：根据选中能力的 `param_schema` 渲染对应表单字段

### 7.3 动态参数渲染

前端从 capabilities API 获取 `param_schema`（JSON Schema），根据字段类型映射到 Ant Design 组件：

| JSON Schema type | Ant Design 组件 |
|------------------|----------------|
| `string` | Input |
| `string` (format: textarea) | Input.TextArea |
| `number` | InputNumber |
| `boolean` | Switch |
| `string` (enum) | Select |
| `string[]` | Select mode="tags" |

### 7.4 能力切换行为

当用户切换能力类型时，清空该阶段的 params（避免旧字段残留）。

## 8. 数据迁移

### 8.1 旧 StageType → 新 capabilityKey 映射

| 旧 type | 新 capabilityKey | 说明 |
|---------|-----------------|------|
| `cleanup` | `env_cleanup` | 直接映射 |
| `download` + `install` | `deploy` (deployType=package) | 合并为一个 deploy 阶段 |
| `health_check` | `health_check` | 直接映射 |
| `test` | `auto_test` | 直接映射 |
| `report` | `report_gen` | 直接映射 |
| `custom` | `custom_script` | 直接映射 |

### 8.2 迁移策略

编写迁移脚本处理 `test_pipelines.stages` JSONB 中的 `type` → `capabilityKey` 转换，同时重新组织 params 字段结构。

## 9. 影响范围

### 需要修改的文件

**数据库层：**
- `src/db/schema-v3.sql` → 新增 pipeline_tools 表，扩展 capabilities 表
- `src/db/repositories/capabilities.ts` → 扩展查询
- `src/db/repositories/test-pipelines.ts` → 适配新的 stages 结构

**后端：**
- `src/pipeline/types.ts` → 重新定义类型
- `src/pipeline/executor.ts` → 重构为 Claude 驱动的执行模型
- `src/pipeline/stages/*` → 重构为 Tool 执行器
- `src/admin/routes/capabilities.ts` → 扩展 API
- `src/admin/routes/test-pipelines.ts` → 适配新结构

**前端：**
- `web/src/pages/TestPipelinesPage.tsx` → 重构阶段配置 UI
- `web/src/pages/CapabilitiesPage.tsx` → 展示新增字段
- `web/src/types/index.ts` → 更新类型定义
- `web/src/api/capabilities.ts` → 适配新字段

## 10. 验证方式

1. 启动前端开发服务器，打开流水线管理页
2. 新建流水线，验证能力选择器按分组展示
3. 选择每种能力，确认动态参数表单正确渲染
4. 切换能力类型，确认旧参数清空
5. 填写变量语法（如 `{{branch}}`），确认提交正常
6. deploy 能力：切换软件包/容器模式，确认参数表单切换
7. 编辑已有流水线，确认参数正确回填
8. 触发流水线执行，验证 Claude 收到正确的上下文和工具列表
9. 模拟执行失败，验证 Claude 能自主分析日志并尝试修复
