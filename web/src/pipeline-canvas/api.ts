import client from '../api/client'
import type { PipelineGraphWire } from './types'

export const getPipelineGraph = (id: number) =>
  client.get<PipelineGraphWire>(`/test-pipelines/${id}/graph`).then(r => r.data)

export const putPipelineGraph = (id: number, graph: PipelineGraphWire) =>
  client.put(`/test-pipelines/${id}/graph`, { graph }).then(r => r.data)
