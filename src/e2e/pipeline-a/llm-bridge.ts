// src/e2e/pipeline-a/llm-bridge.ts
import { ClaudeRunner } from '../../agent/claude-runner.js'
import type { TaskContext } from '../../agent/tools/types.js'

let _runner: ClaudeRunner | null = null

function getRunner(): ClaudeRunner {
  if (!_runner) _runner = new ClaudeRunner()
  return _runner
}

const E2E_CONTEXT: TaskContext = {
  taskId: 'e2e-pipeline-a',
  groupId: 'e2e-pipeline-a',
  platform: 'internal',
  initiatorId: 'pipeline-a',
  initiatorRole: null,
}

export async function executeCapabilityDirectForE2e(prompt: string, sessionKey: string): Promise<string> {
  return getRunner().executeCapabilityDirect({
    prompt,
    systemPrompt: 'You are a Playwright test engineer. Output only TypeScript code or JSON as requested.',
    context: E2E_CONTEXT,
    tools: [],
    cwd: process.cwd(),
    sessionKey,
    freshSession: true,
    maxTurns: 20,
    timeoutMs: 600_000,
  })
}
