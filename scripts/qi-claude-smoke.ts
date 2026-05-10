// Claude CLI 烟测：用 system_config 里的 token 调一次
process.env.DATABASE_URL ??= 'postgres://zhangshanshan@localhost:5432/chatops'

const { buildClaudeEnv } = await import('../src/agent/claude-config.js')
const { spawnSync } = await import('child_process')

const env = await buildClaudeEnv()
console.log('Has TOKEN:', !!env.CLAUDE_CODE_OAUTH_TOKEN)
console.log('BASE_URL:', env.ANTHROPIC_BASE_URL)

const r = spawnSync('claude', ['--print', '请用一行回答 1+1 等于多少'], {
  env: { ...process.env, ...env, FORCE_COLOR: '0' },
  encoding: 'utf8',
  timeout: 60_000,
})
console.log('EXIT:', r.status)
console.log('STDOUT:', (r.stdout || '').slice(0, 200))
if (r.stderr) console.log('STDERR:', r.stderr.slice(0, 300))

process.exit(r.status === 0 ? 0 : 1)
