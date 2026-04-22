/**
 * 独立测试：发 3 张钉钉互动卡片做 A/B/C 对比
 * 目的：看 issue_link 用什么格式才能渲染成可点击超链接
 *
 *   A — 光秃 URL
 *   B — Markdown [text](url)
 *   C — HTML <a href>
 *
 * 运行：pnpm tsx scripts/test-dingtalk-card.ts
 */
import axios from 'axios'
import { Pool } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://chatops:chatops@localhost:5432/chatops'
const TEMPLATE_ID = process.env.DINGTALK_L3_CARD_TEMPLATE_ID ?? '38c337a5-61c7-4b6d-ba0f-ab1cb52c5193.schema'
const TARGET_USER_ID = '183832601538060368' // 女皇驾到（从 memory 取）

const ISSUE_URL = 'https://code.paraview.cn/chatops/chatops/issues/999'
const ISSUE_TITLE = '测试 Issue #999'

async function loadDingtalkCfg(): Promise<{ clientId: string; clientSecret: string }> {
  const pool = new Pool({ connectionString: DATABASE_URL })
  const { rows } = await pool.query("SELECT value FROM system_config WHERE key='dingtalk'")
  await pool.end()
  if (!rows.length) throw new Error('system_config.dingtalk 不存在')
  return rows[0].value
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await axios.post<{ accessToken: string }>(
    'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    { appKey: clientId, appSecret: clientSecret }
  )
  return res.data.accessToken
}

async function sendCard(
  token: string,
  robotCode: string,
  tag: 'A' | 'B' | 'C',
  issueLinkValue: string,
  description: string,
  status: 'pending' | 'agree' | 'reject' = 'pending',
): Promise<void> {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const outTrackId = `test-card-${tag}-${Date.now()}`

  const cardParamMap: Record<string, string> = {
    title: `Bug 修复方案审批 [${status}]`,
    body: issueLinkValue,
    remark: description,
    createTime: nowStr,
    status,
  }

  console.log(`\n[${tag}] 发送卡片，issue_link=${JSON.stringify(issueLinkValue)}`)

  await axios.post(
    'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver',
    {
      userIdType: 1,
      cardTemplateId: TEMPLATE_ID,
      outTrackId,
      callbackType: 'STREAM',
      cardData: { cardParamMap },
      openSpaceId: `dtv1.card//IM_ROBOT.${TARGET_USER_ID}`,
      imRobotOpenSpaceModel: {
        lastMessageI18n: { ZH_CN: `[测试 ${tag}] ${ISSUE_TITLE}` },
        supportForward: false,
      },
      imRobotOpenDeliverModel: {
        spaceType: 'IM_ROBOT',
        robotCode,
      },
    },
    { headers: { 'x-acs-dingtalk-access-token': token } }
  )
  console.log(`[${tag}] ✓ 已送达，outTrackId=${outTrackId}`)
}

async function main(): Promise<void> {
  const cfg = await loadDingtalkCfg()
  const token = await getAccessToken(cfg.clientId, cfg.clientSecret)
  console.log(`已拿到 access token，robotCode=${cfg.clientId}`)

  // 模拟 primary_project_owner resolver 产出的 body（精简 3 行）
  const body = [
    `**Issue**：[#999](${ISSUE_URL})`,
    '',
    `**产线**：PAS-API`,
    '',
    `**等级**：L3`,
  ].join('\n')

  await sendCard(token, cfg.clientId, 'A', body, 'pending 态（应显示 拒绝/同意 可点）', 'pending')
  await sendCard(token, cfg.clientId, 'B', body, 'agree 态（应只显示 已同意 灰色）', 'agree')
  await sendCard(token, cfg.clientId, 'C', body, 'reject 态（应只显示 已拒绝 灰色）', 'reject')

  console.log('\n3 张不同 status 的卡片已发送完毕。')
}

main().catch((err) => {
  console.error('失败：', err.response?.data ?? err.message ?? err)
  process.exit(1)
})
