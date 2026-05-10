import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { exec } from 'child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)

// 覆盖 sandbox dir base + bare base 后再 dynamic import
const TEST_BASE = mkdtempSync(join(tmpdir(), 'qi-sandbox-test-'))
const SANDBOX_BASE = join(TEST_BASE, 'sandbox')
const BARE_BASE = join(TEST_BASE, 'bare')
process.env.QI_SANDBOX_DIR_BASE = SANDBOX_BASE
process.env.QI_LOCAL_REMOTE_BASE = BARE_BASE

// mock e2e-target-projects DB 调用，避免依赖真实库
vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn(async (id: string) => ({
    id,
    name: `mock-${id}`,
    gitlabRepo: 'mock/repo',
    defaultBranch: 'main',
    scripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
    metadata: {},
  })),
}))

const sandbox = await import('../../quick-impl/qi-sandbox.js')
const bareRepo = await import('../../quick-impl/qi-bare-repo.js')

/** 创建一个含 deploy.sh 桩的本地 bare repo，模拟 target 项目 */
async function makeMockTargetBare(opts: {
  bareName: string
  branch: string
  /** deploy.sh 的内容（必须可执行 + 实现 provision/teardown 子命令） */
  deployScriptContent: string
}): Promise<string> {
  // 1. 用 work repo 写 deploy.sh 然后 push 到 bare
  const workRepo = mkdtempSync(join(TEST_BASE, 'mock-target-work-'))
  await execAsync(`git init -b ${opts.branch}`, { cwd: workRepo })
  await execAsync('git config user.email "t@t.t"', { cwd: workRepo })
  await execAsync('git config user.name "t"', { cwd: workRepo })

  writeFileSync(join(workRepo, 'deploy.sh'), opts.deployScriptContent)
  chmodSync(join(workRepo, 'deploy.sh'), 0o755)

  await execAsync('git add deploy.sh', { cwd: workRepo })
  await execAsync('git commit -m "init"', { cwd: workRepo })

  // 2. 创建 bare 仓
  const bare = await bareRepo.ensureBareRepo(opts.bareName)
  await bareRepo.pushToBare(workRepo, opts.branch, bare)

  return bare
}

const VALID_DEPLOY_SH = `#!/bin/bash
# mock deploy.sh that implements provision/teardown
case "$1" in
  provision)
    # 解析 --out-handle=...
    for arg in "$@"; do
      case "$arg" in
        --out-handle=*) HANDLE="\${arg#*=}" ;;
      esac
    done
    cat > "$HANDLE" <<EOF
{
  "envId": "test-env-123",
  "kind": "docker-compose-local",
  "endpoints": { "web": "http://localhost:8080" },
  "containerId": "abc123",
  "workdir": "/app"
}
EOF
    exit 0
    ;;
  teardown)
    exit 0
    ;;
  *)
    echo "unknown sub-command: $1" >&2
    exit 1
    ;;
esac
`

const FAILING_DEPLOY_SH = `#!/bin/bash
echo "boom" >&2
exit 7
`

const BAD_HANDLE_DEPLOY_SH = `#!/bin/bash
case "$1" in
  provision)
    # 故意不写 handle 文件
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`

describe('qi-sandbox', () => {
  beforeEach(() => {
    rmSync(SANDBOX_BASE, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(TEST_BASE, { recursive: true, force: true })
  })

  describe('provisionQiSandbox', () => {
    it('成功 provision：clone + deploy.sh + 解析 handle', async () => {
      await makeMockTargetBare({
        bareName: 'group/p1',
        branch: 'feat/qi-1',
        deployScriptContent: VALID_DEPLOY_SH,
      })

      const handle = await sandbox.provisionQiSandbox({
        requirementId: 1,
        attempt: 1,
        bareRepoPath: join(BARE_BASE, 'group-p1.git'),
        branch: 'feat/qi-1',
        targetProjectId: 'p1',
      })

      expect(handle.envId).toBe('test-env-123')
      expect(handle.kind).toBe('docker-compose-local')
      expect(handle.endpoints).toEqual({ web: 'http://localhost:8080' })
      expect(handle.requirementId).toBe(1)
      expect(handle.attempt).toBe(1)
      expect(handle.sandboxDir).toContain('qi-1/attempt-1')
      expect(handle.targetProjectId).toBe('p1')
      expect(existsSync(handle.deployScript)).toBe(true)

      // .qi-handle.json 应被回写为 enriched 版本
      const persistedHandle = JSON.parse(
        readFileSync(join(handle.sandboxDir, '.qi-handle.json'), 'utf8'),
      )
      expect(persistedHandle.requirementId).toBe(1)
      expect(persistedHandle.deployScript).toContain('deploy.sh')
    })

    it('git clone 失败 → SandboxProvisionError stage=git-clone', async () => {
      await expect(
        sandbox.provisionQiSandbox({
          requirementId: 2,
          attempt: 1,
          bareRepoPath: join(BARE_BASE, 'nonexistent.git'),
          branch: 'feat/qi-2',
          targetProjectId: 'p2',
        }),
      ).rejects.toMatchObject({
        name: 'SandboxProvisionError',
        stage: 'git-clone',
      })
    })

    it('deploy.sh provision 失败 → SandboxProvisionError stage=deploy-provision', async () => {
      await makeMockTargetBare({
        bareName: 'group/p3',
        branch: 'feat/qi-3',
        deployScriptContent: FAILING_DEPLOY_SH,
      })

      await expect(
        sandbox.provisionQiSandbox({
          requirementId: 3,
          attempt: 1,
          bareRepoPath: join(BARE_BASE, 'group-p3.git'),
          branch: 'feat/qi-3',
          targetProjectId: 'p3',
        }),
      ).rejects.toMatchObject({
        name: 'SandboxProvisionError',
        stage: 'deploy-provision',
      })
    })

    it('deploy.sh 不写 handle 文件 → SandboxProvisionError stage=parse-handle', async () => {
      await makeMockTargetBare({
        bareName: 'group/p4',
        branch: 'feat/qi-4',
        deployScriptContent: BAD_HANDLE_DEPLOY_SH,
      })

      await expect(
        sandbox.provisionQiSandbox({
          requirementId: 4,
          attempt: 1,
          bareRepoPath: join(BARE_BASE, 'group-p4.git'),
          branch: 'feat/qi-4',
          targetProjectId: 'p4',
        }),
      ).rejects.toMatchObject({
        name: 'SandboxProvisionError',
        stage: 'parse-handle',
      })
    })

    it('校验非法分支名', async () => {
      await expect(
        sandbox.provisionQiSandbox({
          requirementId: 5,
          attempt: 1,
          bareRepoPath: '/tmp/x',
          branch: '; rm -rf /',
          targetProjectId: 'p5',
        }),
      ).rejects.toThrow(/invalid branch name/)
    })

    it('已存在 sandboxDir 被清后重建（attempt 重跑场景）', async () => {
      await makeMockTargetBare({
        bareName: 'group/p6',
        branch: 'feat/qi-6',
        deployScriptContent: VALID_DEPLOY_SH,
      })

      // 第一次
      const h1 = await sandbox.provisionQiSandbox({
        requirementId: 6,
        attempt: 1,
        bareRepoPath: join(BARE_BASE, 'group-p6.git'),
        branch: 'feat/qi-6',
        targetProjectId: 'p6',
      })
      writeFileSync(join(h1.sandboxDir, 'old-junk.txt'), 'leftover')

      // 第二次（同 attempt=1 重跑 → 应清掉旧目录）
      const h2 = await sandbox.provisionQiSandbox({
        requirementId: 6,
        attempt: 1,
        bareRepoPath: join(BARE_BASE, 'group-p6.git'),
        branch: 'feat/qi-6',
        targetProjectId: 'p6',
      })
      expect(h2.sandboxDir).toBe(h1.sandboxDir)
      expect(existsSync(join(h2.sandboxDir, 'old-junk.txt'))).toBe(false)
    })
  })

  describe('teardownQiSandbox', () => {
    it('调 deploy.sh teardown + rm sandboxDir', async () => {
      await makeMockTargetBare({
        bareName: 'group/td1',
        branch: 'feat/qi-td1',
        deployScriptContent: VALID_DEPLOY_SH,
      })
      const handle = await sandbox.provisionQiSandbox({
        requirementId: 100,
        attempt: 1,
        bareRepoPath: join(BARE_BASE, 'group-td1.git'),
        branch: 'feat/qi-td1',
        targetProjectId: 'td1',
      })
      expect(existsSync(handle.sandboxDir)).toBe(true)

      await sandbox.teardownQiSandbox(handle)

      expect(existsSync(handle.sandboxDir)).toBe(false)
    })

    it('deploy.sh 已不存在时静默清目录', async () => {
      const fakeDir = mkdtempSync(join(TEST_BASE, 'fake-sandbox-'))
      const handle = {
        sandboxDir: fakeDir,
        envId: 'x',
        kind: 'docker-compose-local',
        endpoints: {},
        internalRefs: {},
        requirementId: 999,
        attempt: 1,
        deployScript: join(fakeDir, 'nonexistent.sh'),
        targetProjectId: 'x',
      }
      await sandbox.teardownQiSandbox(handle)
      expect(existsSync(fakeDir)).toBe(false)
    })
  })

  describe('parseSandboxDir', () => {
    it('解析合法路径', () => {
      expect(
        sandbox.parseSandboxDir('/data/chatops/test-runs/qi-workspaces/qi-42/attempt-3'),
      ).toEqual({ requirementId: 42, attempt: 3 })
      expect(
        sandbox.parseSandboxDir('/x/qi-1/attempt-1/'),
      ).toEqual({ requirementId: 1, attempt: 1 })
    })

    it('非法路径返回 null', () => {
      expect(sandbox.parseSandboxDir('/foo/bar')).toBe(null)
      expect(sandbox.parseSandboxDir('/qi-abc/attempt-1')).toBe(null)
    })
  })

  describe('loadHandleFromSandbox', () => {
    it('成功读取 .qi-handle.json', () => {
      const dir = mkdtempSync(join(TEST_BASE, 'load-handle-'))
      writeFileSync(
        join(dir, '.qi-handle.json'),
        JSON.stringify({
          sandboxDir: dir,
          envId: 'load-test',
          kind: 'docker-compose-local',
          endpoints: {},
          internalRefs: {},
          requirementId: 1,
          attempt: 1,
          deployScript: '/x/deploy.sh',
          targetProjectId: 'p',
        }),
      )
      const h = sandbox.loadHandleFromSandbox(dir)
      expect(h?.envId).toBe('load-test')
    })

    it('handle 文件缺失返回 null', () => {
      const dir = mkdtempSync(join(TEST_BASE, 'no-handle-'))
      expect(sandbox.loadHandleFromSandbox(dir)).toBe(null)
    })

    it('handle 非合法 JSON 返回 null', () => {
      const dir = mkdtempSync(join(TEST_BASE, 'bad-json-'))
      writeFileSync(join(dir, '.qi-handle.json'), 'not json {{')
      expect(sandbox.loadHandleFromSandbox(dir)).toBe(null)
    })
  })
})
