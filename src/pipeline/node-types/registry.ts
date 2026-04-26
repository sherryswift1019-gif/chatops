import type { NodeExecutor } from './types.js'

const registry = new Map<string, NodeExecutor>()

export function registerNodeType(executor: NodeExecutor): void {
  if (registry.has(executor.key)) {
    throw new Error(`node type "${executor.key}" already registered`)
  }
  registry.set(executor.key, executor)
}

export function getExecutor(key: string): NodeExecutor | undefined {
  return registry.get(key)
}

export function getRegisteredNodeTypeKeys(): Set<string> {
  return new Set(registry.keys())
}

/**
 * 启动一致性检查：DB enabled 的 node type 必须跟代码 register 一一对应。
 * 漂移时抛错，防止"DB 有但代码没实现"或"代码注册了但 DB 没添加"。
 */
export function assertRegistryConsistent(dbEnabledKeys: Set<string>): void {
  const codeKeys = getRegisteredNodeTypeKeys()
  const dbOnly = [...dbEnabledKeys].filter(k => !codeKeys.has(k))
  const codeOnly = [...codeKeys].filter(k => !dbEnabledKeys.has(k))
  if (dbOnly.length || codeOnly.length) {
    const msg = [
      'Node type registry mismatch — DB and code disagree on enabled node types:',
      dbOnly.length ? `  DB only (likely missing executor in src/pipeline/node-types/): ${dbOnly.join(', ')}` : '',
      codeOnly.length ? `  Code only (likely missing migration; run \`pnpm migrate\`): ${codeOnly.join(', ')}` : '',
      '',
      'See docs/smoke-pipeline-node-types.md for diagnosis steps.',
    ].filter(Boolean).join('\n')
    throw new Error(msg)
  }
}

/** 仅供单测用 —— 清空 registry */
export function __resetRegistryForTesting(): void {
  registry.clear()
}
