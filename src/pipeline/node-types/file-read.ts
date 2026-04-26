import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { sshExec } from '../ssh.js'
import { readFile, stat } from 'fs/promises'

const DEFAULT_MAX_BYTES = 1_048_576 // 1 MiB

/**
 * Phase 3 T13 — file_read executor。
 *
 * params:
 *   - target?: 'local' | string  默认 'local'(使用 fs.readFile);
 *              其它值表示远程,executor 直接用 ctx.server 走 sshExec `cat <path>`。
 *              ⚠️ 远程 server 解析由调度方负责(同 script.ts 模式),executor 不查 DB。
 *   - path: string  必填
 *   - maxBytes?: number  默认 1048576;超出则截断到 maxBytes,output.truncated=true
 *
 * 成功: status='success', output={content, size[, truncated:true]}
 * 失败: 文件不存在 / SSH 错 / 路径缺 → status='failed', error=...
 */
registerNodeType({
  key: 'file_read',
  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const path = params.path as string | undefined
    if (!path || !path.trim()) {
      return { status: 'failed', output: {}, error: 'file_read executor requires params.path' }
    }
    const target = (params.target as string | undefined) ?? 'local'
    const maxBytes = typeof params.maxBytes === 'number' && params.maxBytes > 0
      ? params.maxBytes
      : DEFAULT_MAX_BYTES

    if (target === 'local') {
      try {
        const st = await stat(path)
        const total = st.size
        const buf = await readFile(path)
        const truncated = buf.length > maxBytes
        const content = truncated ? buf.subarray(0, maxBytes).toString('utf8') : buf.toString('utf8')
        return {
          status: 'success',
          output: { content, size: total, ...(truncated ? { truncated: true } : {}) },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isNotFound = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
        return {
          status: 'failed',
          output: {},
          error: isNotFound ? `file not found: ${path}` : msg,
        }
      }
    }

    // remote ssh path —— 用 ctx.server 直读(由调度方按 target server 名解析后填充)
    if (!ctx.server) {
      return {
        status: 'failed',
        output: {},
        error: `file_read target="${target}" requires ctx.server (调度方按 server 名解析填充)`,
      }
    }
    if (!ctx.server.password) {
      return {
        status: 'failed',
        output: {},
        error: 'file_read remote target requires ctx.server.password',
      }
    }
    try {
      // -c maxBytes 限制下行字节;同时 wc -c 取真实 size。
      // 简化策略: cat 直接读, 由本端裁剪 maxBytes 后判 truncated。
      const result = await sshExec(
        {
          host: ctx.server.host,
          port: ctx.server.port,
          username: ctx.server.username,
          password: ctx.server.password,
        },
        `cat -- ${shellQuote(path)}`,
      )
      if (result.code !== 0) {
        const stderr = result.stderr.trim()
        const isNotFound = /No such file/i.test(stderr)
        return {
          status: 'failed',
          output: { exitCode: result.code, stderr },
          error: isNotFound ? `file not found: ${path}` : `cat exit ${result.code}: ${stderr || 'unknown'}`,
        }
      }
      const totalBytes = Buffer.byteLength(result.stdout, 'utf8')
      const truncated = totalBytes > maxBytes
      const content = truncated
        ? Buffer.from(result.stdout, 'utf8').subarray(0, maxBytes).toString('utf8')
        : result.stdout
      return {
        status: 'success',
        output: { content, size: totalBytes, ...(truncated ? { truncated: true } : {}) },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'failed', output: {}, error: msg }
    }
  },
})

/** 单引号 shell 转义,防止 path 含空格 / 引号导致 cat 拼接错。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
