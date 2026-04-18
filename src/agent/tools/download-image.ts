import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import axios from 'axios'

/** 钉钉 Access Token 缓存 */
let tokenCache: { token: string; expiresAt: number } | null = null

async function getDingTalkAccessToken(): Promise<string | null> {
  const clientId = process.env.DINGTALK_CLIENT_ID
  const clientSecret = process.env.DINGTALK_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  const now = Date.now()
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token
  }

  const response = await axios.post<{ accessToken: string; expireIn: number }>(
    'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    { appKey: clientId, appSecret: clientSecret },
    { timeout: 10_000 }
  )

  const { accessToken, expireIn } = response.data
  tokenCache = { token: accessToken, expiresAt: now + expireIn * 1000 }
  return accessToken
}

/** 通过钉钉 API 将 downloadCode 转为可下载 URL */
async function resolveDownloadCode(downloadCode: string): Promise<string> {
  const token = await getDingTalkAccessToken()
  if (!token) throw new Error('无法获取钉钉 Access Token（缺少 DINGTALK_CLIENT_ID/SECRET）')

  const robotCode = process.env.DINGTALK_CLIENT_ID
  const response = await axios.post(
    'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
    { downloadCode, robotCode },
    {
      headers: { 'x-acs-dingtalk-access-token': token },
      timeout: 30_000,
    }
  )

  if (response.data?.downloadUrl) {
    return response.data.downloadUrl
  }
  throw new Error('钉钉 API 未返回 downloadUrl')
}

const downloadImageTool: AgentTool = {
  name: 'download_image',
  description: '下载钉钉图片到本地临时目录。支持完整 URL 和钉钉 downloadCode。返回本地文件路径。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '图片的完整 URL 或钉钉 downloadCode' },
      filename: { type: 'string', description: '保存的文件名（可选）' },
    },
    required: ['url'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { url, filename } = params as { url: string; filename?: string }
    const tmpDir = '/tmp/ding-images'
    mkdirSync(tmpDir, { recursive: true })

    const saveName = filename ?? `img-${Date.now()}.png`
    const savePath = join(tmpDir, saveName)

    try {
      let downloadUrl = url

      // 如果不是完整 URL，视为钉钉 downloadCode，需要先换取下载地址
      if (!url.startsWith('http')) {
        console.log(`[download_image] resolving downloadCode: ${url.substring(0, 20)}...`)
        downloadUrl = await resolveDownloadCode(url)
      }

      const response = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30_000 })
      writeFileSync(savePath, response.data)
      console.log(`[download_image] saved: ${savePath} (${response.data.length} bytes)`)
      return { success: true, output: savePath }
    } catch (err) {
      return { success: false, output: `下载失败：${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

registerTool(downloadImageTool)
export { downloadImageTool }
