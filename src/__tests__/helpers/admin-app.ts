/**
 * 共享 admin route 测试 helper.
 * 启动一个最小 Fastify 实例,只注册需要的 admin route,跳过 requireAuth preHandler
 * 以便单元测试聚焦 route 行为本身(不测 auth 链路)。
 */
import Fastify, { type FastifyInstance } from 'fastify'

export async function buildAdminTestApp(
  registerRoutes: (app: FastifyInstance) => Promise<void> | void,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await registerRoutes(app)
  await app.ready()
  return app
}
