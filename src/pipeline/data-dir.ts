import { join } from 'path'

/**
 * Pipeline run 的日志/产物落盘根目录。
 * 生产经 docker-compose 显式设 TEST_DATA_DIR；本地 dev 不设时回落到
 * <cwd>/var/test-runs，避免 mkdir /data/* 的 EACCES。
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TEST_DATA_DIR
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv
  return join(process.cwd(), 'var', 'test-runs')
}
