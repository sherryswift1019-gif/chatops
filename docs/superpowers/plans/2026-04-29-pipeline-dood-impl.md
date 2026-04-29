# Pipeline 节点容器化执行（DooD）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 pipeline 的 `script` / `llm_agent`（capability + custom 两种模式）节点支持容器化运行时（DooD），并把 chatops MCP 工具完整暴露给 `custom` 模式 Claude；测试以真实 docker / 真实 fastify / 真实 DB 运行，仅在 Claude CLI 这种昂贵外部依赖处使用 stub。

**Architecture:** chatops 容器挂 `/var/run/docker.sock` 后，pipeline 节点执行函数在自身内部 `docker pull → docker run -d → docker exec → docker rm -f` 管理生命周期，对 LangGraph 透明。`run_command` MCP 工具看到 `TaskContext.dockerContainerName` 非空就走 `docker exec`，否则走宿主 `execAsync`。`testdata` 改宿主 bind mount，使 chatops 容器和节点容器看到同一份 worktree 路径。`runCustomAgent` 总是接入 `chatops` MCP server，UI 把所有注册工具列出来由用户白名单选择。

**Tech Stack:** Node.js + TypeScript + Fastify 5 + React 18 + Vite + Vitest + LangGraph + Porygon + Claude CLI + Docker (DooD via socket mount)。

**测试原则**：
- 真实 PostgreSQL（`./test.sh` 起的 testcontainer）覆盖所有依赖 DB 的代码路径
- 真实 Docker（`alpine:3.19`，约 7MB）覆盖容器生命周期相关代码；`it.skipIf(!hasDocker)` 在没装 docker 的开发机上自动跳过、CI 上必跑
- 仅 Claude CLI（启动慢、需 OAuth、对网外 API）这一处用 stub
- 现有 `mock spawn` 单测保留作为快速反馈层；额外新增真实 docker 集成测做最终把关

---

## 与 spec 的两处偏差（先固化决策，后面任务按此执行）

1. **不动 `autotest.ts`**：spec §5.3 写"autotest 同样适配 docker exec 分支"，但实际代码 [src/agent/tools/autotest.ts](../../../src/agent/tools/autotest.ts) 是触发子 pipeline（`runPipeline`），不是直接 `execAsync`。子 pipeline 自己可以配 `containerImage`，autotest 工具自身无需改。
2. **`claude-runner.ts` 现有 `disallowedTools` 已含 Bash**：spec §5.5 写"capability 路径 containerImage 配了时 disallowedTools 追加 'Bash'"，但 `executeWithPorygon`（line 761）和 `executeCapabilityDirect`（line 882）的 `disallowedTools` 都已硬编码 `'Bash'`。当前 capability 模式 Bash 始终被禁，无需新增条件。计划只在 `runCapability` 注入 `dockerContainerName` 即可。

---

## File Structure

| 文件 | 责任 | 任务编号 |
|------|------|---------|
| `test.sh` | 扩展现有 `--setup-env`：从"仅检查工具是否安装"升级为"缺失即真装"（apt/brew 装 docker / node / pnpm / psql 等），并预拉测试用镜像 `alpine:3.19` | 0 |
| `src/agent/tools/types.ts` | `TaskContext` 加 `dockerContainerName?: string`；`DEFAULT_TOOL_ROLES` 加 `run_command` 角色映射 | 1 |
| `src/pipeline/executors/docker.ts` | `setup()` 加 `SetupOptions { dataDirMount?: { hostPath: string } }`；不传时行为不变（向后兼容） | 2 |
| `src/agent/tools/run-command.ts`（新建） | 从 `run-tests.ts` 迁移逻辑 + 改名 `run_command`；`ctx.dockerContainerName` 非空时 `docker exec` | 3 |
| `src/agent/tools/run-tests.ts` | 改成 deprecated alias —— 复用 `run-command.ts` 的 execute，仅注册名不同 | 4 |
| `src/agent/mcp-server.ts` | 把 `import './tools/run-tests.js'` 改成 `import './tools/run-command.js'` 并保留 run-tests | 4 |
| `src/server.ts` | 同上：补 `import './tools/run-command.js'` 注册 | 4 |
| `src/pipeline/graph-builder.ts` | `StageContextBase` 加 `pipelineContainerImage?: string` | 5 |
| `src/pipeline/executor.ts` | `stageContext` 注入 `pipelineContainerImage` | 5 |
| `src/pipeline/executor-hooks.ts` | `runCapability` 起/拆容器 + 注入 `dockerContainerName`；`runCustomAgent` 起/拆容器 + 接入 chatops MCP server + 注入 `dockerContainerName` | 6, 7 |
| `src/admin/routes/tools.ts`（新建） | `GET /admin/tools` 列出已注册工具 | 8 |
| `src/admin/index.ts` | 注册 `registerToolsRoutes` | 8 |
| `web/src/api/tools.ts`（新建） | `listTools()` 客户端封装 | 9 |
| `web/src/pipeline-canvas/panels/NodeInspector.tsx` | `llm_agent` 两种 mode 都展示 `containerImage`；custom 的 `allowedTools` 改分组下拉（平台 + 内置）+ warning | 9 |
| `web/src/pipeline-canvas/panels/pruneStageFields.ts` | `containerImage` 在 `llm_agent` 也保留（之前只在 `script` 保留） | 9 |
| `Dockerfile` | 装 `docker-ce-cli` | 10 |
| `docker-compose.yml` / `docker-compose.prod.yml` | 挂 `/var/run/docker.sock` + `testdata` 改 bind mount + `group_add: docker` + `HOST_TEST_DATA_DIR` env | 10 |

测试新增：

| 测试文件 | 类型 | 任务 |
|---------|------|------|
| `src/__tests__/unit/docker-executor.test.ts`（扩展现有） | 单测：dataDirMount 时 args 含 `-v` | 2 |
| `src/__tests__/integration/docker-executor-real.test.ts`（新建） | 集成（真 docker，skipIf）：dataDirMount 真挂载 + exec 看到文件 | 2 |
| `src/__tests__/unit/run-command-tool.test.ts`（新建） | 单测：cwd 路径 / dockerContainerName 路径 / 命令 timeout | 3 |
| `src/__tests__/integration/run-command-tool-real.test.ts`（新建） | 集成（真 docker，skipIf）：真起容器 → run_command 跑 `echo hi` → 拿到输出 | 3 |
| `src/__tests__/unit/run-tests-alias.test.ts`（新建） | 单测：`run_tests` 注册后 schema/execute 与 `run_command` 等价 | 4 |
| `src/__tests__/unit/executor-hooks-container.test.ts`（新建） | 单测：runCapability/runCustomAgent 起容器时 ctx.dockerContainerName 注入；teardown 必调（mock DockerExecutor 仅记录调用） | 6, 7 |
| `src/__tests__/integration/executor-hooks-real-docker.test.ts`（新建） | 集成（真 docker + 真 DB，skipIf）：runCapability 真起 alpine + stub triggerCapability 拿到 ctx → 验证 dockerContainerName 在 `docker ps` 列表里 → finally 后已 rm | 6 |
| `src/__tests__/integration/admin-tools-route.test.ts`（新建） | 集成（真 fastify + 真 DB）：`GET /admin/tools` 返回所有注册工具，含 `run_command` | 8 |
| `web/src/pipeline-canvas/panels/pruneStageFields.test.ts`（扩展） | 单测：llm_agent ↔ llm_agent 切 agentMode 保留 containerImage；script ↔ llm_agent 切 stageType 保留 containerImage；llm_agent → approval 清空 | 9 |

---

## Task 0: 扩展 `test.sh --setup-env` 真正安装系统依赖

**Why:** 计划里 `DockerExecutor` / `run_command` / `runCapability` 的真集成测都依赖一个能跑 `docker pull alpine:3.19` 的开发机或 CI runner。当前 `test.sh --setup-env` 只**检查** docker 是否安装（缺失就抛"先装再来"），并不**安装**。本任务把"缺失即装"塞进同一条命令，让"开发机第一次跑测试"压成一条命令。

**Files:**
- Modify: `test.sh`

- [ ] **Step 1: 给 `setup_env` 加"自动安装"分支，替换"工具缺失则退出"**

`test.sh:71-106`，把"[1/5] 检查工具..."一段重写为"先检查，缺啥就装啥"。

把原 `check()` 函数后的"必需工具检查 + 缺失退出"逻辑（line 91-106）整段替换为：

```bash
    check node
    check pnpm
    check docker
    check psql false   # 集成测试用 testcontainer 自动起,本地 psql 仅用于 seed
    check git
    check jq false

    if [ "$tools_ok" = false ]; then
        echo ""
        warn "工具缺失，尝试自动安装（需 sudo）..."
        case "$OS" in
            macos)
                if ! command -v brew &>/dev/null; then
                    fail "需要先装 Homebrew: https://brew.sh"; exit 1
                fi
                brew install node pnpm postgresql jq || true
                if ! command -v docker &>/dev/null; then
                    warn "macOS Docker 请手动从 https://orbstack.dev 或 https://docker.com 安装"
                fi
                ;;
            ubuntu|debian)
                if [ "$(id -u)" -ne 0 ] && ! sudo -n true 2>/dev/null; then
                    warn "本步需要 sudo，过程中可能弹出密码提示"
                fi
                sudo apt-get update -qq
                # Node.js 20 LTS（NodeSource）—— 仅当 node 缺失或非 v20/v22 时安装
                if ! command -v node &>/dev/null \
                   || [[ "$(node -v 2>/dev/null)" != v20* && "$(node -v 2>/dev/null)" != v22* ]]; then
                    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
                    sudo apt-get install -y --no-install-recommends nodejs
                fi
                sudo apt-get install -y --no-install-recommends \
                    postgresql-client jq git ca-certificates curl gnupg
                if ! command -v pnpm &>/dev/null; then
                    sudo corepack enable 2>/dev/null || sudo npm install -g pnpm
                fi
                # docker-ce + docker-ce-cli
                if ! command -v docker &>/dev/null; then
                    sudo install -m 0755 -d /etc/apt/keyrings
                    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
                        sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
                    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
                        | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
                    sudo apt-get update -qq
                    sudo apt-get install -y --no-install-recommends \
                        docker-ce docker-ce-cli containerd.io
                    sudo systemctl enable --now docker
                fi
                # 当前用户加入 docker 组
                if ! id -nG "$USER" | grep -qw docker; then
                    sudo usermod -aG docker "$USER"
                    warn "已把 $USER 加入 docker 组，需重新登录或 'newgrp docker' 后才能免 sudo 跑 docker"
                fi
                ;;
            *)
                fail "暂不支持自动安装：$OS。请按发行版自行装 node / pnpm / docker / postgresql-client / jq"
                exit 1
                ;;
        esac
        info "重新检查工具可用性..."
        tools_ok=true
        check node
        check pnpm
        check docker
        check git
        if [ "$tools_ok" = false ]; then
            fail "自动安装后仍有工具缺失，请手动处理（可能需要重新登录让 docker 组生效）"; exit 1
        fi
    fi
```

- [ ] **Step 2: Docker daemon 检查后追加"预拉测试镜像"步骤**

`test.sh:108-117`（"[2/5] 检查 Docker daemon..."）后面追加一个步骤。把原来 5 步改成 6 步，注释里调编号；插入新的 [3/6] 块：

```bash
    # ─── 3. 预拉测试用镜像 ────────────────────────────────────────────────────
    info "[3/6] 预拉 alpine:3.19（DooD 集成测基线镜像）..."
    if docker image inspect alpine:3.19 &>/dev/null; then
        info "  alpine:3.19 已在本地"
    else
        if docker pull alpine:3.19 2>&1 | tail -3; then
            info "  alpine:3.19 拉取完成"
        else
            warn "  alpine:3.19 拉取失败，集成测首跑会自动重试（或手动 docker pull alpine:3.19）"
        fi
    fi
```

把后续 [3/5]、[4/5]、[5/5] 的编号顺延为 [4/6]、[5/6]、[6/6]。

- [ ] **Step 3: 帮助注释更新**

`test.sh:6-12` 的 `用法:` 注释块里 `--setup-env` 那一行改成：

```bash
#   ./test.sh --setup-env         # 初始化环境：缺啥装啥（docker/node/pnpm/psql）+ 预拉镜像 + pnpm install + bootstrap DB
```

- [ ] **Step 4: 脚本自检（不真装）**

Run: `bash -n test.sh`
Expected: 0 退出码（脚本语法 OK）。

Run: `./test.sh --help`
Expected: 输出含更新后的 `--setup-env` 描述。

- [ ] **Step 5: 在已装好依赖的开发机上跑一遍验证**

Run: `./test.sh --setup-env`
Expected: 6/6 全 ✓；docker 已装时直接进 alpine 预拉；alpine 已在时跳过拉取。

- [ ] **Step 6: 在缺 docker 的容器/VM 上验证（可选，最稳妥的回归）**

如果手边有干净的 ubuntu 容器，可以这样验证：

```bash
docker run -it --rm --privileged ubuntu:22.04 bash -c '
  apt-get update -qq && apt-get install -y -qq sudo curl
  cd /tmp && git clone <repo> chatops && cd chatops && ./test.sh --setup-env
'
```

Expected: 自动装齐工具，alpine:3.19 预拉成功。

- [ ] **Step 7: 提交**

```bash
git add test.sh
git commit -m "feat(test): setup-env now auto-installs missing system deps + pre-pulls alpine:3.19"
```

---

## Task 1: 扩展 TaskContext 类型 + 工具角色映射

**Files:**
- Modify: `src/agent/tools/types.ts`

- [ ] **Step 1: 给 TaskContext 加 dockerContainerName 字段**

```typescript
// src/agent/tools/types.ts，TaskContext 接口内追加：
export interface TaskContext {
  taskId: string
  groupId: string
  platform: string
  initiatorId: string
  initiatorRole: Role | null
  cwd?: string
  productLineId?: number
  originalPrompt?: string
  /** 节点级容器名，run_command 等本地命令工具看到非空时走 docker exec */
  dockerContainerName?: string
}
```

- [ ] **Step 2: DEFAULT_TOOL_ROLES 加 run_command（与 run_tests 同角色）**

```typescript
// 在 'run_tests': [...] 那一行下面加：
run_command: ['developer', 'tester', 'ops', 'admin'],
```

- [ ] **Step 3: 跑类型检查确认无破坏**

Run: `pnpm typecheck`
Expected: 通过；现有所有 `TaskContext` 实例无须改动（新字段可选）。

- [ ] **Step 4: 提交**

```bash
git add src/agent/tools/types.ts
git commit -m "feat(tools): add dockerContainerName to TaskContext + run_command role map"
```

---

## Task 2: DockerExecutor 支持 dataDirMount

**Files:**
- Modify: `src/pipeline/executors/docker.ts`
- Modify: `src/__tests__/unit/docker-executor.test.ts`
- Create: `src/__tests__/integration/docker-executor-real.test.ts`

- [ ] **Step 1: 写失败的单测（mock spawn 路径）**

把现有 `src/__tests__/unit/docker-executor.test.ts` 末尾追加：

```typescript
it('setup: with dataDirMount adds -v hostPath:containerPath to docker run args', async () => {
  process.env.TEST_DATA_DIR = '/data/chatops/test-runs'
  const executor = new DockerExecutor('alpine:3.19')
  await executor.setup('chatops-run-99', { dataDirMount: { hostPath: '/srv/chatops/test-runs' } })
  const runArgs = callArgs.find(a => a[0] === 'run')!
  const vIdx = runArgs.indexOf('-v')
  expect(vIdx).toBeGreaterThan(-1)
  expect(runArgs[vIdx + 1]).toBe('/srv/chatops/test-runs:/data/chatops/test-runs')
})

it('setup: without dataDirMount does NOT add -v', async () => {
  const executor = new DockerExecutor('alpine:3.19')
  await executor.setup('chatops-run-100')
  const runArgs = callArgs.find(a => a[0] === 'run')!
  expect(runArgs).not.toContain('-v')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/unit/docker-executor.test.ts`
Expected: FAIL（`-v` 找不到，因为 setup 还不接受第 2 个参数）。

- [ ] **Step 3: 实现 SetupOptions**

```typescript
// src/pipeline/executors/docker.ts，class DockerExecutor 内：

export interface SetupOptions {
  /** 把宿主机目录挂到容器内 TEST_DATA_DIR 路径，供跨节点文件共享 */
  dataDirMount?: { hostPath: string }
}

async setup(containerName: string, opts: SetupOptions = {}): Promise<void> {
  this.containerName = containerName

  const pull = await spawnAsync('docker', ['pull', this.image])
  if (pull.exitCode !== 0) {
    throw new Error(`Failed to pull image ${this.image}: ${pull.stderr.trim()}`)
  }

  const args: string[] = ['run', '-d', '--name', this.containerName, '-w', '/workspace']
  if (opts.dataDirMount) {
    const containerDataDir = process.env.TEST_DATA_DIR ?? '/data/chatops/test-runs'
    args.push('-v', `${opts.dataDirMount.hostPath}:${containerDataDir}`)
  }
  args.push(this.image, 'sleep', 'infinity')

  const run = await spawnAsync('docker', args)
  if (run.exitCode !== 0) {
    throw new Error(`Failed to start container ${this.containerName}: ${run.stderr.trim()}`)
  }

  this.ready = true
}
```

- [ ] **Step 4: 跑单测确认通过**

Run: `npx vitest run src/__tests__/unit/docker-executor.test.ts`
Expected: PASS（含新 2 用例 + 原 5 用例）。

- [ ] **Step 5: 写真实 docker 集成测**

Create: `src/__tests__/integration/docker-executor-real.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DockerExecutor } from '../../pipeline/executors/docker.js'

const hasDocker = (() => {
  try { execSync('docker version --format ok', { stdio: 'pipe' }); return true } catch { return false }
})()

describe.skipIf(!hasDocker)('DockerExecutor real docker', () => {
  it('setup with dataDirMount: file written on host is visible inside container', async () => {
    const hostDir = mkdtempSync(join(tmpdir(), 'chatops-dood-'))
    process.env.TEST_DATA_DIR = '/data/chatops/test-runs'
    writeFileSync(join(hostDir, 'hello.txt'), 'from-host')

    const containerName = `chatops-test-dood-${Date.now()}`
    const executor = new DockerExecutor('alpine:3.19')
    try {
      await executor.setup(containerName, { dataDirMount: { hostPath: hostDir } })
      const result = await executor.exec('cat /data/chatops/test-runs/hello.txt')
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('from-host')
    } finally {
      await executor.teardown()
      rmSync(hostDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('teardown removes the container', async () => {
    const containerName = `chatops-test-dood-tear-${Date.now()}`
    const executor = new DockerExecutor('alpine:3.19')
    await executor.setup(containerName)
    await executor.teardown()
    const out = execSync(`docker ps -a --filter name=^/${containerName}$ --format '{{.Names}}'`, { stdio: 'pipe' }).toString().trim()
    expect(out).toBe('')
  }, 60_000)
})
```

- [ ] **Step 6: 跑集成测（如本机有 docker）**

Run: `npx vitest run src/__tests__/integration/docker-executor-real.test.ts`
Expected: PASS（如有 docker）；DESCRIBE SKIPPED（如无 docker）。

- [ ] **Step 7: 提交**

```bash
git add src/pipeline/executors/docker.ts src/__tests__/unit/docker-executor.test.ts src/__tests__/integration/docker-executor-real.test.ts
git commit -m "feat(docker): add dataDirMount to DockerExecutor.setup"
```

---

## Task 3: 新建 run_command 工具

**Files:**
- Create: `src/agent/tools/run-command.ts`
- Create: `src/__tests__/unit/run-command-tool.test.ts`
- Create: `src/__tests__/integration/run-command-tool-real.test.ts`

- [ ] **Step 1: 写失败的单测**

Create: `src/__tests__/unit/run-command-tool.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TaskContext } from '../../agent/tools/types.js'

// Mock child_process.exec used by run-command tool
const execMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ exec: execMock }))
vi.mock('util', () => ({
  promisify: () =>
    (cmd: string, opts: { cwd?: string; timeout?: number }) => execMock(cmd, opts),
}))

import { runCommandTool } from '../../agent/tools/run-command.js'

const baseCtx: TaskContext = {
  taskId: 't1', groupId: 'g1', platform: 'pipeline',
  initiatorId: 'u1', initiatorRole: 'admin',
}

describe('run_command tool', () => {
  beforeEach(() => execMock.mockReset())

  it('without dockerContainerName: runs execAsync(cmd, { cwd })', async () => {
    execMock.mockResolvedValueOnce({ stdout: 'ok', stderr: '' })
    const ctx: TaskContext = { ...baseCtx, cwd: '/tmp/work' }
    const r = await runCommandTool.execute({ command: 'echo hi' }, ctx)
    expect(r.success).toBe(true)
    expect(execMock).toHaveBeenCalledWith('echo hi', expect.objectContaining({ cwd: '/tmp/work' }))
  })

  it('with dockerContainerName: routes to docker exec sh -c "cd <cwd> && <cmd>"', async () => {
    execMock.mockResolvedValueOnce({ stdout: 'inside', stderr: '' })
    const ctx: TaskContext = { ...baseCtx, cwd: '/workspace/proj', dockerContainerName: 'cap-1' }
    const r = await runCommandTool.execute({ command: 'go test ./...' }, ctx)
    expect(r.success).toBe(true)
    const [calledCmd] = execMock.mock.calls[0] as [string, unknown]
    expect(calledCmd).toBe('docker exec cap-1 sh -c "cd /workspace/proj && go test ./..."')
  })

  it('cwd not set: returns failure without spawning', async () => {
    const r = await runCommandTool.execute({ command: 'ls' }, baseCtx)
    expect(r.success).toBe(false)
    expect(r.output).toContain('未设置工作目录')
    expect(execMock).not.toHaveBeenCalled()
  })

  it('exec failure surfaces exit code and stderr', async () => {
    execMock.mockRejectedValueOnce({ code: 2, stdout: 'partial', stderr: 'boom' })
    const ctx: TaskContext = { ...baseCtx, cwd: '/tmp/work' }
    const r = await runCommandTool.execute({ command: 'false' }, ctx)
    expect(r.success).toBe(false)
    expect((r.data as { exitCode: number }).exitCode).toBe(2)
    expect(r.output).toContain('boom')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/unit/run-command-tool.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 run-command 工具**

Create: `src/agent/tools/run-command.ts`

```typescript
import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const runCommandTool: AgentTool = {
  name: 'run_command',
  description: '在工作区执行 shell 命令。配置了运行容器时自动路由进容器内执行。',
  riskLevel: 'medium',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'shell 命令（如 mvn test / pytest / go build）' },
      timeout: { type: 'number', description: '超时时间（毫秒），默认 300000' },
    },
    required: ['command'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { command, timeout } = params as { command: string; timeout?: number }
    const cwd = ctx.cwd
    if (!cwd) return { success: false, output: '未设置工作目录（cwd）' }
    const timeoutMs = timeout ?? 300_000

    try {
      let stdout: string, stderr: string
      if (ctx.dockerContainerName) {
        const dockerCmd = `docker exec ${ctx.dockerContainerName} sh -c "cd ${cwd} && ${command}"`
        const r = await execAsync(dockerCmd, { timeout: timeoutMs })
        stdout = r.stdout; stderr = r.stderr
      } else {
        const r = await execAsync(command, { cwd, timeout: timeoutMs })
        stdout = r.stdout; stderr = r.stderr
      }
      return {
        success: true,
        output: `命令执行成功\n\nstdout:\n${stdout.slice(-2000)}\n\nstderr:\n${stderr.slice(-500)}`,
        data: { exitCode: 0 },
      }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number }
      return {
        success: false,
        output: `命令失败（exit ${e.code ?? 'unknown'}）\n\nstdout:\n${(e.stdout ?? '').slice(-2000)}\n\nstderr:\n${(e.stderr ?? '').slice(-500)}`,
        data: { exitCode: e.code ?? 1 },
      }
    }
  },
}

registerTool(runCommandTool)
export { runCommandTool }
```

- [ ] **Step 4: 跑单测确认通过**

Run: `npx vitest run src/__tests__/unit/run-command-tool.test.ts`
Expected: PASS（4/4）。

- [ ] **Step 5: 写真实 docker 集成测**

Create: `src/__tests__/integration/run-command-tool-real.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DockerExecutor } from '../../pipeline/executors/docker.js'
import { runCommandTool } from '../../agent/tools/run-command.js'
import type { TaskContext } from '../../agent/tools/types.js'

const hasDocker = (() => {
  try { execSync('docker version --format ok', { stdio: 'pipe' }); return true } catch { return false }
})()

describe.skipIf(!hasDocker)('run_command real docker', () => {
  it('docker path: command runs inside container with cwd from bind-mounted host dir', async () => {
    const hostDir = mkdtempSync(join(tmpdir(), 'chatops-rc-'))
    process.env.TEST_DATA_DIR = '/data/chatops/test-runs'
    writeFileSync(join(hostDir, 'marker.txt'), 'mounted')

    const name = `chatops-test-rc-${Date.now()}`
    const executor = new DockerExecutor('alpine:3.19')
    try {
      await executor.setup(name, { dataDirMount: { hostPath: hostDir } })
      const ctx: TaskContext = {
        taskId: 't', groupId: 'g', platform: 'pipeline',
        initiatorId: 'u', initiatorRole: 'admin',
        cwd: '/data/chatops/test-runs',
        dockerContainerName: name,
      }
      const r = await runCommandTool.execute({ command: 'cat marker.txt' }, ctx)
      expect(r.success).toBe(true)
      expect(r.output).toContain('mounted')
    } finally {
      await executor.teardown()
      rmSync(hostDir, { recursive: true, force: true })
    }
  }, 60_000)
})
```

- [ ] **Step 6: 跑集成测**

Run: `npx vitest run src/__tests__/integration/run-command-tool-real.test.ts`
Expected: PASS（如有 docker）/ SKIPPED（如无）。

- [ ] **Step 7: 提交**

```bash
git add src/agent/tools/run-command.ts src/__tests__/unit/run-command-tool.test.ts src/__tests__/integration/run-command-tool-real.test.ts
git commit -m "feat(tools): add run_command tool with docker exec routing"
```

---

## Task 4: run_tests 改为 deprecated 别名 + 注册

**Files:**
- Modify: `src/agent/tools/run-tests.ts`
- Modify: `src/agent/mcp-server.ts`
- Modify: `src/server.ts`
- Create: `src/__tests__/unit/run-tests-alias.test.ts`

- [ ] **Step 1: 把 run-tests.ts 改成复用 run-command 逻辑的别名**

```typescript
// src/agent/tools/run-tests.ts —— 整文件替换为：
import { registerTool } from './index.js'
import { runCommandTool } from './run-command.js'
import type { AgentTool } from './types.js'

/**
 * Deprecated: 旧 capability 配置的别名。新代码统一用 run_command。
 * 复用 runCommandTool.execute，行为一致；保留独立条目以免破坏 capability JSON 中的 'run_tests'。
 */
const runTestsAlias: AgentTool = {
  ...runCommandTool,
  name: 'run_tests',
  description: '[deprecated] 旧名称，等价于 run_command；新 capability 请改用 run_command。',
}

registerTool(runTestsAlias)
export { runTestsAlias as runTestsTool }
```

- [ ] **Step 2: server.ts 和 mcp-server.ts 都补 import './tools/run-command.js'**

`src/agent/mcp-server.ts` 在第 44 行 `import './tools/run-tests.js'` 上方插：

```typescript
import './tools/run-command.js'
```

`src/server.ts` 找到 `import './agent/tools/run-tests.js'`（如有）或 tool 模块的 import 区，在它附近插：

```typescript
import './agent/tools/run-command.js'
```

实际确认：

Run: `grep -n "tools/run-tests" src/server.ts src/agent/mcp-server.ts`
Expected: 有 mcp-server.ts:44 引用；server.ts 看输出再决定加一行。

- [ ] **Step 3: 写别名等价性单测**

Create: `src/__tests__/unit/run-tests-alias.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import '../../agent/tools/run-command.js'
import '../../agent/tools/run-tests.js'
import { getTool } from '../../agent/tools/index.js'

describe('run_tests deprecated alias', () => {
  it('both run_tests and run_command are registered with the same execute', () => {
    const cmd = getTool('run_command')
    const legacy = getTool('run_tests')
    expect(cmd).toBeDefined()
    expect(legacy).toBeDefined()
    // 别名复用同一份 execute 引用
    expect(legacy!.execute).toBe(cmd!.execute)
  })

  it('run_tests description marks it deprecated', () => {
    const legacy = getTool('run_tests')!
    expect(legacy.description).toMatch(/deprecated/i)
  })
})
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run src/__tests__/unit/run-tests-alias.test.ts`
Expected: PASS（2/2）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add src/agent/tools/run-tests.ts src/agent/mcp-server.ts src/server.ts src/__tests__/unit/run-tests-alias.test.ts
git commit -m "refactor(tools): make run_tests a deprecated alias of run_command"
```

---

## Task 5: graph-builder + executor 加 pipelineContainerImage

**Files:**
- Modify: `src/pipeline/graph-builder.ts`
- Modify: `src/pipeline/executor.ts`

- [ ] **Step 1: StageContextBase 加字段**

`src/pipeline/graph-builder.ts:81-83` 改成：

```typescript
export interface StageContextBase extends Omit<StageContext, 'stageIndex'> {
  dockerExecutor?: DockerExecutor
  /** Pipeline 级默认镜像；node 没配 containerImage 时由 hooks 回落使用 */
  pipelineContainerImage?: string
}
```

- [ ] **Step 2: executor.ts 注入字段**

`src/pipeline/executor.ts:180-194`，在 `dockerExecutor,` 后加一行：

```typescript
  const stageContext: StageContextBase = {
    runId: run.id,
    servers: serverMap,
    logDir,
    productLine: ...,
    pipeline: { id: pipeline.id, name: pipeline.name },
    run: { id: run.id, triggeredBy, triggerType },
    variables: { ...(pipeline.variables ?? {}), ...runtimeVars },
    triggerPlatform: imContext?.platform,
    triggerGroupId: imContext?.groupId,
    triggerUserId: imContext?.userId,
    dockerExecutor,
    pipelineContainerImage: pipelineContainerImage ?? undefined,  // 新增
  }
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 4: 跑现有 pipeline 单测确认零回归**

Run: `npx vitest run src/__tests__/unit/graph-builder.test.ts src/__tests__/unit/graph-runner.test.ts`
Expected: 全部 PASS（仅扩展字段不影响现有断言）。

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/graph-builder.ts src/pipeline/executor.ts
git commit -m "feat(pipeline): plumb pipelineContainerImage through StageContextBase"
```

---

## Task 6: runCapability 起/拆容器 + 注入 dockerContainerName

**Files:**
- Modify: `src/pipeline/executor-hooks.ts`
- Create: `src/__tests__/unit/executor-hooks-container.test.ts`

- [ ] **Step 1: 写失败的单测（完全 mock DockerExecutor 和 triggerCapability）**

Create: `src/__tests__/unit/executor-hooks-container.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StageDefinition, StageContext } from '../../pipeline/types.js'

const setupSpy = vi.fn()
const teardownSpy = vi.fn()
const triggerSpy = vi.fn()

vi.mock('../../pipeline/executors/docker.js', () => ({
  DockerExecutor: class FakeDocker {
    constructor(public image: string) {}
    setup = setupSpy
    teardown = teardownSpy
    exec = vi.fn()
  },
}))

vi.mock('../../agent/coordinator.js', () => ({
  triggerCapability: triggerSpy,
}))

import { buildDefaultHooks } from '../../pipeline/executor-hooks.js'

const stage: StageDefinition = {
  name: 's1', stageType: 'llm_agent',
  capabilityKey: 'analyze_bug',
  containerImage: 'node:18',
  timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
} as StageDefinition

const ctxBase = {
  runId: 42, stageIndex: 0,
  servers: {}, logDir: '/tmp/log',
  pipelineContainerImage: 'fallback:latest',
} as unknown as StageContext

describe('runCapability container lifecycle', () => {
  beforeEach(() => {
    setupSpy.mockReset(); teardownSpy.mockReset(); triggerSpy.mockReset()
    setupSpy.mockResolvedValue(undefined); teardownSpy.mockResolvedValue(undefined)
  })

  it('starts container when stage.containerImage set, injects dockerContainerName, tears down', async () => {
    triggerSpy.mockResolvedValue({ success: true, output: 'done' })
    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCapability!(stage, ctxBase)
    expect(setupSpy).toHaveBeenCalled()
    const [containerName] = setupSpy.mock.calls[0]
    expect(containerName).toMatch(/^chatops-cap-42-0$/)
    const callArg = triggerSpy.mock.calls[0][0]
    expect(callArg.context.dockerContainerName).toBe('chatops-cap-42-0')
    expect(teardownSpy).toHaveBeenCalled()
    expect(r.status).toBe('success')
  })

  it('falls back to pipelineContainerImage when stage.containerImage empty', async () => {
    triggerSpy.mockResolvedValue({ success: true, output: 'ok' })
    const hooks = buildDefaultHooks('/tmp/log')
    await hooks.runCapability!({ ...stage, containerImage: undefined }, ctxBase)
    expect(setupSpy).toHaveBeenCalled()
  })

  it('no image at all: does not call setup/teardown', async () => {
    triggerSpy.mockResolvedValue({ success: true, output: 'ok' })
    const hooks = buildDefaultHooks('/tmp/log')
    await hooks.runCapability!(
      { ...stage, containerImage: undefined },
      { ...ctxBase, pipelineContainerImage: undefined } as StageContext,
    )
    expect(setupSpy).not.toHaveBeenCalled()
    expect(teardownSpy).not.toHaveBeenCalled()
    const callArg = triggerSpy.mock.calls[0][0]
    expect(callArg.context.dockerContainerName).toBeUndefined()
  })

  it('teardown called even if triggerCapability throws', async () => {
    triggerSpy.mockRejectedValue(new Error('boom'))
    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCapability!(stage, ctxBase)
    expect(teardownSpy).toHaveBeenCalled()
    expect(r.status).toBe('failed')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/unit/executor-hooks-container.test.ts`
Expected: FAIL（行为还没实现）。

- [ ] **Step 3: 实现 runCapability 容器生命周期**

`src/pipeline/executor-hooks.ts`，在文件顶部 `import` 区追加：

```typescript
import { DockerExecutor } from './executors/docker.js'
```

把 `buildDefaultHooks` 内的 `runCapability` 整段替换为：

```typescript
async runCapability(stage, ctx, triggerParams, runtimeVars): Promise<StageExecutionResult> {
  const capabilityKey = stage.capabilityKey
  if (!capabilityKey) {
    return { status: 'failed', output: '未配置 capabilityKey', error: 'no capabilityKey' }
  }
  const timeoutMs = (stage.timeoutSeconds ?? 1200) * 1000
  const resolvedParams = resolveCapabilityParams(stage.capabilityParams, triggerParams, runtimeVars)

  const ctxBase = ctx as StageContext & { pipelineContainerImage?: string }
  const effectiveImage = stage.containerImage?.trim() || ctxBase.pipelineContainerImage?.trim()
  let dockerExecutor: DockerExecutor | undefined
  let dockerContainerName: string | undefined
  if (effectiveImage) {
    dockerContainerName = `chatops-cap-${ctx.runId}-${ctx.stageIndex}`
    dockerExecutor = new DockerExecutor(effectiveImage)
    const hostDataDir = process.env.HOST_TEST_DATA_DIR
    await dockerExecutor.setup(
      dockerContainerName,
      hostDataDir ? { dataDirMount: { hostPath: hostDataDir } } : {},
    )
  }

  try {
    const capabilityPromise = triggerCapability({
      capabilityKey,
      context: {
        taskId: `pipeline-${ctx.runId}-stage-${ctx.stageIndex}`,
        groupId: 'pipeline',
        platform: 'pipeline',
        initiatorId: 'pipeline-executor',
        initiatorRole: 'admin',
        ...(dockerContainerName ? { dockerContainerName } : {}),
      },
      extraParams: resolvedParams,
      _suppressInvocationLog: true,
    })
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('capability 执行超时')), timeoutMs),
    )
    const result = await Promise.race([capabilityPromise, timeoutPromise])
    return {
      status: result.success ? 'success' : 'failed',
      output: result.output ?? '',
      error: result.error,
    }
  } catch (err) {
    return { status: 'failed', output: `capability 执行失败: ${String(err)}`, error: String(err) }
  } finally {
    if (dockerExecutor) {
      await dockerExecutor.teardown().catch((e) =>
        console.warn('[executor-hooks] runCapability container teardown failed:', e),
      )
    }
  }
},
```

- [ ] **Step 4: 跑单测确认通过**

Run: `npx vitest run src/__tests__/unit/executor-hooks-container.test.ts`
Expected: PASS（4/4）。

- [ ] **Step 5: 跑现有 pipeline 集成测确认零回归**

Run: `npx vitest run src/__tests__/integration/pipeline-capability-stage.test.ts`
Expected: PASS（capability stage 不配 containerImage 时行为完全等价）。

- [ ] **Step 6: 提交**

```bash
git add src/pipeline/executor-hooks.ts src/__tests__/unit/executor-hooks-container.test.ts
git commit -m "feat(pipeline): runCapability spins up node container and injects dockerContainerName"
```

---

## Task 7: runCustomAgent 起/拆容器 + 接入 chatops MCP server

**Files:**
- Modify: `src/pipeline/executor-hooks.ts`
- Modify: `src/__tests__/unit/executor-hooks-container.test.ts`（追加 custom 用例）

- [ ] **Step 1: 写失败的单测（追加到 Task 6 同一文件）**

在 `src/__tests__/unit/executor-hooks-container.test.ts` 顶部新增 mock：

```typescript
const porygonRunSpy = vi.fn()
vi.mock('@snack-kit/porygon', () => ({
  createPorygon: () => ({ run: porygonRunSpy, query: vi.fn() }),
}))
vi.mock('../../agent/claude-config.js', () => ({
  buildClaudeEnv: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'fake' }),
}))
```

底部追加 describe 块：

```typescript
describe('runCustomAgent container + MCP', () => {
  const customStage: StageDefinition = {
    name: 'cust', stageType: 'llm_agent',
    customPrompt: 'do X',
    containerImage: 'python:3.11',
    allowedTools: ['mcp__chatops__run_command'],
    timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
  } as StageDefinition

  beforeEach(() => {
    setupSpy.mockReset(); teardownSpy.mockReset(); porygonRunSpy.mockReset()
    setupSpy.mockResolvedValue(undefined); teardownSpy.mockResolvedValue(undefined)
  })

  it('always injects chatops mcpServer + dockerContainerName in CHATOPS_TASK_CONTEXT env', async () => {
    porygonRunSpy.mockResolvedValue('done')
    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCustomAgent!(customStage, ctxBase)
    expect(setupSpy).toHaveBeenCalled()
    const [, runOpts] = porygonRunSpy.mock.calls[0]
    expect(runOpts.mcpServers).toHaveProperty('chatops')
    expect(runOpts.onlyTools).toEqual(['mcp__chatops__run_command'])
    const tc = JSON.parse(runOpts.envVars.CHATOPS_TASK_CONTEXT)
    expect(tc.dockerContainerName).toBe(`chatops-cust-${ctxBase.runId}-${ctxBase.stageIndex}`)
    expect(teardownSpy).toHaveBeenCalled()
    expect(r.status).toBe('success')
  })

  it('without containerImage: still injects chatops mcpServer; no dockerContainerName', async () => {
    porygonRunSpy.mockResolvedValue('ok')
    const hooks = buildDefaultHooks('/tmp/log')
    await hooks.runCustomAgent!({ ...customStage, containerImage: undefined }, { ...ctxBase, pipelineContainerImage: undefined } as StageContext)
    const [, runOpts] = porygonRunSpy.mock.calls[0]
    expect(runOpts.mcpServers).toHaveProperty('chatops')
    const tc = JSON.parse(runOpts.envVars.CHATOPS_TASK_CONTEXT)
    expect(tc.dockerContainerName).toBeUndefined()
    expect(setupSpy).not.toHaveBeenCalled()
  })

  it('teardown called even if porygon throws', async () => {
    porygonRunSpy.mockRejectedValue(new Error('claude crashed'))
    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCustomAgent!(customStage, ctxBase)
    expect(teardownSpy).toHaveBeenCalled()
    expect(r.status).toBe('failed')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/unit/executor-hooks-container.test.ts`
Expected: FAIL（mcpServers 还没注入）。

- [ ] **Step 3: 实现 runCustomAgent 改造**

`src/pipeline/executor-hooks.ts`，整段替换 `runCustomAgent`：

```typescript
async runCustomAgent(
  stage: StageDefinition,
  ctx: StageContext,
  triggerParams: Record<string, unknown> = {},
  runtimeVars: Record<string, unknown> = {},
): Promise<StageExecutionResult> {
  const rawPrompt = stage.customPrompt ?? ''
  if (!rawPrompt.trim()) return { status: 'failed', output: '', error: 'customPrompt is empty' }

  // 展开模板（保留现有逻辑）
  const coercedVars: Record<string, string> = {}
  for (const [k, v] of Object.entries(runtimeVars)) {
    coercedVars[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  const varCtx: VariableContext = {
    productLine: ctx.productLine ?? { name: '', displayName: '' },
    pipeline: ctx.pipeline ?? { id: 0, name: '' },
    run: ctx.run ?? { id: ctx.runId, triggeredBy: '', triggerType: '' },
    stage: { name: stage.name, index: ctx.stageIndex },
    server: { host: '', port: 0, username: '', name: '', role: '' },
    vars: { ...(ctx.variables ?? {}), ...coercedVars },
    triggerParams,
  }
  const prompt = resolveVariables(rawPrompt, varCtx)

  // 容器生命周期
  const ctxBase = ctx as StageContext & { pipelineContainerImage?: string }
  const effectiveImage = stage.containerImage?.trim() || ctxBase.pipelineContainerImage?.trim()
  let dockerExecutor: DockerExecutor | undefined
  let dockerContainerName: string | undefined
  if (effectiveImage) {
    dockerContainerName = `chatops-cust-${ctx.runId}-${ctx.stageIndex}`
    dockerExecutor = new DockerExecutor(effectiveImage)
    const hostDataDir = process.env.HOST_TEST_DATA_DIR
    await dockerExecutor.setup(
      dockerContainerName,
      hostDataDir ? { dataDirMount: { hostPath: hostDataDir } } : {},
    )
  }

  // allowedTools 白名单（custom 模式总是走 onlyTools，未选则空白名单 = 仅纯推理）
  const allowedTools = Array.isArray(stage.allowedTools) && stage.allowedTools.length > 0
    ? stage.allowedTools : []
  const timeoutMs = (stage.timeoutSeconds ?? 120) * 1000

  // 始终接入 chatops MCP server
  const mcpServerPath = join(__dirname, '..', 'agent', 'mcp-server.ts')
  const taskContext = {
    taskId: `pipeline-cust-${ctx.runId}-${ctx.stageIndex}`,
    groupId: 'pipeline',
    platform: 'pipeline',
    initiatorId: 'pipeline-executor',
    initiatorRole: 'admin' as const,
    cwd: ctx.logDir,
    ...(dockerContainerName ? { dockerContainerName } : {}),
  }

  const porygon = createPorygon({
    defaultBackend: 'claude',
    backends: {
      claude: {
        model: 'sonnet', interactive: false,
        cliPath: join(__dirname, '..', '..', 'node_modules', '.bin', 'claude'),
      },
    },
    defaults: { maxTurns: 10 },
  })

  const claudeEnv = await buildClaudeEnv()
  try {
    const result = await porygon.run({
      prompt,
      timeoutMs,
      onlyTools: allowedTools,
      mcpServers: {
        chatops: {
          command: 'node',
          args: ['--import', 'tsx/esm', mcpServerPath],
          env: {
            ...(process.env as Record<string, string>),
            CHATOPS_TASK_CONTEXT: JSON.stringify(taskContext),
            DATABASE_URL: process.env.DATABASE_URL ?? '',
            ...claudeEnv,
          },
        },
      },
      envVars: {
        ...claudeEnv,
        CHATOPS_TASK_CONTEXT: JSON.stringify(taskContext),
      },
    })
    return { status: 'success', output: String(result).trim() }
  } catch (err) {
    return { status: 'failed', output: `custom agent 执行失败 [${stage.name}]: ${String(err)}`, error: String(err) }
  } finally {
    if (dockerExecutor) {
      await dockerExecutor.teardown().catch((e) =>
        console.warn('[executor-hooks] runCustomAgent container teardown failed:', e),
      )
    }
  }
},
```

注意事项写在代码上方注释里（仅一行 WHY 注释）：

```typescript
// custom 模式：onlyTools 即使为空数组也比裸 disallowedTools 更严格——空白名单 = 禁所有工具
// 包括 Bash/Read/Edit；这是 spec §2.3 的语义。
```

- [ ] **Step 4: 跑单测确认通过**

Run: `npx vitest run src/__tests__/unit/executor-hooks-container.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 跑 typecheck 和现有 custom-agent 测试**

Run: `pnpm typecheck`
Expected: 通过。

Run: `npx vitest run src/__tests__/unit/llm-agent-output-format.test.ts`
Expected: PASS（仅检查 outputFormat，不直接断 mcpServers）。

- [ ] **Step 6: 提交**

```bash
git add src/pipeline/executor-hooks.ts src/__tests__/unit/executor-hooks-container.test.ts
git commit -m "feat(pipeline): runCustomAgent always injects chatops MCP server + container lifecycle"
```

---

## Task 8: Admin /tools 路由

**Files:**
- Create: `src/admin/routes/tools.ts`
- Modify: `src/admin/index.ts`
- Create: `src/__tests__/integration/admin-tools-route.test.ts`

- [ ] **Step 1: 写失败的集成测**

Create: `src/__tests__/integration/admin-tools-route.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { resetTestDb } from '../helpers/db.js'
import { registerToolsRoutes } from '../../admin/routes/tools.js'
// 任意已注册的工具，用于断言列表非空
import '../../agent/tools/run-command.js'

let app: FastifyInstance

beforeAll(async () => {
  await resetTestDb()
  app = Fastify()
  await registerToolsRoutes(app)
  await app.ready()
})

afterAll(async () => { await app.close() })

describe('GET /admin/tools', () => {
  it('returns the registered tool catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/tools' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ name: string; description: string; riskLevel: string }>
    const names = body.map(t => t.name)
    expect(names).toContain('run_command')
    const runCmd = body.find(t => t.name === 'run_command')!
    expect(runCmd.description).toMatch(/工作区/)
    expect(runCmd.riskLevel).toBe('medium')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/integration/admin-tools-route.test.ts`
Expected: FAIL（routes/tools.ts 不存在）。

- [ ] **Step 3: 实现路由**

Create: `src/admin/routes/tools.ts`

```typescript
import type { FastifyInstance } from 'fastify'
import { getAllTools } from '../../agent/tools/index.js'
import { DEFAULT_TOOL_ROLES } from '../../agent/tools/types.js'

export async function registerToolsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/tools', async () => {
    return getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      riskLevel: t.riskLevel,
      requiredRole: t.requiredRole ?? null,
      defaultRoles: DEFAULT_TOOL_ROLES[t.name] ?? null,
    }))
  })
}
```

- [ ] **Step 4: 在 admin/index.ts 注册**

`src/admin/index.ts` 上半部 import 区追加：

```typescript
import { registerToolsRoutes } from './routes/tools.js'
```

`registerAdminRoutes` 函数体内（与其他 `await registerXxx(app)` 同级）追加：

```typescript
await registerToolsRoutes(app)
```

- [ ] **Step 5: 跑集成测确认通过**

Run: `npx vitest run src/__tests__/integration/admin-tools-route.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/admin/routes/tools.ts src/admin/index.ts src/__tests__/integration/admin-tools-route.test.ts
git commit -m "feat(admin): add GET /admin/tools to expose registered MCP tool catalog"
```

---

## Task 9: 前端：api/tools.ts + NodeInspector 改造 + pruneStageFields

**Files:**
- Create: `web/src/api/tools.ts`
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`
- Modify: `web/src/pipeline-canvas/panels/pruneStageFields.ts`
- Modify: `web/src/pipeline-canvas/panels/pruneStageFields.test.ts`

- [ ] **Step 1: 创建 api/tools.ts**

```typescript
// web/src/api/tools.ts
import client from './client'

export interface ToolMeta {
  name: string
  description: string
  riskLevel: 'low' | 'medium' | 'high'
  requiredRole: string | null
  defaultRoles: string[] | null
}

export async function listTools(): Promise<ToolMeta[]> {
  const r = await client.get<ToolMeta[]>('/admin/tools')
  return r.data
}
```

- [ ] **Step 2: 给 pruneStageFields 加 llm_agent 保留逻辑 + 测试**

`web/src/pipeline-canvas/panels/pruneStageFields.ts:39-46`，找到现有的 `case 'script'` 一行：

```typescript
case 'script':
  return { ...base, ...cleared, script: '', containerImage: prev.stageType === 'script' ? prev.containerImage : undefined }
```

复制并扩展 llm_agent case（替换原 line 44-45）：

```typescript
case 'script':
  return {
    ...base, ...cleared, script: '',
    containerImage: (prev.stageType === 'script' || prev.stageType === 'llm_agent') ? prev.containerImage : undefined,
  }
case 'llm_agent':
  return {
    ...base, ...cleared,
    capabilityKey: '', capabilityParams: {}, agentMode: 'capability',
    containerImage: (prev.stageType === 'script' || prev.stageType === 'llm_agent') ? prev.containerImage : undefined,
  }
```

`web/src/pipeline-canvas/panels/pruneStageFields.test.ts` 末尾（在最后一个 `})` 前）追加：

```typescript
describe('containerImage retention across stageType switches', () => {
  it('script → llm_agent: containerImage retained', () => {
    const next = pruneStageFields(base('script', { containerImage: 'node:18' }), 'llm_agent')
    expect(next.containerImage).toBe('node:18')
  })
  it('llm_agent → script: containerImage retained', () => {
    const next = pruneStageFields(base('llm_agent', { containerImage: 'python:3.11' }), 'script')
    expect(next.containerImage).toBe('python:3.11')
  })
  it('llm_agent → approval: containerImage cleared', () => {
    const next = pruneStageFields(base('llm_agent', { containerImage: 'go:1.21' }), 'approval')
    expect(next.containerImage).toBeUndefined()
  })
  it('script → approval: containerImage cleared', () => {
    const next = pruneStageFields(base('script', { containerImage: 'node:18' }), 'approval')
    expect(next.containerImage).toBeUndefined()
  })
})
```

跑测试：

Run: `cd web && npx vitest run src/pipeline-canvas/panels/pruneStageFields.test.ts`
Expected: 全部 PASS（4 个新用例 + 现有用例）。

- [ ] **Step 3: NodeInspector 改造 — llm_agent 显示 containerImage（两种 mode 都显示）**

`web/src/pipeline-canvas/panels/NodeInspector.tsx`，先在文件顶部 import 区添加：

```tsx
import { listTools, type ToolMeta } from '../../api/tools'
```

`NodeInspector` 函数体内（与 `capabilities` 等 prop 同级）加 state：

```tsx
const [mcpTools, setMcpTools] = useState<ToolMeta[]>([])
useEffect(() => {
  listTools().then(setMcpTools).catch(() => {})
}, [])
```

定位到 line 405（`if (t === 'llm_agent') {`）整段，把 `agentMode === 'custom' ? (...) : (...)` 三元结构调整为：先渲染共用的"模式切换 + containerImage 输入"，然后按 mode 分支：

```tsx
if (t === 'llm_agent') {
  const agentMode = (getFieldValue('agentMode') as string | undefined) ?? 'capability'
  const selectedKey = getFieldValue('capabilityKey') as string | undefined
  const selected = capabilities.find(c => c.key === selectedKey)
  const allowed = (getFieldValue('allowedTools') as string[] | undefined) ?? []
  const containerImage = getFieldValue('containerImage') as string | undefined
  const hasRunCommand = allowed.some(
    (v) => v === 'run_command' || v === 'mcp__chatops__run_command',
  )

  return (
    <>
      <Form.Item label="模式" name="agentMode" initialValue="capability">
        <Radio.Group>
          <Radio.Button value="capability">已有能力</Radio.Button>
          <Radio.Button value="custom">自定义</Radio.Button>
        </Radio.Group>
      </Form.Item>

      <Form.Item
        name="containerImage"
        label="运行容器镜像（可选）"
        extra={
          pipelineContainerImage
            ? `留空则继承 pipeline 默认：${pipelineContainerImage}。配置后 Bash 内置工具自动禁用，shell 命令需走 run_command 工具。`
            : '留空则在 chatops 容器内执行。配置后 Bash 内置工具自动禁用，shell 命令需走 run_command 工具。'
        }
      >
        <Input placeholder="例如 harbor.xxx/golang:1.21" allowClear />
      </Form.Item>

      {agentMode === 'custom' ? (
        <>
          <Form.Item
            label="系统提示词"
            name="customPrompt"
            rules={[{ required: true, message: '自定义模式必须填写提示词' }]}
          >
            <Input.TextArea
              rows={6}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
              placeholder="告诉 Claude 要做什么。支持 {{triggerParams.xxx}} 模板变量。"
            />
          </Form.Item>

          <Form.Item
            label="可用工具"
            name="allowedTools"
            extra="不选则禁用所有工具（纯推理）。MCP 平台工具和内置工具按需勾选。"
          >
            <Select
              mode="multiple"
              placeholder="按需选择 Claude 可调用的工具"
              showSearch
              optionFilterProp="label"
              options={[
                {
                  label: '平台 MCP 工具',
                  options: mcpTools.map(t => ({
                    value: `mcp__chatops__${t.name}`,
                    label: `${t.name} — ${t.description}`,
                  })),
                },
                {
                  label: 'Claude 内置工具',
                  options: [
                    { value: 'WebFetch', label: 'WebFetch — HTTP 抓取' },
                    { value: 'WebSearch', label: 'WebSearch — 搜索' },
                  ],
                },
              ]}
            />
          </Form.Item>

          {containerImage && !hasRunCommand && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="配置了运行容器，但未选 run_command 工具，Claude 调 shell 命令将失败。"
            />
          )}

          <Form.Item name="outputFormat" label="输出格式" initialValue="string"
            extra="JSON 模式下输出必须是 JSON 对象，否则该节点失败">
            <Radio.Group>
              <Radio value="json">JSON</Radio>
              <Radio value="string">字符串</Radio>
            </Radio.Group>
          </Form.Item>
        </>
      ) : (
        <>
          <Form.Item
            name="capabilityKey"
            label="Capability"
            rules={[{ required: true, message: '请选择 Capability' }]}
          >
            <Select
              showSearch
              placeholder="选择一个 Agent Capability"
              options={capabilityOptions(capabilities, selectedKey)}
              filterOption={(input, opt) => {
                const tx = (opt as { searchText?: string } | undefined)?.searchText ?? ''
                return tx.toLowerCase().includes(input.toLowerCase())
              }}
              onChange={(newKey) => {
                const currentParams = (getFieldValue('capabilityParams') as Record<string, unknown> | undefined) ?? {}
                onChange(node!.id, { capabilityKey: newKey, capabilityParams: currentParams })
              }}
            />
          </Form.Item>
          {/* 保留现有 capabilityParams 渲染（不动） */}
        </>
      )}
    </>
  )
}
```

注意：保留 `capabilityParams` 的现有渲染块（行号视当前代码而定，原封不动放回 `</> ) : (` 分支内）。

- [ ] **Step 4: 同时移除 capability 模式独占的 containerImage 块（如有），让 containerImage 字段成为 llm_agent 的共用字段**

确认 `Form.Item shouldUpdate` 的 dep 列表覆盖到 `agentMode` 和 `containerImage`：

```tsx
<Form.Item shouldUpdate={(p, c) =>
  p.stageType !== c.stageType ||
  p.capabilityKey !== c.capabilityKey ||
  p.agentMode !== c.agentMode ||
  p.containerImage !== c.containerImage ||
  JSON.stringify(p.allowedTools) !== JSON.stringify(c.allowedTools)
} noStyle>
```

- [ ] **Step 5: 跑前端类型检查**

Run: `cd web && npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 6: 跑前端测试**

Run: `cd web && npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 7: 起 dev server 手动验证（无法在测试中端到端验证 UI）**

```bash
pnpm dev &
cd web && pnpm dev
# 浏览器 → /admin/pipelines → 编辑某 pipeline → 拖个 llm_agent 节点
```

手动检查：
1. capability 模式下"运行容器镜像"输入框可见
2. custom 模式下"可用工具"是分组下拉（平台 MCP / 内置）
3. 同时配 containerImage 但不选 run_command → 显示橙色 warning Alert
4. 切 stageType `script ↔ llm_agent` 时 containerImage 值保留
5. 切 stageType `llm_agent → approval` 时 containerImage 被清空

- [ ] **Step 8: 提交**

```bash
git add web/src/api/tools.ts web/src/pipeline-canvas/panels/NodeInspector.tsx web/src/pipeline-canvas/panels/pruneStageFields.ts web/src/pipeline-canvas/panels/pruneStageFields.test.ts
git commit -m "feat(web): expose containerImage on llm_agent + grouped allowedTools selector"
```

---

## Task 10: 基础设施（Dockerfile + docker-compose）

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Dockerfile 加 docker-ce-cli**

`Dockerfile:30` 当前是：

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.email "chatops@paraview.cn" \
 && git config --system user.name "ChatOps Agent"
```

改为：

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
    > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.email "chatops@paraview.cn" \
 && git config --system user.name "ChatOps Agent"
```

- [ ] **Step 2: docker-compose.yml 改造**

将 chatops 服务整段替换为：

```yaml
  chatops:
    build:
      context: .
      args:
        BASE_IMAGE: ${BASE_IMAGE:-harbor.paraview.cn/chatops/chatops-base:latest}
    ports:
      - "${PORT:-3000}:3000"
    env_file:
      - .env
    environment:
      DATABASE_URL: postgres://chatops:chatops@postgres:5432/chatops
      PORT: "3000"
      TEST_DATA_DIR: /data/chatops/test-runs
      HOST_TEST_DATA_DIR: /srv/chatops/test-runs
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv/chatops/test-runs:/data/chatops/test-runs
    group_add:
      - "${DOCKER_GID:-999}"
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped
```

文件末尾 `volumes:` 块仅保留 `pgdata:`，移除 `testdata:`。

- [ ] **Step 3: docker-compose.prod.yml 同步改造**

把 `chatops:` 服务 `volumes` 和 `environment` 改为：

```yaml
    environment:
      DATABASE_URL: postgres://chatops:chatops@postgres:5432/chatops
      PORT: "3000"
      TEST_DATA_DIR: /data/chatops/test-runs
      HOST_TEST_DATA_DIR: /srv/chatops/test-runs
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv/chatops/test-runs:/data/chatops/test-runs
    group_add:
      - "${DOCKER_GID:-999}"
```

底部 `volumes:` 移除 `testdata:`。

- [ ] **Step 4: 部署 readme 提示**

确认 `docs/` 中是否有部署说明涉及 testdata named volume；若有，更新提示宿主机需 `mkdir -p /srv/chatops/test-runs && chown 1000:1000` 并把 `DOCKER_GID=$(getent group docker | cut -d: -f3)` 写进 `.env`。

Run: `grep -rn "testdata" docs/ deploy.sh 2>/dev/null`
Expected: 列出引用，逐个更新或加迁移说明。

- [ ] **Step 5: 提交**

```bash
git add Dockerfile docker-compose.yml docker-compose.prod.yml
# 如有 docs 修改也加上
git commit -m "feat(infra): enable DooD via docker socket mount + bind-mount testdata"
```

---

## Task 11: 端到端真实 docker 集成测（runCapability 起容器全链路）

**Files:**
- Create: `src/__tests__/integration/executor-hooks-real-docker.test.ts`

测的是：runCapability hook 自己的容器生命周期与 dockerContainerName 注入；triggerCapability stub 出来仅用来捕获 ctx 内容（避免依赖 Claude CLI / OAuth）。

- [ ] **Step 1: 写集成测**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { execSync } from 'child_process'

const triggerSpy = vi.fn()
vi.mock('../../agent/coordinator.js', () => ({ triggerCapability: triggerSpy }))

import { buildDefaultHooks } from '../../pipeline/executor-hooks.js'
import type { StageDefinition, StageContext } from '../../pipeline/types.js'

const hasDocker = (() => {
  try { execSync('docker version --format ok', { stdio: 'pipe' }); return true } catch { return false }
})()

describe.skipIf(!hasDocker)('runCapability with real docker', () => {
  it('creates container, exposes name in ctx, removes after run', async () => {
    let observedContainer: string | undefined
    triggerSpy.mockImplementation(async (call: { context: { dockerContainerName?: string } }) => {
      observedContainer = call.context.dockerContainerName
      // 在容器存在期间断言 docker ps 能看到
      const ps = execSync(`docker ps --filter name=^/${observedContainer}$ --format '{{.Names}}'`, { stdio: 'pipe' }).toString().trim()
      expect(ps).toBe(observedContainer)
      return { success: true, output: 'ok' }
    })

    const stage: StageDefinition = {
      name: 's', stageType: 'llm_agent',
      capabilityKey: 'analyze_bug',
      containerImage: 'alpine:3.19',
      timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
    } as StageDefinition

    const ctx = { runId: Date.now(), stageIndex: 0, servers: {}, logDir: '/tmp/log' } as unknown as StageContext

    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCapability!(stage, ctx)
    expect(r.status).toBe('success')
    expect(observedContainer).toMatch(/^chatops-cap-/)

    // teardown 应该已删容器
    const after = execSync(`docker ps -a --filter name=^/${observedContainer}$ --format '{{.Names}}'`, { stdio: 'pipe' }).toString().trim()
    expect(after).toBe('')
  }, 90_000)
})
```

- [ ] **Step 2: 跑集成测**

Run: `npx vitest run src/__tests__/integration/executor-hooks-real-docker.test.ts`
Expected: PASS（如有 docker）/ SKIPPED（如无）。

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/integration/executor-hooks-real-docker.test.ts
git commit -m "test(pipeline): runCapability container lifecycle with real docker"
```

---

## Task 12: 全套回归 + 文档冒烟手册

**Files:**
- Create: `docs/smoke-pipeline-dood.md`

- [ ] **Step 1: 全套测试一次过**

Run: `./test.sh`
Expected: 全部 PASS（含新增单测/集成测；docker 类集成测在无 docker 环境跳过）。

- [ ] **Step 2: 写冒烟手册**

Create: `docs/smoke-pipeline-dood.md`

```markdown
# Pipeline DooD 冒烟

## 前置
- 宿主机 `/srv/chatops/test-runs` 存在且属主 1000:1000
- `.env` 含 `DOCKER_GID=<getent group docker | cut -d: -f3>`
- chatops 容器内 `docker version` 正常

## 用例 1：script 节点继承 pipeline 镜像
1. 新建 pipeline，pipeline 设置中容器镜像 `harbor.xxx/golang:1.21`
2. 加 script 节点 `go version`，触发 dry-run
3. 应输出 go1.21 版本号

## 用例 2：llm_agent capability 用节点级镜像
1. 加 llm_agent → 选 capability `analyze_bug` → 节点镜像 `python:3.11`
2. 触发执行，观察 docker logs：
   - `docker pull python:3.11`
   - `docker run -d --name chatops-cap-<runId>-<idx>`
   - capability 结束后 `docker rm -f`

## 用例 3：custom 模式 + run_command 路由进容器
1. 加 llm_agent → custom → containerImage=`harbor.xxx/golang:1.21`
2. allowedTools 选 `mcp__chatops__run_command`
3. customPrompt：`使用 run_command 跑 'go version'，把输出贴出来`
4. 应看到容器内的 go1.21，不是 chatops 容器（chatops 内无 go）

## 用例 4：未选 run_command 的 warning
1. 同上但 allowedTools 留空
2. UI 立刻显示橙色 Alert
3. 触发执行：容器照常起停，Claude 跑不了 shell（log 无 docker exec）
```

- [ ] **Step 3: 提交**

```bash
git add docs/smoke-pipeline-dood.md
git commit -m "docs: add pipeline DooD smoke runbook"
```

---

## 自检清单（做完前再过一遍）

1. **Spec 覆盖**
   - §3.5 custom 模式接入 chatops MCP server → Task 7
   - §3.6 containerImage × allowedTools 矩阵 → Task 7（后端）+ Task 9（前端 warning）
   - §4 基础设施（socket / bind mount / group_add）→ Task 10
   - §5.1 SetupOptions → Task 2
   - §5.2 TaskContext.dockerContainerName → Task 1
   - §5.3 run_command 工具 + run_tests 别名 → Task 3, 4
   - §5.4 GET /admin/tools → Task 8
   - §5.5 runCapability 起容器 → Task 6
   - §5.6 runCustomAgent 起容器 + 接 MCP server → Task 7
   - §5.7/5.8 pipelineContainerImage 透传 → Task 5
   - §6.1 NodeInspector llm_agent UI → Task 9
   - §6.2 pruneStageFields → Task 9
   - **测试基础设施**：开发机一键装 docker / node / pnpm / psql + 预拉 alpine:3.19 → Task 0（扩展 `--setup-env`）

2. **测试覆盖**（"能不 mock 不 mock"）：
   - DockerExecutor：mock spawn 单测 + 真 docker 集成测 ✓
   - run_command：mock exec 单测 + 真 docker 集成测 ✓
   - run-tests 别名：纯单测 ✓
   - executor-hooks（runCapability/runCustomAgent）：mock 边界仅在 DockerExecutor 和 createPorygon／triggerCapability ✓；外加真 docker 集成测覆盖 runCapability 全链路
   - /admin/tools：真 fastify + 真 DB（resetTestDb）✓
   - 前端 pruneStageFields：纯单测 ✓
   - 前端 UI 行为：手动冒烟（无法在无浏览器测试中端到端）

3. **类型一致性**：
   - `dockerContainerName` 字段命名在 TaskContext / runCapability / runCustomAgent / 测试断言全用同名 ✓
   - 容器名前缀：`chatops-cap-<runId>-<idx>`（capability）/ `chatops-cust-<runId>-<idx>`（custom）—— 与 spec §5.5/5.6 一致 ✓
   - 工具名 `run_command`（与 spec §2.4 一致）；MCP 暴露形式 `mcp__chatops__run_command`（前端 value 字段）✓

4. **边界**：
   - 同时未配 stage.containerImage 和 pipelineContainerImage → 不起容器（Task 6 测试覆盖）
   - triggerCapability 抛异常 → teardown 仍调（Task 6 测试覆盖）
   - porygon.run 抛异常 → teardown 仍调（Task 7 测试覆盖）
   - 无 docker 环境 → 真集成测 skipIf 跳过，不阻塞 CI（前提：CI 环境有 DinD）

---

## Execution Handoff

计划已写入 `docs/superpowers/plans/2026-04-29-pipeline-dood-impl.md`。
