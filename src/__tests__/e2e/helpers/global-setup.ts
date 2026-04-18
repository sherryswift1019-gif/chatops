/**
 * Playwright globalSetup：
 *   1. 检查 DATABASE_URL 已配置
 *   2. 检查 web/dist/index.html 存在（否则提示用户 build）
 *   3. resetTestDb() 清库 + 顺序重建 schema
 *   4. 执行 base.sql 种子数据
 */
import type { FullConfig } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { resetTestDb, getTestPool } from '../../helpers/db.js'

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('[e2e] globalSetup: DATABASE_URL is required')
  }

  const distIndex = join(process.cwd(), 'web', 'dist', 'index.html')
  if (!existsSync(distIndex)) {
    throw new Error(
      `[e2e] globalSetup: web/dist/index.html not found.\n` +
        `Please run \`cd web && pnpm build\` first.`,
    )
  }

  // eslint-disable-next-line no-console
  console.log('[e2e] globalSetup: resetting test DB')
  await resetTestDb()

  // eslint-disable-next-line no-console
  console.log('[e2e] globalSetup: loading base.sql')
  const sql = readFileSync(
    join(process.cwd(), 'src/__tests__/e2e/fixtures/base.sql'),
    'utf8',
  )
  await getTestPool().query(sql)

  // eslint-disable-next-line no-console
  console.log('[e2e] globalSetup: done')
}
