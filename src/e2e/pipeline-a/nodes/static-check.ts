import { spawnSync } from 'child_process'
import type { PipelineAStateType } from '../types.js'

export async function staticCheckNode(
  state: PipelineAStateType,
): Promise<Partial<PipelineAStateType>> {
  const result = spawnSync('npx', ['tsc', '--noEmit', '--project', 'tsconfig.json'], {
    encoding: 'utf8',
    timeout: 60_000,
    shell: true,
  })

  if (result.status === 0) {
    return { staticCheckResult: 'pass', lastError: null }
  }

  const stderr = result.stderr ?? result.stdout ?? 'tsc failed'
  console.warn(`[PipelineA:staticCheck] tsc failed:\n${stderr.slice(0, 500)}`)
  return {
    staticCheckResult: 'fail',
    staticCheckAttempts: state.staticCheckAttempts + 1,
    lastError: stderr,
  }
}
