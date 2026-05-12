// src/scripts/qi-clean.ts
//
// 本地 dev 用：清空 QI 测试数据，重置环境到"刚装好"状态。
// CLAUDE.md memory feedback_clean_pipeline_data_stop_backend_first.md：清前必须停后端。
//
// 跑：pnpm qi-clean              # 仅预览要清什么（dry-run）
//     pnpm qi-clean --yes         # 真清
//     pnpm qi-clean --yes --skip-gitlab   # 不删 GitLab remote 分支（无网/不想清时用）
//
// 清的东西：
//   1. DB requirements + test_runs + requirement_approval_waiters + 3 个 checkpoint 表
//   2. local worktrees /tmp/quick-impl/qi-*
//   3. GitLab remote branches feat/qi-*（除非 --skip-gitlab）
//
// 不动的：
//   - bootstrap pipeline template（quick_impl 表）
//   - system_config（GitLab/Claude token 等）
//   - 用户表 / 权限 / 其他业务数据
//
// 安全：
//   - 默认 dry-run，必须 --yes 才真删
//   - 检测 DATABASE_URL 含 'production' / 'prod' 直接 abort
//   - 检查 backend 是否还在跑 (3000 端口) — 在跑就 abort（让用户先停）
import 'dotenv/config'
import { getPool } from '../db/client.js'
import { existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { connect } from 'net'

const QI_WORKTREE_BASE = '/tmp/quick-impl'
const args = new Set(process.argv.slice(2))
const DRY_RUN = !args.has('--yes')
const SKIP_GITLAB = args.has('--skip-gitlab')

function log(msg: string): void {
  console.log(`[qi-clean] ${msg}`)
}

async function checkBackendNotRunning(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect(3000, '127.0.0.1')
    sock.setTimeout(800)
    sock.once('connect', () => {
      sock.destroy()
      reject(new Error('端口 3000 被占用 — backend 还在跑。先 `pkill -f "tsx.*src/server.ts"` 再跑本脚本（CLAUDE.md memory feedback_clean_pipeline_data_stop_backend_first.md）。'))
    })
    sock.once('error', () => {
      // connect refused → 没人 listen
      resolve()
    })
    sock.once('timeout', () => {
      sock.destroy()
      resolve()
    })
  })
}

function abortIfProductionDb(dbUrl: string): void {
  if (/production|prod/i.test(dbUrl)) {
    throw new Error(`DATABASE_URL 含 production/prod 字样，禁止跑清理脚本: ${dbUrl}`)
  }
}

async function cleanDb(): Promise<void> {
  const pool = getPool()
  const tables = ['requirement_approval_waiters', 'test_runs', 'requirements', 'checkpoint_writes', 'checkpoint_blobs', 'checkpoints']
  if (DRY_RUN) {
    for (const t of tables) {
      const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`)
      log(`  [dry-run] DELETE FROM ${t} (${rows[0]?.n ?? '?'} rows)`)
    }
    return
  }
  await pool.query('BEGIN')
  try {
    for (const t of tables) {
      const { rowCount } = await pool.query(`DELETE FROM ${t}`)
      log(`  DELETE FROM ${t} → ${rowCount ?? 0} rows`)
    }
    await pool.query(`ALTER SEQUENCE requirements_id_seq RESTART WITH 1`)
    await pool.query(`ALTER SEQUENCE test_runs_id_seq RESTART WITH 1`)
    await pool.query(`ALTER SEQUENCE requirement_approval_waiters_id_seq RESTART WITH 1`)
    await pool.query('COMMIT')
    log('  sequences reset to 1')
  } catch (err) {
    await pool.query('ROLLBACK')
    throw err
  }
}

function cleanWorktrees(): void {
  if (!existsSync(QI_WORKTREE_BASE)) {
    log('  no worktrees dir, skip')
    return
  }
  const entries = readdirSync(QI_WORKTREE_BASE).filter(name => name.startsWith('qi-'))
  if (entries.length === 0) {
    log('  no qi-* worktrees to clean')
    return
  }
  for (const name of entries) {
    const path = join(QI_WORKTREE_BASE, name)
    if (DRY_RUN) {
      log(`  [dry-run] rm -rf ${path}`)
    } else {
      rmSync(path, { recursive: true, force: true })
      log(`  rm -rf ${path}`)
    }
  }
}

function cleanGitlabBranches(): void {
  if (SKIP_GITLAB) {
    log('  --skip-gitlab → skipping remote branch cleanup')
    return
  }
  const gitlabProject = process.env.QI_CLEAN_GITLAB_PROJECT ?? 'sherryswift1019-group/chatops'
  // GitLab URL via env or default to gitlab.com
  const gitlabBase = process.env.QI_CLEAN_GITLAB_URL ?? 'https://gitlab.com'
  const remote = `${gitlabBase.replace(/\/$/, '')}/${gitlabProject}.git`

  // 先 ls-remote 列出实际存在的 feat/qi-* branches
  let branchesOutput: string
  try {
    branchesOutput = execSync(`git ls-remote ${remote} 'refs/heads/feat/qi-*'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    log(`  GitLab ls-remote 失败 (${(err as Error).message.slice(0, 80)})；跳过远端清理`)
    return
  }
  const branches = branchesOutput.split('\n').filter(Boolean).map(line => line.split(/\s+/)[1]?.replace('refs/heads/', '') ?? '').filter(Boolean)
  if (branches.length === 0) {
    log('  no remote feat/qi-* branches to clean')
    return
  }
  log(`  found ${branches.length} remote branches: ${branches.join(', ')}`)
  if (DRY_RUN) {
    for (const b of branches) log(`  [dry-run] git push --delete ${b}`)
    return
  }
  for (const b of branches) {
    try {
      execSync(`git push ${remote} --delete '${b}'`, { stdio: ['ignore', 'pipe', 'pipe'] })
      log(`  deleted remote ${b}`)
    } catch (err) {
      log(`  ! delete ${b} failed: ${(err as Error).message.slice(0, 100)}`)
    }
  }
}

async function main(): Promise<void> {
  log(DRY_RUN ? '=== DRY RUN (use --yes to actually delete) ===' : '=== EXECUTING CLEANUP ===')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set')
  abortIfProductionDb(dbUrl)
  log(`DATABASE_URL: ${dbUrl.replace(/:[^:@]+@/, ':***@')}`)

  await checkBackendNotRunning()
  log('backend not running on 3000 ✓')

  log('\n1. clean DB tables:')
  await cleanDb()

  log('\n2. clean local worktrees:')
  cleanWorktrees()

  log('\n3. clean GitLab remote branches:')
  cleanGitlabBranches()

  log('\n' + (DRY_RUN ? '✓ dry-run done. Use --yes to actually delete.' : '✓ cleanup done. Run `pnpm dev` to restart backend.'))
}

main()
  .then(() => getPool().end())
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[qi-clean] FAILED:', err.message)
    getPool().end().catch(() => {}).finally(() => process.exit(1))
  })
