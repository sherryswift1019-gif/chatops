import client from './client'

export const generateCommands = (body: { intent: string; capabilityName?: string; targetRoles?: string[] }) =>
  client.post<{ commands: string }>('/ai/generate-commands', body).then(r => r.data)
