/**
 * Mock GitLab API server for E2E tests.
 *
 * 模拟业务代码会调用的 GitLab 端点，并提供 /_control/* 管控端点供测试侧：
 *   - 注入自定义响应（override）
 *   - 查询实际收到的请求序列（calls）
 *   - 重置内部状态（reset）
 *
 * 端口由 process.env.MOCK_PORT 控制，默认 4001。
 *
 * 直接用 tsx 运行此文件即可作为独立进程启动（Playwright webServer 会这么做）。
 */
import express from 'express'
import type { Express, Request, Response } from 'express'
import type { Server } from 'http'

export interface MockCall {
  method: string
  path: string
  body: unknown
  timestamp: number
}

export interface MockState {
  // key = `${method} ${pathPattern}` 或 `${method} ${pathPattern}/${iid}`
  responseOverrides: Map<string, unknown>
  calls: MockCall[]
  issueCounter: number
  mrCounter: number
}

function createInitialState(): MockState {
  return {
    responseOverrides: new Map(),
    calls: [],
    issueCounter: 0,
    mrCounter: 0,
  }
}

function buildOverrideKey(method: string, path: string, iid?: number): string {
  const suffix = typeof iid === 'number' ? `/${iid}` : ''
  // 归一化 path：解码 URL-encoded 字符（特别是 %2F → /），使 override 注入端
  // 和业务路由命中端（Express 已解码 params）使用同一套键。
  let normalized = path
  try {
    normalized = decodeURIComponent(path)
  } catch {
    // 非合法 URI 时按原样处理
  }
  return `${method.toUpperCase()} ${normalized}${suffix}`
}

export function buildMockApp(state: MockState): Express {
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  // --------------------------------------------------------------
  // 管控端点：仅测试侧使用
  // --------------------------------------------------------------
  app.get('/_control/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })

  app.post('/_control/reset', (_req: Request, res: Response) => {
    state.responseOverrides.clear()
    state.calls.length = 0
    state.issueCounter = 0
    state.mrCounter = 0
    res.json({ ok: true })
  })

  app.post('/_control/override', (req: Request, res: Response) => {
    const body = req.body as { path?: string; method?: string; iid?: number; response?: unknown }
    if (!body?.path || !body?.method) {
      return res.status(400).json({ error: 'path and method are required' })
    }
    const key = buildOverrideKey(body.method, body.path, body.iid)
    state.responseOverrides.set(key, body.response)
    return res.json({ ok: true, key })
  })

  app.get('/_control/calls', (_req: Request, res: Response) => {
    res.json(state.calls)
  })

  // --------------------------------------------------------------
  // 请求记录中间件（仅对非 _control 路径）
  // --------------------------------------------------------------
  app.use((req: Request, _res: Response, next) => {
    if (!req.path.startsWith('/_control')) {
      state.calls.push({
        method: req.method,
        path: req.path,
        body: req.body,
        timestamp: Date.now(),
      })
    }
    next()
  })

  // --------------------------------------------------------------
  // 业务端点
  // --------------------------------------------------------------

  // POST /api/v4/projects/:path/issues — 创建 issue
  app.post('/api/v4/projects/:projectPath/issues', (req: Request, res: Response) => {
    const key = buildOverrideKey('POST', `/api/v4/projects/${req.params.projectPath}/issues`)
    const override = state.responseOverrides.get(key)
    if (override !== undefined) return res.json(override)

    const iid = ++state.issueCounter
    const projectPath = decodeURIComponent(String(req.params.projectPath))
    return res.json({
      iid,
      web_url: `http://mock-gitlab/${projectPath}/issues/${iid}`,
    })
  })

  // POST /api/v4/projects/:path/issues/:iid/notes — issue 评论
  app.post('/api/v4/projects/:projectPath/issues/:iid/notes', (req: Request, res: Response) => {
    const iid = Number(req.params.iid)
    const key = buildOverrideKey(
      'POST',
      `/api/v4/projects/${req.params.projectPath}/issues/notes`,
      iid,
    )
    const override = state.responseOverrides.get(key)
    if (override !== undefined) return res.json(override)
    return res.json({ id: 1 })
  })

  // POST /api/v4/projects/:path/merge_requests — 创建 MR
  app.post('/api/v4/projects/:projectPath/merge_requests', (req: Request, res: Response) => {
    const key = buildOverrideKey(
      'POST',
      `/api/v4/projects/${req.params.projectPath}/merge_requests`,
    )
    const override = state.responseOverrides.get(key)
    if (override !== undefined) return res.json(override)

    const iid = ++state.mrCounter
    const projectPath = decodeURIComponent(String(req.params.projectPath))
    const body = req.body as { source_branch?: string; target_branch?: string }
    return res.json({
      iid,
      web_url: `http://mock-gitlab/${projectPath}/merge_requests/${iid}`,
      source_branch: body?.source_branch ?? 'feature/auto',
      target_branch: body?.target_branch ?? 'main',
    })
  })

  // POST /api/v4/projects/:path/merge_requests/:iid/notes — MR 评论
  app.post('/api/v4/projects/:projectPath/merge_requests/:iid/notes', (req: Request, res: Response) => {
    const iid = Number(req.params.iid)
    const key = buildOverrideKey(
      'POST',
      `/api/v4/projects/${req.params.projectPath}/merge_requests/notes`,
      iid,
    )
    const override = state.responseOverrides.get(key)
    if (override !== undefined) return res.json(override)
    return res.json({ id: 1 })
  })

  // PUT /api/v4/projects/:path/merge_requests/:iid — 更新 labels
  app.put('/api/v4/projects/:projectPath/merge_requests/:iid', (req: Request, res: Response) => {
    const iid = Number(req.params.iid)
    const key = buildOverrideKey(
      'PUT',
      `/api/v4/projects/${req.params.projectPath}/merge_requests`,
      iid,
    )
    const override = state.responseOverrides.get(key)
    if (override !== undefined) return res.json(override)
    const body = req.body as { add_labels?: string; remove_labels?: string }
    const labels: string[] = []
    if (body?.add_labels) labels.push(...body.add_labels.split(',').filter(Boolean))
    return res.json({ iid, labels })
  })

  // GET /api/v4/projects/:path/merge_requests/:iid — 查单个 MR 状态（mr-state-reconciler 对账用）
  app.get('/api/v4/projects/:projectPath/merge_requests/:iid', (req: Request, res: Response) => {
    const iid = Number(req.params.iid)
    const key = buildOverrideKey(
      'GET',
      `/api/v4/projects/${req.params.projectPath}/merge_requests`,
      iid,
    )
    const override = state.responseOverrides.get(key)
    if (override !== undefined) return res.json(override)
    // 默认返回 opened；测试通过 /_control/override 注入 merged / closed
    const projectPath = decodeURIComponent(String(req.params.projectPath))
    return res.json({
      iid,
      state: 'opened',
      merged_at: null,
      merged_by: null,
      closed_at: null,
      closed_by: null,
      web_url: `http://mock-gitlab/${projectPath}/merge_requests/${iid}`,
    })
  })

  // GET /api/v4/projects/:path/merge_requests/:iid/changes — 读 MR diff
  app.get('/api/v4/projects/:projectPath/merge_requests/:iid/changes', (req: Request, res: Response) => {
    const iid = Number(req.params.iid)
    const key = buildOverrideKey(
      'GET',
      `/api/v4/projects/${req.params.projectPath}/merge_requests/changes`,
      iid,
    )
    const override = state.responseOverrides.get(key)
    if (override !== undefined) return res.json(override)
    return res.json({
      changes: [
        {
          old_path: 'x.java',
          new_path: 'x.java',
          diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
        },
      ],
    })
  })

  // 兜底：任何未匹配的 /api/v4/* 请求返回 200 { ok: true }，方便排错
  app.all('/api/v4/*splat', (_req: Request, res: Response) => {
    res.json({ ok: true })
  })

  return app
}

export async function createMockGitLabServer(port: number): Promise<{
  close: () => Promise<void>
  getState: () => MockState
}> {
  const state = createInitialState()
  const app = buildMockApp(state)
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, () => resolve(s))
    s.on('error', reject)
  })
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()))
      }),
    getState: () => state,
  }
}

// --------------------------------------------------------------
// Entry point: 作为独立进程启动（Playwright webServer 用）
// --------------------------------------------------------------
const isDirectRun = (() => {
  try {
    const argv1 = process.argv[1] ?? ''
    const importUrl = import.meta.url
    // argv[1] 是 fs 路径，import.meta.url 是 file:// URL；简单归一化比较
    const normalizedArgv = argv1.replace(/\\/g, '/')
    return importUrl.endsWith(normalizedArgv) || importUrl.endsWith(`${normalizedArgv}`)
  } catch {
    return false
  }
})()

if (isDirectRun) {
  const port = Number(process.env.MOCK_PORT ?? 4001)
  createMockGitLabServer(port)
    .then(() => {
      // eslint-disable-next-line no-console
      console.log(`[mock-gitlab] listening on http://localhost:${port}`)
    })
    .catch(err => {
      // eslint-disable-next-line no-console
      console.error('[mock-gitlab] failed to start:', err)
      process.exit(1)
    })
}
