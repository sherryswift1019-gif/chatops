/**
 * Quick-Impl 自有 Sandbox / Workspace 管理
 *
 * 设计：docs/prds/prd-quick-impl-e2e-phase2.md - "QI 自有 sandbox/workspace 管理"
 *
 * 完全独立于 pipeline-b（不写 e2e_sandboxes 表，不依赖 pipeline-b 任何模块）。
 * 直接用 deploy.sh 协议（target 项目自维护脚本）+ 本地 bare repo 当 origin。
 *
 * Sandbox 单源：sandboxDir 下 `.qi-handle.json` 存 deploy.sh provision 返回的
 * envId/endpoints。chatops 重启后由 worker.ts cleanup tick 扫这个目录反推清理。
 */
import { exec } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { runScript } from '../e2e/pipeline-b/run-script.js'
import { getE2eTargetProject } from '../db/repositories/e2e-target-projects.js'
import { resolveDataDir } from '../pipeline/data-dir.js'

const execAsync = promisify(exec)

/** sandbox workspace 根目录。生产经 docker-compose 显式设 TEST_DATA_DIR；本地 dev 走 resolveDataDir() 兜底（<cwd>/var/test-runs）。 */
export const QI_SANDBOX_DIR_BASE =
  process.env.QI_SANDBOX_DIR_BASE ??
  join(resolveDataDir(), 'qi-workspaces')

const QI_HANDLE_FILENAME = '.qi-handle.json'

export interface QiSandboxHandle {
  /** sandbox workspace 路径（chatops 容器内可见） */
  sandboxDir: string
  /** deploy.sh provision 返回的环境 id（用于 teardown） */
  envId: string
  /** sandbox 容器 / VM 等的 kind（docker-compose-local 等） */
  kind: string
  /** Playwright 跑断言用：服务对外端点 */
  endpoints: Record<string, string>
  /** Playwright 跑断言用（可选） */
  containerId?: string
  /** 容器内的 workdir（可选） */
  workdir?: string
  /** Provider 内部引用（默认 {}）。required 是为了兼容 pipeline-b SandboxHandle 类型 */
  internalRefs: Record<string, unknown>
  /** 反向追溯：sandbox 属于哪个 QI requirement / attempt */
  requirementId: number
  attempt: number
  /** 给 cleanup 用：deploy.sh 路径，teardown 时直接复用 */
  deployScript: string
  targetProjectId: string
}

/**
 * sandbox provision 阶段失败的特殊错误类型。
 *
 * QI graph 里识别此错误走"基础设施失败"分支（IM 卡片 retry/abort 二值），
 * 不进 dev-loop fix-loop（dev-loop 改不动 docker / deploy.sh / target main 健康）。
 */
export class SandboxProvisionError extends Error {
  readonly stage: 'git-clone' | 'deploy-provision' | 'parse-handle'
  readonly stderr: string

  constructor(stage: SandboxProvisionError['stage'], message: string, stderr = '') {
    super(message)
    this.name = 'SandboxProvisionError'
    this.stage = stage
    this.stderr = stderr
  }
}

export interface ProvisionQiSandboxOptions {
  requirementId: number
  attempt: number
  /** 本地 bare 仓路径，sandbox 从这里 clone（不经 GitLab） */
  bareRepoPath: string
  /** QI 分支名（feat/qi-{requirementId}） */
  branch: string
  /** 反查 e2e_target_projects.scripts.deploy 用 */
  targetProjectId: string
  /** Optional：覆盖 sandbox 路径根（测试用） */
  sandboxDirBase?: string
}

function buildSandboxDir(reqId: number, attempt: number, base?: string): string {
  return join(base ?? QI_SANDBOX_DIR_BASE, `qi-${reqId}`, `attempt-${attempt}`)
}

function validateBranchName(branch: string): void {
  if (!/^[a-zA-Z0-9_./-]+$/.test(branch)) {
    throw new Error(`[qi-sandbox] invalid branch name: ${branch}`)
  }
}

/**
 * Provision QI 专用 sandbox：
 *   1. mkdir sandboxDir
 *   2. git clone <bareRepo> <sandboxDir> --branch <branch>
 *   3. 反查 e2e_target_projects.scripts.deploy
 *   4. deploy.sh provision --branch=<branch> --out-handle=<sandboxDir>/.qi-handle.json
 *   5. 解析 handle.json → 返回 QiSandboxHandle
 *
 * 任一步失败 → 抛 SandboxProvisionError，外层路由识别走 qi_sandbox_failed 分支。
 */
export async function provisionQiSandbox(
  opts: ProvisionQiSandboxOptions,
): Promise<QiSandboxHandle> {
  validateBranchName(opts.branch)

  const project = await getE2eTargetProject(opts.targetProjectId)
  if (!project) {
    throw new SandboxProvisionError(
      'parse-handle',
      `e2e_target_projects: "${opts.targetProjectId}" not found`,
    )
  }
  const deployScriptName = project.scripts?.deploy ?? 'deploy.sh'

  const sandboxDir = buildSandboxDir(opts.requirementId, opts.attempt, opts.sandboxDirBase)

  if (existsSync(sandboxDir)) {
    rmSync(sandboxDir, { recursive: true, force: true })
  }
  mkdirSync(sandboxDir, { recursive: true })

  // 1) git clone 本地 bare 当 origin
  try {
    await execAsync(
      `git clone --branch ${opts.branch} ${opts.bareRepoPath} ${sandboxDir}`,
      { timeout: 60_000 },
    )
  } catch (err) {
    const stderr = (err as Error & { stderr?: string }).stderr ?? String(err)
    throw new SandboxProvisionError(
      'git-clone',
      `git clone failed: ${stderr.slice(0, 300)}`,
      stderr,
    )
  }

  const deployScript = join(sandboxDir, deployScriptName)
  if (!existsSync(deployScript)) {
    throw new SandboxProvisionError(
      'parse-handle',
      `deploy script not found: ${deployScript}`,
    )
  }

  // 2) deploy.sh provision
  const handleFile = join(sandboxDir, QI_HANDLE_FILENAME)
  const result = await runScript(
    deployScript,
    ['provision', `--branch=${opts.branch}`, `--out-handle=${handleFile}`],
    {
      timeout: 600_000,
      cwd: sandboxDir,
      env: {
        // 同 pipeline-b/setup-sandbox 的 env：chatops 容器内调时 PG host 用 docker DNS 别名
        PG_HOST: 'postgres',
        // 清空避免 deploy.sh 跳过 CREATE DATABASE + migrate
        E2E_SANDBOX_DB_URL: '',
      },
    },
  )

  if (result.exitCode !== 0) {
    throw new SandboxProvisionError(
      'deploy-provision',
      `deploy.sh provision exited ${result.exitCode}: ${result.stderr.slice(0, 300)}`,
      result.stderr,
    )
  }

  // 3) 解析 handle.json
  if (!existsSync(handleFile)) {
    throw new SandboxProvisionError(
      'parse-handle',
      `handle file not written: ${handleFile}`,
      result.stderr,
    )
  }

  let handleJson: Record<string, unknown>
  try {
    handleJson = JSON.parse(readFileSync(handleFile, 'utf8'))
  } catch (err) {
    throw new SandboxProvisionError(
      'parse-handle',
      `handle file invalid JSON: ${(err as Error).message}`,
    )
  }

  // 把节点级追溯信息也写进 handle，给 cleanup tick 用
  const enrichedHandle: QiSandboxHandle = {
    sandboxDir,
    envId: handleJson.envId as string,
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    endpoints: (handleJson.endpoints as Record<string, string>) ?? {},
    containerId: handleJson.containerId as string | undefined,
    workdir: handleJson.workdir as string | undefined,
    internalRefs: (handleJson.internalRefs as Record<string, unknown>) ?? {},
    requirementId: opts.requirementId,
    attempt: opts.attempt,
    deployScript,
    targetProjectId: opts.targetProjectId,
  }

  // 把 enriched handle 重新写回 .qi-handle.json，让 cleanup tick 可以脱离 graph state 自给自足
  writeFileSync(handleFile, JSON.stringify(enrichedHandle, null, 2))

  return enrichedHandle
}

/**
 * Teardown QI sandbox：调 deploy.sh teardown 释放资源 + rm -rf sandbox 目录。
 *
 * teardown 失败时不抛，只 log（避免 finally 中失败掩盖原始 scenario error）；
 * 残留的 sandbox 由 worker.ts cleanup tick 30min 后兜底清。
 */
export async function teardownQiSandbox(handle: QiSandboxHandle): Promise<void> {
  if (!existsSync(handle.deployScript)) {
    // sandboxDir 已被外部清掉？直接静默
    rmSync(handle.sandboxDir, { recursive: true, force: true })
    return
  }

  const handleFile = join(handle.sandboxDir, QI_HANDLE_FILENAME)
  const result = await runScript(
    handle.deployScript,
    ['teardown', `--handle=${handleFile}`],
    { timeout: 300_000, cwd: handle.sandboxDir },
  )

  if (result.exitCode !== 0) {
    console.warn(
      `[qi-sandbox] teardown exit ${result.exitCode} (envId=${handle.envId}): ${result.stderr.slice(0, 200)}`,
    )
  }

  rmSync(handle.sandboxDir, { recursive: true, force: true })
}

/**
 * 从 sandbox dir 路径反推 requirementId / attempt（孤儿 cleanup 用）。
 *
 * 路径格式：<base>/qi-<requirementId>/attempt-<attempt>/
 * 返回 null 表示路径不匹配格式。
 */
export function parseSandboxDir(
  sandboxDir: string,
): { requirementId: number; attempt: number } | null {
  const m = sandboxDir.match(/qi-(\d+)\/attempt-(\d+)\/?$/)
  if (!m) return null
  return {
    requirementId: parseInt(m[1], 10),
    attempt: parseInt(m[2], 10),
  }
}

/**
 * 从 sandboxDir 内的 .qi-handle.json 读 handle（chatops 重启后从文件系统恢复）。
 * 文件缺失或解析失败 → 返回 null。
 */
export function loadHandleFromSandbox(sandboxDir: string): QiSandboxHandle | null {
  const handleFile = join(sandboxDir, QI_HANDLE_FILENAME)
  if (!existsSync(handleFile)) return null
  try {
    return JSON.parse(readFileSync(handleFile, 'utf8')) as QiSandboxHandle
  } catch {
    return null
  }
}
