import type { FastifyInstance } from 'fastify'
import { listTestServers, getTestServerById, createTestServer, updateTestServer, deleteTestServer } from '../../db/repositories/test-servers.js'
import { sshExec } from '../../pipeline/ssh.js'

export async function registerTestServerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { product_line_id?: string } }>('/test-servers', async (req, reply) => {
    const plId = req.query.product_line_id ? Number(req.query.product_line_id) : undefined
    return reply.send(await listTestServers(plId))
  })

  app.post<{ Body: {
    productLineId: number; name: string; host: string; port?: number
    username: string; authType?: 'password' | 'key'; credential: string; role: string
    tags?: Record<string, unknown>
  } }>('/test-servers', async (req, reply) => {
    const { productLineId, name, host, username, credential } = req.body
    if (!productLineId || !name || !host || !username || !credential) {
      return reply.status(400).send({ error: 'productLineId, name, host, username, credential required' })
    }
    const item = await createTestServer({ ...req.body, role: req.body.role ?? '' })
    return reply.status(201).send(item)
  })

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/test-servers/:id', async (req, reply) => {
    const item = await updateTestServer(Number(req.params.id), req.body as any)
    if (!item) return reply.status(404).send({ error: 'not found' })
    return reply.send(item)
  })

  app.delete<{ Params: { id: string } }>('/test-servers/:id', async (req, reply) => {
    const deleted = await deleteTestServer(Number(req.params.id))
    if (!deleted) return reply.status(404).send({ error: 'not found' })
    return reply.status(204).send()
  })

  app.post<{ Params: { id: string } }>('/test-servers/:id/test-connection', async (req, reply) => {
    const server = await getTestServerById(Number(req.params.id))
    if (!server) return reply.status(404).send({ error: 'not found' })
    try {
      const result = await sshExec(
        { host: server.host, port: server.port, username: server.username, password: server.credential },
        'echo "connection ok" && hostname && uname -a'
      )
      if (result.code === 0) {
        return reply.send({ success: true, output: result.stdout.trim() })
      }
      return reply.send({ success: false, output: result.stderr || result.stdout })
    } catch (err) {
      return reply.send({ success: false, output: String(err) })
    }
  })
}
