import client from './client'
import type { PipelineNodeType } from '../types/pipelineNodeType'

export const listPipelineNodeTypes = () =>
  client.get<PipelineNodeType[]>('/pipeline-node-types').then(r => r.data)
