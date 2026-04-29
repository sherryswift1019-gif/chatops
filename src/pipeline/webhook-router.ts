import type { FastifyInstance } from 'fastify'
import { globalRateLimiter } from './webhook-rate-limit.js'
import { getPipelineWebhookByToken, recordWebhookUsed } from '../db/repositories/pipeline-webhooks-repo.js'
import { getTestPipelineById } from '../db/repositories/test-pipelines.js'
import { runPipeline } from './executor.js'
import { apiTrigger } from './trigger.js'
import { extractServersFromPayload, isValidServersShape } from './webhook-payload.js'
import { validateTriggerParams } from './validate-trigger-params.js'
import { autoResolveServersByRole } from './server-resolver.js'

export async function registerWebhookRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { token: string } }>(
    '/webhook/pipeline/:token',
    async (req, reply) => {
      const { token } = req.params

      // 1. 查 token（disabled 和不存在统一 401，防探测）
      const webhook = await getPipelineWebhookByToken(token)
      if (!webhook || !webhook.enabled) {
        return reply.status(401).send({ error: 'invalid webhook token' })
      }

      // 2. 限流
      const rateResult = globalRateLimiter.check(token)
      if (!rateResult.allowed) {
        const retryAfter = (rateResult as { allowed: false; retryAfter: number }).retryAfter
        return reply
          .status(429)
          .header('Retry-After', String(retryAfter))
          .send({ error: 'rate limited', retryAfter })
      }

      // 3. 加载 pipeline
      const pipeline = await getTestPipelineById(webhook.pipelineId)
      if (!pipeline || !pipeline.enabled) {
        return reply.status(404).send({ error: 'pipeline not found or disabled' })
      }

      // 4. 校验 body
      const rawBody = req.body as unknown
      if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        return reply.status(400).send({ error: 'body must be a JSON object' })
      }
      const body = rawBody as Record<string, unknown>

      if (body._servers !== undefined && !isValidServersShape(body._servers)) {
        return reply.status(400).send({ error: '_servers must be Record<string, string[]>' })
      }

      // 5. 拆 _servers，合并优先级：bodyServers > webhook.defaultServers >
      //    按 role 自动分配（与 admin manual/api 触发路径行为对齐）。
      //    都没有时 effectiveServers={}，runPipeline 跳过 hydrateServerAssignments
      //    走 serverless 路径。
      const { servers: bodyServers, payload } = extractServersFromPayload(body)
      let effectiveServers: Record<string, string[]> =
        bodyServers ??
        (webhook.defaultServers as Record<string, string[]> | null) ??
        {}
      if (Object.keys(effectiveServers).length === 0) {
        effectiveServers = await autoResolveServersByRole()
      }

      // 5b. paramSchema validation: ensure payload satisfies required fields
      if (pipeline.paramSchema) {
        const check = validateTriggerParams(pipeline.paramSchema, payload)
        if (!check.valid) {
          return reply.status(400).send({
            error: '缺少必填触发参数',
            missingFields: check.missingFields,
          })
        }
      }

      // 6. 触发（await 拿 runId，不等 pipeline 完成）
      const triggeredBy = `webhook:${webhook.id}:${webhook.name}`
      const runId = await runPipeline(
        webhook.pipelineId,
        effectiveServers,
        apiTrigger({ triggeredBy, params: payload }),
      )

      // 7. 更新统计（fire-and-forget）
      recordWebhookUsed(webhook.id, runId).catch(() => undefined)

      // 8. 返回 202
      return reply.status(202).send({
        runId,
        statusUrl: `/admin/api/test-runs/${runId}`,
        triggeredAt: new Date().toISOString(),
      })
    },
  )
}
