# 自动化测试能力设计

## 概述

为 ChatOps 平台新增「自动化测试」能力，覆盖完整的环境部署 + 测试执行 + 报告生成流程。核心思路是构建一个轻量级 **Pipeline 引擎**，将整个流程建模为多个有序 Stage 的流水线，每步可观测、可重试、可配置。

### 核心流程

```
给定一组服务器 → 清理旧环境 → 下载软件包 → 静默安装 → 健康检查 → 执行测试 → 生成报告
```

### 关键约束

- 服务器可能有旧环境残留，必须先清理
- 软件包从对象存储/文件服务器下载（tar.gz），通过 install.sh 安装
- 安装脚本有交互式选项，需支持静默安装（通过配置文件传参）
- 测试脚本在独立 Git 仓库中，使用 Python pytest 框架
- 服务器角色可配置（不同产线不同角色分配）
- 三种触发方式：IM 对话、API 调用、定时任务

---

## 数据模型

### test_pipelines — 流水线模板定义

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | |
| product_line_id | INT FK → product_lines | 所属产线 |
| name | VARCHAR(200) | 流水线名称，如"回归测试" |
| description | TEXT | 描述 |
| stages | JSONB | Stage 定义数组（顺序、类型、参数） |
| server_roles | JSONB | 服务器角色定义，如 `{"db": {"count": 1}, "app": {"count": 2}}` |
| schedule | VARCHAR(100) | cron 表达式（定时触发用，可空） |
| enabled | BOOLEAN DEFAULT true | 是否启用 |
| created_at | TIMESTAMPTZ DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ DEFAULT NOW() | |

### test_runs — 流水线执行记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | |
| pipeline_id | INT FK → test_pipelines | 所属模板 |
| trigger_type | VARCHAR(20) | `manual` / `api` / `scheduled` |
| triggered_by | VARCHAR(200) | 触发人（IM 用户 ID 或 API 调用方标识） |
| status | VARCHAR(20) | `pending` / `running` / `success` / `failed` / `cancelled` |
| servers | JSONB | 本次使用的服务器列表及角色分配 |
| current_stage | INT DEFAULT 0 | 当前执行到的 Stage 索引 |
| stage_results | JSONB DEFAULT '[]' | 每个 Stage 的执行结果 |
| report_path | VARCHAR(500) | 生成的报告文件目录路径 |
| started_at | TIMESTAMPTZ | |
| finished_at | TIMESTAMPTZ | |
| error_message | TEXT | 失败原因 |
| created_at | TIMESTAMPTZ DEFAULT NOW() | |

### test_servers — 测试服务器池

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | |
| product_line_id | INT FK → product_lines | 所属产线 |
| name | VARCHAR(100) | 服务器名称/标识 |
| host | VARCHAR(200) | SSH 地址 |
| port | INT DEFAULT 22 | SSH 端口 |
| username | VARCHAR(100) | SSH 用户名 |
| auth_type | VARCHAR(20) | `password` / `key` |
| credential | TEXT | 密码或私钥（加密存储） |
| role | VARCHAR(50) | 分配的角色（如 db、app、test） |
| status | VARCHAR(20) DEFAULT 'idle' | `idle` / `in_use` / `offline` |
| tags | JSONB DEFAULT '{}' | 标签（用于灵活匹配） |
| created_at | TIMESTAMPTZ DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ DEFAULT NOW() | |

---

## Pipeline 引擎

### Stage 类型定义

```typescript
type StageType =
  | 'cleanup'       // 环境清理（执行卸载脚本）
  | 'download'      // 下载软件包
  | 'install'       // 静默安装
  | 'health_check'  // 健康检查
  | 'test'          // 执行 pytest
  | 'report'        // 生成报告
  | 'custom'        // 自定义 SSH 命令

interface StageDefinition {
  name: string;
  type: StageType;
  target_roles: string[];       // 在哪些角色的服务器上执行
  parallel: boolean;            // 是否在多台服务器上并行执行
  timeout_seconds: number;      // 超时时间
  retry_count: number;          // 失败重试次数
  params: Record<string, any>;  // Stage 类型特定参数
  on_failure: 'stop' | 'continue'; // 失败策略
}
```

### 各 Stage 类型参数

#### cleanup（环境清理）

执行专用卸载脚本，清理服务器上的旧环境残留。

```json
{
  "script": "/opt/app/uninstall.sh",
  "args": ["--force"],
  "pre_commands": ["systemctl stop app"]
}
```

- `script`: 卸载脚本路径
- `args`: 传给脚本的参数
- `pre_commands`: 卸载前需要先执行的命令（可选）

#### download（下载软件包）

从对象存储/文件服务器下载安装包。

```json
{
  "source_url": "https://oss.example.com/releases/v1.2.3/app.tar.gz",
  "dest_path": "/opt/packages/",
  "checksum": "sha256:abc123...",
  "extract": true
}
```

- `source_url`: 下载地址
- `dest_path`: 目标路径
- `checksum`: 校验和（可选，验证完整性）
- `extract`: 是否自动解压

#### install（安装部署）

支持静默安装，通过配置文件指定安装参数，避免交互式输入。

```json
{
  "work_dir": "/opt/packages/app/",
  "script": "./install.sh",
  "config_file": "install.conf",
  "config_values": {
    "INSTALL_PATH": "/opt/app",
    "DB_HOST": "{{servers.db[0].host}}",
    "DB_PORT": "5432",
    "APP_PORT": "8080",
    "ADMIN_PASSWORD": "xxx"
  },
  "silent_flag": "--silent -c install.conf"
}
```

- `config_file`: 配置文件名，会根据 `config_values` 自动生成到目标机器
- `config_values`: 配置键值对，支持 `{{servers.role[index].host}}` 变量模板引用其他服务器信息
- `silent_flag`: 传给安装脚本的静默安装参数

执行流程：
1. 根据 `config_values` 在目标机器上生成 `config_file`
2. 执行 `./install.sh --silent -c install.conf`

#### health_check（健康检查）

验证安装完成后服务是否正常启动。

```json
{
  "check_type": "http",
  "target": "http://localhost:8080/health",
  "interval_seconds": 5,
  "max_retries": 12
}
```

- `check_type`: `http` / `tcp` / `command`
- `target`: 检查目标（URL / host:port / shell 命令）
- `interval_seconds`: 检查间隔
- `max_retries`: 最大重试次数

#### test（执行测试）

从独立 Git 仓库拉取测试脚本，执行 pytest。

```json
{
  "git_repo": "https://gitlab.example.com/qa/auto-tests.git",
  "branch": "main",
  "work_dir": "/opt/tests/",
  "command": "pytest --junitxml=results.xml --html=report.html -v",
  "collect_artifacts": ["results.xml", "report.html"]
}
```

- `git_repo`: 测试仓库地址
- `branch`: 分支
- `work_dir`: 在目标机器上的工作目录
- `command`: 执行命令
- `collect_artifacts`: 需要回收的产物文件列表

#### report（生成报告）

汇总 Pipeline 所有信息 + pytest 结果，生成 HTML 报告。

```json
{
  "format": "html",
  "include_stage_logs": true
}
```

- `format`: 报告格式（`html`）
- `include_stage_logs`: 是否在报告中内联展示各 Stage 日志

报告自动包含内容：
- Pipeline 总览：触发方式、起止时间、总耗时、最终状态
- 服务器清单：本次使用的服务器及其角色
- 各 Stage 执行结果：状态、耗时、输出日志
- 测试结果详情：从 pytest JUnit XML 解析，展示用例通过/失败/跳过数量及失败详情

### 执行引擎核心逻辑

```
PipelineExecutor:
  1. 锁定服务器资源（标记为 in_use）
  2. 创建 test_run 记录（status=running）
  3. 遍历 stages，逐个执行：
     a. 解析目标服务器（按 target_roles 从 servers 中筛选）
     b. 若 parallel=true，并行 SSH 到多台服务器执行
     c. 收集执行结果（stdout/stderr/exit_code）
     d. 将日志写入本地文件存储
     e. 更新 test_run.stage_results 和 current_stage
     f. 若失败且 on_failure='stop'，中断 Pipeline
     g. 若失败且 retry_count > 0，重试
  4. 执行 report Stage：
     a. 从测试服务器回收 artifacts（SCP）
     b. 解析 pytest JUnit XML
     c. 生成 HTML 报告
     d. 打包 ZIP
  5. 更新 test_run.status 和 report_path
  6. 释放服务器资源（标记为 idle）
  7. 若从 IM 触发，推送结果摘要到对话群
```

---

## 触发方式

### 1. IM 对话触发

通过现有的 IM 适配器和 Claude AI 代理架构，用户在钉钉/飞书群里发送自然语言指令，Claude 识别意图并调用 `autotest` 工具。

遵循现有审批流程 — 如果审批规则配置了 `autotest` 操作需要审批，则触发审批流。

对话示例：
```
用户：在 192.168.1.10、192.168.1.11、192.168.1.12 上执行回归测试
Claude：收到，我来执行"回归测试"流水线。
  服务器分配：db→192.168.1.10, app→192.168.1.11, test→192.168.1.12
  [审批流，如配置需要]
  Stage 1/6 环境清理... 完成
  Stage 2/6 下载软件包... 完成
  ...
  全部完成！通过 42 / 失败 3 / 跳过 1
  报告查看：https://chatops.example.com/api/test-runs/123/report
```

### 2. API 触发

新增 REST API 端点，可集成到 GitLab CI/CD 或其他外部系统：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/test-runs` | 触发一次 Pipeline 执行 |
| GET | `/api/test-runs` | 列出历史执行记录 |
| GET | `/api/test-runs/:id` | 查询单次执行状态和进度 |
| GET | `/api/test-runs/:id/report` | 在线查看 HTML 报告 |
| GET | `/api/test-runs/:id/report/download` | 下载完整 ZIP 数据包 |

POST `/api/test-runs` 请求体：
```json
{
  "pipeline_id": 1,
  "servers": {
    "db": ["192.168.1.10"],
    "app": ["192.168.1.11"],
    "test": ["192.168.1.12"]
  }
}
```

### 3. 定时触发

- `test_pipelines.schedule` 字段存储 cron 表达式
- 服务启动时使用 node-cron 注册定时任务
- 触发时使用 Pipeline 关联产线下的默认服务器配置
- `trigger_type` 记录为 `scheduled`

---

## 报告系统

### 在线查看

`GET /api/test-runs/:id/report` 返回 HTML 页面，可在浏览器直接打开查看。

报告页面包含：
- Pipeline 执行总览（触发方式、时间、状态）
- 服务器清单及角色分配
- 各 Stage 执行时间线（状态、耗时）
- 测试结果汇总（通过/失败/跳过统计）
- 失败用例详情
- 页面顶部提供 **下载完整数据包** 按钮

### ZIP 数据包

`GET /api/test-runs/:id/report/download` 返回完整数据包：

```
test-run-{id}.zip
├── report.html                  // HTML 报告（和在线查看内容一致）
├── summary.json                 // 结构化汇总数据（方便程序解析）
├── stages/
│   ├── 01-cleanup.log           // 环境清理完整日志
│   ├── 02-download.log          // 下载过程日志
│   ├── 03-install.log           // 安装过程日志
│   ├── 04-health-check.log      // 健康检查日志
│   └── 05-test.log              // 测试执行日志
├── test-results/
│   ├── pytest-results.xml       // pytest JUnit XML 原始数据
│   ├── pytest-output.log        // pytest 完整控制台输出
│   └── coverage/                // 覆盖率数据（如有）
└── configs/
    └── install.conf             // 本次使用的安装配置文件
```

### 文件存储

报告和日志存储在服务器本地磁盘：
```
/data/chatops/test-runs/
  └── {run_id}/
      ├── stages/
      │   ├── 01-cleanup.log
      │   └── ...
      ├── test-results/
      │   ├── pytest-results.xml
      │   └── ...
      ├── configs/
      │   └── install.conf
      ├── report.html
      ├── summary.json
      └── test-run-{run_id}.zip
```

---

## AI Tool 定义

### autotest 工具

注册到现有工具系统（`src/agent/tools/`），遵循现有的 Tool 接口和权限体系。

**功能：**
- `list_pipelines` — 查看当前产线可用的 Pipeline 模板
- `trigger_run` — 触发执行一条 Pipeline，指定服务器和角色分配
- `get_run_status` — 查看某次执行的进度和状态
- `get_report_url` — 获取测试报告的在线查看 URL

**权限：** 遵循现有的 `tool_permissions` 和 `capabilities` 体系，支持按产线、环境、角色控制访问。

---

## 管理后台页面

### 1. 测试服务器管理页（`/test-servers`）

- 服务器列表表格：名称、地址、端口、角色、状态、所属产线
- 新增/编辑服务器（Modal 表单）
- 删除服务器
- 连接测试按钮（SSH 连通性验证）

### 2. Pipeline 模板管理页（`/test-pipelines`）

- Pipeline 列表：名称、产线、Stage 数量、定时配置、启用状态
- 新增/编辑 Pipeline：
  - 基本信息（名称、描述、所属产线）
  - Stage 编排（可添加/排序/删除 Stage，配置每个 Stage 的参数）
  - 服务器角色定义
  - 定时配置（cron 表达式）
- 启用/禁用开关

### 3. 测试执行历史页（`/test-runs`）

- 执行记录列表：Pipeline 名称、触发方式、触发人、状态、起止时间、耗时
- 筛选：按产线、状态、时间范围
- 执行详情页：
  - Stage 执行时间线（每步状态、耗时、可展开查看日志）
  - 测试结果概览
  - 在线查看报告按钮
  - 下载 ZIP 数据包按钮

---

## 新增文件清单

### 后端

```
src/
├── pipeline/                           // Pipeline 引擎核心
│   ├── executor.ts                     // PipelineExecutor 主逻辑
│   ├── stages/
│   │   ├── types.ts                    // Stage 类型定义
│   │   ├── cleanup.ts                  // 环境清理 Stage
│   │   ├── download.ts                 // 下载 Stage
│   │   ├── install.ts                  // 安装 Stage
│   │   ├── health-check.ts            // 健康检查 Stage
│   │   ├── test.ts                     // 测试执行 Stage
│   │   ├── report.ts                   // 报告生成 Stage
│   │   └── custom.ts                   // 自定义命令 Stage
│   ├── scheduler.ts                    // 定时任务调度
│   └── report-generator.ts            // HTML 报告生成 + ZIP 打包
├── agent/tools/
│   └── autotest.ts                     // autotest AI 工具
├── admin/routes/
│   ├── test-servers.ts                 // 测试服务器管理 API
│   ├── test-pipelines.ts              // Pipeline 模板管理 API
│   └── test-runs.ts                   // 执行记录 + 报告 API
├── db/
│   ├── schema-v3.sql                   // V3 表结构（3 张新表）
│   └── repositories/
│       ├── test-pipelines.ts           // Pipeline 仓库
│       ├── test-runs.ts               // 执行记录仓库
│       └── test-servers.ts            // 服务器仓库
```

### 前端

```
web/src/
├── pages/
│   ├── TestServersPage.tsx             // 测试服务器管理
│   ├── TestPipelinesPage.tsx           // Pipeline 模板管理
│   └── TestRunsPage.tsx               // 执行历史 + 详情
├── api/
│   ├── test-servers.ts                 // 服务器 API 客户端
│   ├── test-pipelines.ts              // Pipeline API 客户端
│   └── test-runs.ts                   // 执行记录 API 客户端
```
