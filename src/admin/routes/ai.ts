import type { FastifyInstance } from 'fastify'

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { intent: string; capabilityName?: string; targetRoles?: string[] } }>(
    '/ai/generate-commands', async (req, reply) => {
      const { intent, capabilityName, targetRoles } = req.body
      if (!intent) return reply.status(400).send({ error: 'intent required' })

      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) return reply.status(500).send({ error: 'ANTHROPIC_API_KEY not configured' })

      const userMessage = [
        capabilityName ? `能力类型: ${capabilityName}` : '',
        targetRoles?.length ? `目标服务器角色: ${targetRoles.join(', ')}` : '',
        `用户意图: ${intent}`,
      ].filter(Boolean).join('\n')

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            system: '你是一个 Linux 运维专家。根据以下上下文，生成对应的 shell 命令。\n- 每行一条命令\n- 只输出可执行的 shell 命令，不要解释、不要注释、不要 markdown 格式\n- 命令应该安全、幂等，适合自动化执行',
            messages: [{ role: 'user', content: userMessage }],
          }),
        })

        if (!res.ok) {
          const err = await res.text()
          return reply.status(502).send({ error: `AI API error: ${err}` })
        }

        const data = await res.json() as { content: Array<{ type: string; text: string }> }
        const commands = data.content?.[0]?.text?.trim() ?? ''
        return reply.send({ commands })
      } catch (err) {
        return reply.status(502).send({ error: `AI API call failed: ${String(err)}` })
      }
    }
  )
}
