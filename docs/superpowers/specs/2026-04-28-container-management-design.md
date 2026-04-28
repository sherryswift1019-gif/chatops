# Pipeline 容器管理设计

## 概述

为 Pipeline 引擎新增 Docker 容器执行模式。参考 GitLab Runner Docker executor 的设计：pipeline 可声明一个默认容器 image，单个节点可 override；script 节点在运行时按配置动态选择执行器——有 role 配置的走现有 SSH 路径，无 role 但有 image 配置的在本机 Docker 容器内执行。

---

## §1 Executor 抽象层

### 接口定义

新增 `src/pipeline/executors/interface.ts`：

```typescript
export interface ScriptExecutor {
  setup(runId: number, config: ExecutorConfig): Promise<void>
  exec(command: string, env?: Record<string, string>): Promise<ExecResult>
  teardown(): Promise<void>
}

export type ExecutorConfig =
  | { type: 'ssh'; server: SSHConfig }
  | { type: 'docker'; image: string; env?: Record<string, string> }

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}
```

### 两个实现

| 实现 | 文件 | 行为 |
|---|---|---|
| `SshExecutor` | `src/pipeline/executors/ssh.ts` | 现有 `sshExec()` 逻辑移入，零行为变化 |
| `DockerExecutor` | `src/pipeline/executors/docker.ts` | `docker run -d` 启动 → `docker exec` 执行 → `docker rm` 清理 |

### 节点级执行器选择逻辑

```
节点有 targetRoles 非空？
  → 是：SshExecutor（SSH 到角色所在服务器，现有逻辑不动）
  → 否：有 containerImage（节点 override 或 pipeline 默认）？
       → 是：DockerExecutor（本机 /var/run/docker.sock）
       → 否：节点标记 failed（No executor configured）
```

同一 pipeline 内不同节点可混用两种执行器。

---

## §2 数据模型

### DB 变更（schema-v50）

```sql
ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS container_image TEXT DEFAULT NULL;
```

- `NULL`：不启用 Docker 模式，pipeline 内所有 script 节点需配置 role
- 非 `NULL`：pipeline 默认 image，无 role 的 script 节点使用此 image

### Pipeline JSONB 节点配置（stages 字段扩展）

script 节点新增可选字段 `containerImage`：

```jsonc
{
  "id": "build",
  "type": "script",
  "script": "npm run build",
  "targetRoles": [],          // 空 = 不走 SSH
  "containerImage": "node:20-alpine"  // 省略则继承 pipeline.container_image
}
```

### TypeScript 类型

`src/pipeline/types.ts` 补充：

```typescript
interface PipelineDefinition {
  containerImage?: string       // pipeline 级默认
}

interface ScriptNodeConfig {
  containerImage?: string       // 节点级 override
}
```

---

## §3 DockerExecutor 实现

**文件**：`src/pipeline/executors/docker.ts`

### 容器生命周期

```
setup()    → docker pull {image}
           → docker run -d --name chatops-run-{runId} \
                            -w /workspace \
                            -e KEY=VALUE ... \
                            {image} sleep infinity

exec()     → docker exec chatops-run-{runId} sh -c "{command}"

teardown() → docker rm -f chatops-run-{runId}
```

- `sleep infinity` 保持容器存活，供同一 run 的多个节点复用
- 容器名 `chatops-run-{runId}` 以 DB 自增 PK 保证并发唯一性
- 环境变量（`vars`、`triggerParams`）在 `setup()` 时通过 `-e` 注入
- `/workspace` 初始为**空目录**（不自动 clone 代码，与 GitLab Runner 不同）；节点间通过写文件到 `/workspace` 传递产物，同一 run 内所有节点共享此目录

### 实现方式

直接调 `docker` CLI（`child_process.spawn`），不引入新 npm 依赖。

### graph-runner 集成

- run 开始：检查 `pipeline.containerImage`，非 null 时构造 `DockerExecutor` 并调 `setup()`，将实例注入 `ExecutionContext.dockerExecutor`
- run 结束（finally）：调 `teardown()`，无论成功/失败/取消均执行

### graph-builder 集成

`buildScriptNode` 中的执行分支：

```
ctx.server 非空（role 模式）→ 现有 sshExec() 路径，不动
ctx.dockerExecutor 非空    → ctx.dockerExecutor.exec(resolvedScript)
两者均空                   → 节点 failed：No executor configured
```

---

## §4 前端 UI

### 4.1 Pipeline 级别默认 image

位置：pipeline 画布的 pipeline 属性面板（与 `name`、`schedule`、`description` 并列）

- 普通 `Input`，用户自由填写（如 `node:18`、`harbor.internal/myapp:latest`）
- 可清空，清空即关闭 Docker 模式
- placeholder：`留空则 script 节点需配置 role`

### 4.2 Script 节点 NodeInspector override

位置：NodeInspector 的 script 节点配置区

- 普通 `Input`，留空表示继承 pipeline 默认
- 继承值以灰色提示显示：`继承自 pipeline：node:18`
- 节点已配置 `targetRoles` 非空时，此字段置灰 + Tooltip：`已选 role，走 SSH 执行`

### 4.3 无新增管理页面

用户直接填写 image 名称，不需要预定义 image 目录，无需新增独立管理页面。

---

## §5 错误处理与边界情况

### Docker 执行失败

| 场景 | 处理 |
|---|---|
| `docker pull` 失败（镜像不存在/无权限） | run 立即 failed，错误：`Failed to pull image {image}: {stderr}` |
| `docker run` 启动失败 | 同上，不进入节点执行 |
| `docker exec` 返回非 0 exitCode | 节点 failed，输出 exitCode/stdout/stderr（与 SSH 模式一致） |
| 节点执行中容器意外退出 | `docker exec` 报错，节点 failed，teardown 幂等（rm -f 不存在的容器不报错） |
| `teardown()` 本身失败 | 仅 log warn，不覆盖 run 最终状态 |

### 配置冲突

| 情况 | 处理 |
|---|---|
| 节点同时设了 `targetRoles` 和 `containerImage` | `targetRoles` 优先，`containerImage` 忽略；NodeInspector 中该字段置灰 |
| pipeline 无 `containerImage`，节点也无，`targetRoles` 为空 | 节点 failed：`No executor configured: set a role or container image` |

### Dry-run 模式

- Dry-run 走 `dryrun-runner.ts`，`graph-runner` 的 setup/teardown 钩子不触发
- script 节点走现有 `wrapSideEffect` 拦截，弹决策框（真跑 / Stub / 手填）
- 选"真跑"时，`dryrun-runner` 在执行该节点前按需调用 `DockerExecutor.setup()`（懒启动），节点执行完毕后立即 `teardown()`（不等整个 dry-run 结束）
- 选 Stub 或手填时，不启动容器

### 并发隔离

容器名 `chatops-run-{runId}`，`runId` 为 DB 自增 PK，多条 pipeline run 并发不冲突。

---

## 实现范围总结

| 类别 | 变更 |
|---|---|
| DB | schema-v50：`test_pipelines.container_image` |
| 后端新增 | `src/pipeline/executors/interface.ts` |
| 后端新增 | `src/pipeline/executors/ssh.ts`（现有逻辑迁移） |
| 后端新增 | `src/pipeline/executors/docker.ts` |
| 后端修改 | `src/pipeline/graph-builder.ts`：buildScriptNode 执行分支 |
| 后端修改 | `src/pipeline/graph-runner.ts`：run 开始/结束注入/清理 executor |
| 后端修改 | `src/pipeline/types.ts`：新增 containerImage 字段 |
| 前端修改 | pipeline 属性面板：新增 containerImage Input |
| 前端修改 | NodeInspector script 节点：新增 containerImage override Input |
| 前端修改 | pipeline API client：同步 containerImage 字段 |
