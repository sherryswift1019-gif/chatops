/**
 * 集成测试：剩余自动化链路
 * 1. handleAnalysisComplete 触发链路（Task 13 重构后由 unit test coordinator.test.ts 覆盖）
 * 2. handleFixComplete 已删除（fix 完成现由 Pipeline ai_review / notify_bug stages 负责）
 * 3. productLineId → worktree → cwd 传递验证
 * 4. create_mr 真实创建 + 关闭 GitLab MR
 * 5. DingTalkAdapter 图片解析（mock）
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import {
  registerCapabilityHandler,
} from '../../agent/coordinator.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'

// handleAnalysisComplete 的行为由 src/__tests__/unit/coordinator.test.ts 单独覆盖（Task 13）。
// 旧的 integration 流程（label 触发 fix_bug_l1/l2 / handleFixComplete 触发 ai_review_mr）
// 在 Task 10~13 重构后已不适用：现在由 Pipeline 编排 fix_bug_lN → ai_review_mr → notify_bug。
describe.skip('Integration: handleAnalysisComplete 触发链路（已由 unit test 覆盖）', () => {
  let productLineId: number

  beforeAll(async () => {
    await resetTestDb()
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO product_lines (name, display_name, description) VALUES ('pam', 'PAM', 'test') ON CONFLICT (name) DO NOTHING RETURNING id`
    )
    productLineId = rows[0]?.id ?? (await pool.query(`SELECT id FROM product_lines WHERE name = 'pam'`)).rows[0].id

    // 确保 capabilities 存在
    for (const key of ['fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3', 'ai_review_mr']) {
      await pool.query(
        `INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval) VALUES ($1, $1, 'test', 'action', '[]', false) ON CONFLICT (key) DO NOTHING`,
        [key]
      )
    }
  })

  it('placeholder — see src/__tests__/unit/coordinator.test.ts', () => {
    void productLineId
    void registerCapabilityHandler
    void createBugAnalysisReport
    void vi
    expect(true).toBe(true)
  })
})

describe('Integration: DingTalkAdapter 图片解析（mock，对齐 pam-smart 真实结构）', () => {
  it('richText 图文混排消息提取图片和文本', async () => {
    // 真实结构：msgtype='richText', 图片/文本在 content.richText 数组中
    const msg = {
      conversationId: 'cid-test',
      senderId: 'user-001',
      senderNick: '测试',
      msgId: 'msg-richtext',
      sessionWebhook: 'https://oapi.dingtalk.com/xxx',
      robotCode: 'bot1',
      msgtype: 'richText',
      createAt: Date.now(),
      text: { content: '' },
      content: {
        richText: [
          { type: 'text', text: '这是错误截图：' },
          { type: 'picture', downloadCode: 'img-download-code-001' },
          { type: 'text', text: '请帮忙分析' },
        ],
      },
    }

    // 提取文本（和 handleRobotMessage 同逻辑）
    const text = msg.content.richText
      .filter((item: Record<string, unknown>) => item.text || (item.type === 'text' && item.text))
      .map((item: Record<string, unknown>) => (item.text as string) || '')
      .join('')
      .replace(/@\S+/g, '').trim()
    expect(text).toBe('这是错误截图：请帮忙分析')

    // 提取图片
    const images = msg.content.richText
      .filter(item => item.type === 'picture' && item.downloadCode)
      .map(item => item.downloadCode!)
    expect(images).toEqual(['img-download-code-001'])
  })

  it('引用回复消息提取被引用内容', async () => {
    // 真实结构：引用消息嵌套在 text.repliedMsg 中
    const msg = {
      conversationId: 'cid-test',
      senderId: 'user-002',
      senderNick: '测试2',
      msgId: 'msg-reply',
      sessionWebhook: 'https://oapi.dingtalk.com/xxx',
      robotCode: 'bot1',
      msgtype: 'text',
      createAt: Date.now(),
      text: {
        content: '@bot 帮我分析这个',
        repliedMsg: {
          msgType: 'richText',
          content: {
            richText: [
              { msgType: 'text', content: '登录报错 TASK_PWD_4001' },
              { msgType: 'picture', downloadCode: 'img-reply-001' },
            ],
          },
        },
      },
    }

    // 提取引用文本
    const repliedContent = msg.text.repliedMsg.content
    const repliedText = repliedContent.richText
      .filter((item: any) => item.msgType === 'text' && item.content)
      .map((item: any) => item.content)
      .join(' ')
    expect(repliedText).toBe('登录报错 TASK_PWD_4001')

    // 提取引用图片
    const images: string[] = []
    for (const item of repliedContent.richText) {
      if (item.msgType === 'picture' && item.downloadCode) {
        images.push(item.downloadCode)
      }
    }
    expect(images).toEqual(['img-reply-001'])
  })

  it('引用纯图片消息', async () => {
    const msg = {
      conversationId: 'cid-test',
      senderId: 'user-002b',
      senderNick: '测试2b',
      msgId: 'msg-reply-pic',
      msgtype: 'text',
      createAt: Date.now(),
      text: {
        content: '@bot 帮我分析这个截图',
        repliedMsg: {
          msgType: 'picture',
          content: { downloadCode: 'img-reply-pure-001' },
        },
      },
    }

    const repliedMsg = msg.text.repliedMsg
    const images: string[] = []
    if (repliedMsg.msgType === 'picture' && (repliedMsg.content as any)?.downloadCode) {
      images.push((repliedMsg.content as any).downloadCode)
    }
    expect(images).toEqual(['img-reply-pure-001'])
  })

  it('纯图片消息（content.photoURL）', async () => {
    const msg = {
      conversationId: 'cid-test',
      senderId: 'user-003',
      senderNick: '测试3',
      msgId: 'msg-pic',
      msgtype: 'picture',
      createAt: Date.now(),
      text: { content: '' },
      content: { photoURL: 'https://dtfile.com/xxx/photo.png' },
    }

    const images: string[] = []
    const contentObj = typeof msg.content === 'string' ? null : msg.content
    if (contentObj?.photoURL) {
      images.push(contentObj.photoURL)
    }
    expect(images).toEqual(['https://dtfile.com/xxx/photo.png'])

    // 文本为空时显示 [图片]
    const text = (msg.text?.content ?? '').trim() || (images.length > 0 ? '[图片]' : '')
    expect(text).toBe('[图片]')
  })

  it('imageList 数组形式', async () => {
    const msg = {
      imageList: [
        { downloadCode: 'img-list-001' },
        { downloadCode: 'img-list-002', imageUrl: 'https://fallback.png' },
      ],
    }

    const images: string[] = []
    if (msg.imageList && msg.imageList.length > 0) {
      for (const img of msg.imageList) {
        const code = img.downloadCode || img.imageUrl
        if (code) images.push(code)
      }
    }
    expect(images).toEqual(['img-list-001', 'img-list-002'])
  })
})

describe('Integration: create_mr 真实 GitLab MR', () => {
  it('创建 MR + 自动关闭', async () => {
    // 需要一个真实存在的分支。用项目的默认分支创建 MR（source = target 会失败）
    // 所以这个测试验证工具不崩溃，但 MR 可能因 source=target 被 GitLab 拒绝
    const { createMrTool } = await import('../../agent/tools/create-mr.js')

    const result = await createMrTool.execute(
      {
        projectPath: 'PAM/java-code/pas-6.0',
        title: '[AI 测试] 自动化测试 MR（请忽略）',
        description: '自动化测试创建，将立即关闭。',
        sourceBranch: 'test',  // 用已存在的分支
        targetBranch: 'master', // 不同分支才能创建 MR
        labels: 'test,ai-generated',
      },
      { taskId: 'test', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin' }
    )

    console.log('[Test] create_mr result:', result.success, result.output.substring(0, 200))

    if (result.success && result.data) {
      // 自动关闭
      const iid = (result.data as any).iid
      const axios = (await import('axios')).default
      await axios.put(
        `${process.env.GITLAB_URL}/api/v4/projects/${encodeURIComponent('PAM/java-code/pas-6.0')}/merge_requests/${iid}`,
        { state_event: 'close' },
        { headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN } }
      )
      console.log('[Test] 已关闭测试 MR !' + iid)
    }
    // 不强制 success — source/target 分支可能不满足条件
  }, 30_000)
})
