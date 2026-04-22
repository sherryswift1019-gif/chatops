/**
 * Vitest globalSetup — 本地启 testcontainers postgres 做物理隔离。
 *
 * 分叉策略（见 docs/TODO.md §5）：
 *   process.env.CI === 'true'  → 短路，不启 container。
 *                                依赖 CI runner 已经起好的 postgres service（.gitlab-ci.yml 不动）。
 *   非 CI（本地）              → 启临时 postgres:16 容器，getConnectionUri() 覆写 DATABASE_URL，
 *                                session 结束 container.stop()。
 *
 * 关键点 — 动态 import：
 *   src/db/migrate.ts 是顶层 await script，一旦被 import 就立即按旧 env 连库执行。
 *   所以这里**不 import migrate.ts**，改为直接读 schema 文件 + 建临时 Pool。
 *   所有业务模块（含 config.ts、db/client.ts）都在 env 被覆写后才 import，避免 module 级 freeze。
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_DIR = join(__dirname, '..', '..', 'db')

let container: { stop: () => Promise<unknown> } | null = null

/**
 * Auto-detect docker runtime socket on macOS/Linux.
 * testcontainers 默认查 /var/run/docker.sock，但 OrbStack / Colima / Docker Desktop 都是自定义路径。
 * 优先读 DOCKER_HOST env；没设则按优先级探测常见 socket 路径。
 */
function autoSetDockerHost(): void {
  if (process.env.DOCKER_HOST) return
  const home = process.env.HOME
  if (!home) return
  const candidates = [
    `${home}/.orbstack/run/docker.sock`,
    `${home}/.colima/default/docker.sock`,
    `${home}/.docker/run/docker.sock`,
    '/var/run/docker.sock',
  ]
  for (const sock of candidates) {
    if (existsSync(sock)) {
      process.env.DOCKER_HOST = `unix://${sock}`
      console.log(`[testcontainer-setup] DOCKER_HOST=${process.env.DOCKER_HOST}`)
      return
    }
  }
  console.warn('[testcontainer-setup] no docker socket detected, testcontainers may fail')
}

export async function setup(): Promise<void> {
  if (process.env.CI === 'true') {
    console.log('[testcontainer-setup] CI detected, skipping container (use external DATABASE_URL)')
    return
  }

  autoSetDockerHost()
  // 禁用 Ryuk reaper container。内网环境下拉 testcontainers/ryuk 会失败。
  // 牺牲：进程非正常退出时容器不会自动 cleanup，teardown() 手动清理，极少残留。
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'

  // 动态 import 避免 module-load 阶段连库
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql')

  console.log('[testcontainer-setup] starting postgres:16-alpine container...')
  // 使用 alpine 版镜像，镜像体积小
  // withPullPolicy({ shouldPull: () => false }) — 强制不拉镜像，用本机已有（内网环境下拉 docker hub 常被劫持/超时）
  const started = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('chatops_test')
    .withUsername('chatops')
    .withPassword('chatops')
    .withPullPolicy({ shouldPull: () => false })
    .start()

  const uri = started.getConnectionUri()
  process.env.DATABASE_URL = uri
  container = started
  console.log(`[testcontainer-setup] container ready: ${uri}`)

  // 跑 schema migrations（顺序读所有 schema*.sql 文件）
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: uri })
  try {
    const files = readdirSync(SCHEMA_DIR)
      .filter((f) => /^schema(-v\d+)?\.sql$/.test(f))
      .sort((a, b) => {
        // schema.sql 在前，然后按 v 后面的数字升序
        const na = a === 'schema.sql' ? 0 : Number(a.match(/-v(\d+)/)?.[1] ?? 0)
        const nb = b === 'schema.sql' ? 0 : Number(b.match(/-v(\d+)/)?.[1] ?? 0)
        return na - nb
      })
    for (const file of files) {
      const sql = readFileSync(join(SCHEMA_DIR, file), 'utf8')
      await pool.query(sql)
    }
    // bootstrap marker 表供 helpers/db.ts 的 assertTestDbSafeToReset 校验通过
    await pool.query('CREATE TABLE IF NOT EXISTS chatops_test_db_marker ()')
    console.log(`[testcontainer-setup] applied ${files.length} schema files + marker`)
  } finally {
    await pool.end()
  }
}

export async function teardown(): Promise<void> {
  if (container) {
    console.log('[testcontainer-setup] stopping container...')
    await container.stop()
    container = null
  }
}
