import type { FastifyInstance } from 'fastify'
import { createPorygon } from '@snack-kit/porygon'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const porygon = createPorygon({
  defaultBackend: 'claude',
  backends: {
    claude: {
      model: 'sonnet',
      interactive: false,
      cliPath: join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'claude'),
    },
  },
  defaults: { timeoutMs: 60_000, maxTurns: 1 },
})

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { intent: string; capabilityName?: string; targetRoles?: string[] } }>(
    '/ai/generate-commands', async (req, reply) => {
      const { intent, capabilityName, targetRoles } = req.body
      if (!intent) return reply.status(400).send({ error: 'intent required' })

      const userMessage = [
        capabilityName ? `能力类型: ${capabilityName}` : '',
        targetRoles?.length ? `目标服务器角色: ${targetRoles.join(', ')}` : '',
        `用户意图: ${intent}`,
      ].filter(Boolean).join('\n')

      const prompt = `${userMessage}

请生成对应的 shell 命令。每行一条命令，只输出可执行的 shell 命令，不要解释、不要注释、不要 markdown 格式。命令应该安全、幂等，适合自动化执行。`

      try {
        const result = await porygon.run({
          prompt,
          maxTurns: 1,
          disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
          envVars: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' },
        })

        const commands = result.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?|```/g, '')).trim()
        return reply.send({ commands })
      } catch (err) {
        return reply.status(502).send({ error: `AI generation failed: ${String(err)}` })
      }
    }
  )
}
