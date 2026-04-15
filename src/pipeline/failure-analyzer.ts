import { createPorygon } from '@snack-kit/porygon'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { buildClaudeEnv } from '../agent/claude-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const porygon = createPorygon({
  defaultBackend: 'claude',
  backends: {
    claude: {
      model: 'sonnet',
      interactive: false,
      cliPath: join(__dirname, '..', '..', 'node_modules', '.bin', 'claude'),
    },
  },
  defaults: { timeoutMs: 60_000, maxTurns: 1 },
})

export async function analyzeFailure(
  script: string,
  errorOutput: string,
  serverHost: string,
): Promise<string> {
  const prompt = `以下是在服务器 ${serverHost} 上执行的脚本及其错误输出，请分析失败原因，给出修复建议。简洁明了，不超过 300 字。

## 执行脚本
\`\`\`bash
${script}
\`\`\`

## 错误输出（stdout+stderr）
\`\`\`
${errorOutput}
\`\`\``

  try {
    const result = await porygon.run({
      prompt,
      maxTurns: 1,
      disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      envVars: await buildClaudeEnv(),
    })
    return result.trim()
  } catch (err) {
    return `AI 分析失败: ${String(err)}`
  }
}
