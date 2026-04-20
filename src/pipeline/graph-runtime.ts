import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { getPool } from '../db/client.js'

// Singleton PostgresSaver backed by the shared pg Pool.
// First call runs `saver.setup()` (idempotent: creates checkpoint tables
// if they do not already exist). Subsequent calls return the cached instance.
let saverPromise: Promise<PostgresSaver> | null = null

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!saverPromise) {
    saverPromise = (async () => {
      const pool = getPool()
      // PostgresSaver accepts a node-postgres Pool directly so we reuse the
      // existing connection pool instead of spinning up a second one.
      const saver = new PostgresSaver(pool)
      await saver.setup()
      return saver
    })().catch((err) => {
      // Reset on failure so a later call can retry instead of being stuck
      // with a rejected promise forever.
      saverPromise = null
      throw err
    })
  }
  return saverPromise
}

// Exposed for tests that want to force re-initialisation.
export function resetCheckpointerForTesting(): void {
  saverPromise = null
}
