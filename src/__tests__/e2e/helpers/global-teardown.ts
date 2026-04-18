/**
 * Playwright globalTeardown：关闭测试用 pg pool，避免进程挂住。
 */
import { getTestPool } from '../../helpers/db.js'

export default async function globalTeardown(): Promise<void> {
  await getTestPool()
    .end()
    .catch(() => {
      // pool 可能已关闭或未初始化，吞掉错误
    })
}
