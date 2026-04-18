import type { FastifyInstance } from 'fastify'
import { listModuleOwners, createModuleOwner, deleteModuleOwner } from '../../db/repositories/module-owners.js'

export async function registerModuleOwnerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/module-owners', async (req) => {
    const productLineId = Number((req.query as any).product_line_id)
    if (!productLineId) return { error: { code: 'MISSING_PARAM', message: 'product_line_id required' } }
    return { data: await listModuleOwners(productLineId) }
  })

  app.post('/module-owners', async (req) => {
    const body = req.body as any
    if (!body.productLineId || !body.modulePattern || !body.ownerUserId) {
      return { error: { code: 'MISSING_PARAM', message: 'productLineId, modulePattern, ownerUserId required' } }
    }
    const owner = await createModuleOwner(body)
    return { data: owner }
  })

  app.delete('/module-owners/:id', async (req) => {
    const id = Number((req.params as any).id)
    await deleteModuleOwner(id)
    return { data: { deleted: true } }
  })
}
