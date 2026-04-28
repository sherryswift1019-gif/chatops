export interface ExtractResult {
  servers: Record<string, string[]> | undefined
  payload: Record<string, unknown>
}

/**
 * 从请求 body 中拆出 _servers 字段，返回剔除后的 payload。
 * _servers 不会进入 triggerParams，不污染 pipeline 状态。
 */
export function extractServersFromPayload(body: Record<string, unknown>): ExtractResult {
  const { _servers, ...rest } = body
  return {
    servers: _servers !== undefined ? (_servers as Record<string, string[]>) : undefined,
    payload: rest,
  }
}

/**
 * 校验 _servers 是否为合法的 Record<string, string[]>。
 */
export function isValidServersShape(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  )
}
