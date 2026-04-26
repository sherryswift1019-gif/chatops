import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ExecutionContext } from '../../pipeline/node-types/types.js'

// Importing the wrapper triggers self-registration once at module load.
import '../../pipeline/node-types/http.js'
import { getExecutor } from '../../pipeline/node-types/registry.js'

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: 1,
    pipelineId: 100,
    nodeId: 'h1',
    triggerParams: {},
    vars: {},
    steps: {},
    ...overrides,
  }
}

function loadHttpExecutor() {
  const exec = getExecutor('http')
  if (!exec) throw new Error('http executor not registered')
  return exec
}

function makeFetchResponse(opts: {
  status: number
  headers?: Record<string, string>
  body?: string
}): Response {
  const headers = new Headers(opts.headers ?? {})
  return new Response(opts.body ?? '', { status: opts.status, headers })
}

describe('http node executor (phase 3 T9)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  it('GET 200 → success with parsed JSON body', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, n: 7 }),
    }))
    const exec = loadHttpExecutor()

    const result = await exec.execute(
      { method: 'GET', url: 'https://api.example.com/x' },
      makeCtx(),
    )

    expect(result.status).toBe('success')
    expect(result.output).toMatchObject({
      statusCode: 200,
      body: { ok: true, n: 7 },
    })
    const headers = (result.output as Record<string, unknown>).headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.example.com/x')
    expect((init as RequestInit).method).toBe('GET')
  })

  it('POST with object body auto-JSON.stringify + Content-Type', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 201, body: '' }))
    const exec = loadHttpExecutor()

    await exec.execute(
      { method: 'POST', url: 'https://api/x', body: { a: 1 } },
      makeCtx(),
    )

    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(init.body).toBe('{"a":1}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('500 → failed with error="HTTP 500" but output preserved', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({
      status: 500,
      headers: { 'content-type': 'text/plain' },
      body: 'oops',
    }))
    const exec = loadHttpExecutor()

    const result = await exec.execute(
      { method: 'GET', url: 'https://api/fail' },
      makeCtx(),
    )

    expect(result.status).toBe('failed')
    expect(result.error).toBe('HTTP 500')
    expect((result.output as Record<string, unknown>).statusCode).toBe(500)
    expect((result.output as Record<string, unknown>).body).toBe('oops')
  })

  it('404 → failed with HTTP 404', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 404, body: 'not found' }))
    const exec = loadHttpExecutor()

    const result = await exec.execute({ method: 'GET', url: 'https://x/' }, makeCtx())
    expect(result.status).toBe('failed')
    expect(result.error).toBe('HTTP 404')
  })

  it('timeout (AbortError) → failed with timedOut/timeout', async () => {
    fetchSpy.mockImplementationOnce(async (_u, init: RequestInit) => {
      // Simulate user/abort from upstream by reading the signal.
      return await new Promise<Response>((_, reject) => {
        const sig = init.signal as AbortSignal
        sig.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const exec = loadHttpExecutor()

    const result = await exec.execute(
      { method: 'GET', url: 'https://slow/', timeoutMs: 10 },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toBe('timeout')
    expect((result.output as Record<string, unknown>).timedOut).toBe(true)
  })

  it('missing url → failed', async () => {
    const exec = loadHttpExecutor()
    const result = await exec.execute({ method: 'GET' }, makeCtx())
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/url/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('network error (fetch throws) → failed with err.message', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const exec = loadHttpExecutor()

    const result = await exec.execute(
      { method: 'GET', url: 'https://nope/' },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toBe('ECONNREFUSED')
  })
})
