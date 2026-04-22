import client from './client'
import type { PrdChatMessage, PrdChatSession } from '../types'

export const createPrdChatSession = (body: { productLineId: number; prdId?: number }) =>
  client
    .post<{ data: PrdChatSession }>('/prd-chat/sessions', {
      product_line_id: body.productLineId,
      prd_id: body.prdId,
    })
    .then((r) => r.data.data)

export const getPrdChatSession = (sessionKey: string) =>
  client
    .get<{ data: PrdChatSession }>(`/prd-chat/sessions/${sessionKey}`)
    .then((r) => r.data.data)

export const listPrdChatMessages = (sessionKey: string) =>
  client
    .get<{ data: PrdChatMessage[] }>(`/prd-chat/sessions/${sessionKey}/messages`)
    .then((r) => r.data.data)

export const buildPrdChatStreamUrl = (sessionKey: string, text: string) => {
  const qs = new URLSearchParams({ text })
  return `/admin/prd-chat/sessions/${encodeURIComponent(sessionKey)}/stream?${qs.toString()}`
}
