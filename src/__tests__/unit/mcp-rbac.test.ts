import { describe, it, expect } from 'vitest'
import { filterToolsByRole } from '../../agent/mcp-server-utils.js'
import type { AgentTool } from '../../agent/tools/types.js'

function tool(name: string): AgentTool {
  return {
    name, description: '', riskLevel: 'low',
    inputSchema: {}, execute: async () => ({ success: true, output: '' }),
  }
}

describe('filterToolsByRole', () => {
  it('returns tools permitted for admin role', async () => {
    const all = [tool('query_deployments'), tool('execute_deploy'), tool('manage_role')]
    const filtered = await filterToolsByRole(all, 'admin', 1)
    expect(filtered.map(t => t.name).sort()).toEqual(
      ['execute_deploy', 'manage_role', 'query_deployments'].sort()
    )
  })

  it('filters out admin-only tools for developer role', async () => {
    const all = [tool('query_deployments'), tool('execute_deploy'), tool('manage_role')]
    const filtered = await filterToolsByRole(all, 'developer', 1)
    expect(filtered.map(t => t.name)).toEqual(['query_deployments'])
  })

  it('treats null role as developer', async () => {
    const all = [tool('query_deployments'), tool('execute_deploy')]
    const filtered = await filterToolsByRole(all, null, 1)
    expect(filtered.map(t => t.name)).toEqual(['query_deployments'])
  })

  it('unknown tool name defaults to all roles (fallback)', async () => {
    const all = [tool('mystery_tool')]
    const filtered = await filterToolsByRole(all, 'developer', 1)
    expect(filtered.map(t => t.name)).toEqual(['mystery_tool'])
  })
})
