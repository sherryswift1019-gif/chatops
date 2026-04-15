import client from './client'

export const getPipelineVariables = () =>
  client.get<{ key: string; description: string; category: string }[]>('/pipeline-variables').then(r => r.data)
