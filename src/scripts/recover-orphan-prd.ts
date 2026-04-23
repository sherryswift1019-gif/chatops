/**
 * 一次性脚本：把 docs/prds/ux-design-agent.md 这条"被 Write 绕过 save_prd 写出去的"
 * PRD 导入 DB 并链接到对应的 prd_chat_sessions。
 *
 * 用法: pnpm tsx src/scripts/recover-orphan-prd.ts
 */
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { createPrdDocument } from '../db/repositories/prd-documents.js'
import { linkChatSessionToPrd, getChatSessionByKey } from '../db/repositories/prd-chat.js'
import { getPool } from '../db/client.js'

const FILE_PATH = resolve(process.cwd(), 'docs/prds/ux-design-agent.md')
const SESSION_KEY = 'd8e7dd1e-0125-4108-8981-7dee459a9efe'

async function main() {
  const content = await readFile(FILE_PATH, 'utf8')

  const h1 = content.match(/^#\s+(.+?)\s*$/m)
  const title = h1 ? h1[1].trim() : 'UI/UX 设计师 Agent — 产品需求文档'

  const session = await getChatSessionByKey(SESSION_KEY)
  if (!session) {
    throw new Error(`session ${SESSION_KEY} not found`)
  }

  const prd = await createPrdDocument({
    productLineId: session.productLineId,
    title,
    contentMarkdown: content,
    createdBy: session.createdBy,
    platform: 'web',
    agentSessionId: `web-prd-${SESSION_KEY}`,
  })

  await linkChatSessionToPrd(SESSION_KEY, prd.id)

  console.log(`✅ 已恢复 PRD #${prd.id}「${title}」，状态 ${prd.status}，会话已关联`)
  console.log(`   文件来源: ${FILE_PATH}`)
  console.log(`   下一步: 在 /prd-documents 列表查看，或在 Web 对话里让 agent "帮我审一下 PRD #${prd.id}" 触发自审`)

  await getPool().end()
}

main().catch((err) => {
  console.error('❌ 恢复失败:', err)
  process.exit(1)
})
