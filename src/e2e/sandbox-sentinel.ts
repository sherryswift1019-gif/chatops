import { getPool } from '../db/client.js'

const SAFE_DB_PREFIXES = ['sandbox-', 'e2e-', 'test-']

export async function verifySandboxSafety(): Promise<void> {
  if (process.env.E2E_SANDBOX_MODE !== 'true') return

  const { rows } = await getPool().query('SELECT current_database()')
  const dbName: string = rows[0].current_database

  const isSafe = SAFE_DB_PREFIXES.some((prefix) => dbName.startsWith(prefix))
  if (!isSafe) {
    throw new Error(
      `sandbox safety check failed: current_database()="${dbName}" does not start with any of [${SAFE_DB_PREFIXES.join(', ')}]. ` +
        'Refusing to start sandbox chatops connected to a non-sandbox database.',
    )
  }
  console.log(`[SandboxSentinel] DB safe: ${dbName}`)
}
