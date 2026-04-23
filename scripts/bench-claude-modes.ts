/**
 * 本地对比 CLI vs Porygon 速度（真实 analyze_bug 场景）。
 *
 * 使用真正的 analyze_bug system_prompt + 完整的钉钉消息 + 克隆好的 pas 仓库作为 cwd，
 * 让 Claude 真的去 Glob/Grep/Read 代码定位根因——跟钉钉那次完全一致。
 *
 * 用法：
 *   tsx scripts/bench-claude-modes.ts cli
 *   tsx scripts/bench-claude-modes.ts porygon
 *   tsx scripts/bench-claude-modes.ts both
 *
 * 前置：
 *   1. /tmp/pas-bench/pas-6.0 里有 pas 仓库的 checkout（git clone -b test 过）
 *   2. ~/.zshrc 里有 CLAUDE_CODE_OAUTH_TOKEN + ANTHROPIC_BASE_URL
 *   3. ~/.m2 里有 settings.xml（调 Maven 不需要，但保持完整性）
 */
import 'dotenv/config'
import { CliExecutor, PorygonExecutor } from '../src/agent/claude-executor.js'
import { getPool } from '../src/db/client.js'

const WORKTREE_PATH = '/tmp/pas-bench/pas-6.0'

const USER_MESSAGE = `pas ai-chatops-dev分支 SUSE类型资产连接超时（172.16.0.121、172.16.0.146），帮忙分析一下，下面是日志，linux服务器返回的有PS1 ANSI 彩色符号：[1m[31mlinux-iw36:~ # (B[m，具体日志如下，另外还需要产品研发人员参与评估SshUtil也有类似问题是否一起修复，你不能直接决定是否修改
20/04/2026 16:28:45.360 | INFO | [START-TaskRunningHandler]
20/04/2026 16:28:45.361 | INFO | [START-ProtocolExecution]
20/04/2026 16:28:45.361 | INFO | Ssh2ScriptProtocol,SSH
20/04/2026 16:28:45.361 | INFO | [START-AtomicityExecuting]
20/04/2026 16:28:45.361 | INFO | [START-VerifyAccountLogin]
20/04/2026 16:28:45.362 | INFO | isPreLoginAccount:0
20/04/2026 16:28:45.362 | INFO | [START-VerifyAction]
20/04/2026 16:28:45.362 | INFO | 开始执行验密任务
20/04/2026 16:28:45.366 | INFO | 开始准备登录~
20/04/2026 16:28:45.371 | INFO | root准备使用密码登录UCoqKioqKnc=
20/04/2026 16:28:45.476 | INFO | 开始创建通道，连接超时时间(单位秒):59
20/04/2026 16:28:45.486 | INFO |  域名：172.16.0.121，端口：22，账号：root，登录成功
20/04/2026 16:29:38.433 | ERROR | received ClientChannelEvent.TIMEOUT
20/04/2026 16:29:38.434 | INFO | 读取登录信息：Last login: Mon Apr 20 03:49:54 2026 from 10.10.2.87
Have a lot of fun...
[1m[31mlinux-iw36:~ # (B[m
20/04/2026 16:29:38.434 | INFO | 登录成功准备开始执行settings命令
20/04/2026 16:29:38.434 | ERROR | decisionProtocolParameterList loginOutput is null
20/04/2026 16:29:38.434 | INFO | 执行命令 >> export LANG=en_US.UTF-8; export TERM=dumb; bash
20/04/2026 16:29:38.637 | INFO | isOutputEnd=true and output suffix=:~ #
20/04/2026 16:29:38.637 | INFO | inputStream.available()=0 and isOutputEnd
20/04/2026 16:29:38.638 | INFO | 执行命令输出 >> export LANG=en_US.UTF-8; export TERM=dumb; bash
linux-iw36:~ #
20/04/2026 16:29:38.866 | INFO | 测试流程结束，结果：成功`

async function loadSystemPrompt(): Promise<string> {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT system_prompt FROM capabilities WHERE key = 'analyze_bug'`)
  if (!rows[0]?.system_prompt) throw new Error('analyze_bug system_prompt 未配置')
  return rows[0].system_prompt as string
}

async function bench(name: string, runner: { run: Function }, systemPrompt: string): Promise<void> {
  const prompt = `${systemPrompt}

代码仓库路径: ${WORKTREE_PATH}
当前 project: PAM/java-code/pas-6.0
当前分支: test

用户问题: ${USER_MESSAGE}

请按系统提示中的四阶段方法论进行根因分析，并在分析报告（中文 Markdown）之后，**在输出末尾追加一段严格的 JSON 结果**（见系统提示中的格式）。
`

  console.log(`\n===== ${name} 开始 =====`)
  const start = Date.now()
  let toolCount = 0
  let lastToolTs = start
  try {
    const out = await runner.run({
      prompt,
      allowedTools: 'Read,Glob,Grep',
      timeoutMs: 20 * 60_000,
      cwd: WORKTREE_PATH,
      onEvent: (e: { type: string; message: string; data?: Record<string, unknown> }) => {
        if (e.type === 'tool_call') {
          toolCount++
          const gap = ((Date.now() - lastToolTs) / 1000).toFixed(1)
          lastToolTs = Date.now()
          console.log(`  [${name}] tool_call #${toolCount}: ${e.message} (+${Math.round((Date.now() - start) / 1000)}s, gap=${gap}s)`)
        } else if (e.type === 'done') {
          console.log(`  [${name}] done: ${e.message}`)
        } else {
          console.log(`  [${name}] ${e.type}: ${e.message}`)
        }
      },
    })
    const sec = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`\n===== ${name} 完成: ${sec}s, ${toolCount} 个 tool_call =====`)
    console.log(`输出长度: ${out.length} chars`)
    console.log(`输出前 300 字: ${out.slice(0, 300)}`)
    console.log(`...`)
    console.log(`输出后 300 字: ${out.slice(-300)}`)
  } catch (err) {
    const sec = ((Date.now() - start) / 1000).toFixed(1)
    console.error(`[${name}] 失败 (${sec}s):`, err instanceof Error ? err.message : err)
  }
}

async function main() {
  const mode = process.argv[2] ?? 'both'
  const systemPrompt = await loadSystemPrompt()
  console.log(`已加载 analyze_bug system_prompt（${systemPrompt.length} 字符）`)
  console.log(`Worktree: ${WORKTREE_PATH}`)

  if (mode === 'cli' || mode === 'both') {
    await bench('CLI', new CliExecutor(), systemPrompt)
  }
  if (mode === 'porygon' || mode === 'both') {
    await bench('Porygon', new PorygonExecutor(), systemPrompt)
  }

  await getPool().end()
}

main().catch(err => {
  console.error('fatal:', err)
  process.exit(1)
})
