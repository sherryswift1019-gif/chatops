import { describe, it, expect } from 'vitest'
import { AxiosError, AxiosHeaders } from 'axios'
import { describeAxiosError } from '../../admin/routes/system-config.js'

function makeAxiosError(init: {
  message?: string
  code?: string
  response?: { status: number; data: unknown }
}): AxiosError {
  const err = new AxiosError(init.message ?? 'request failed', init.code)
  if (init.response) {
    err.response = {
      status: init.response.status,
      statusText: '',
      data: init.response.data,
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    } as AxiosError['response']
  }
  return err
}

describe('describeAxiosError()', () => {
  it('formats response errors with object.message as "HTTP <status>: <message>"', () => {
    const err = makeAxiosError({ response: { status: 401, data: { message: 'Unauthorized' } } })
    expect(describeAxiosError(err)).toBe('HTTP 401: Unauthorized')
  })

  it('falls back to object.error when message is absent', () => {
    const err = makeAxiosError({ response: { status: 403, data: { error: 'forbidden action' } } })
    expect(describeAxiosError(err)).toBe('HTTP 403: forbidden action')
  })

  it('formats response errors with string body', () => {
    const err = makeAxiosError({ response: { status: 500, data: 'internal boom' } })
    expect(describeAxiosError(err)).toBe('HTTP 500: internal boom')
  })

  it('serializes arbitrary object bodies when neither message nor error is present', () => {
    const err = makeAxiosError({ response: { status: 422, data: { errors: ['a', 'b'] } } })
    const result = describeAxiosError(err)
    expect(result.startsWith('HTTP 422: ')).toBe(true)
    expect(result).toContain('errors')
  })

  it('returns a friendly message for ECONNREFUSED', () => {
    const err = makeAxiosError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })
    expect(describeAxiosError(err)).toContain('ECONNREFUSED')
  })

  it('returns a DNS hint for ENOTFOUND', () => {
    const err = makeAxiosError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' })
    expect(describeAxiosError(err)).toContain('DNS')
  })

  it('returns a timeout hint for ETIMEDOUT and ECONNABORTED', () => {
    expect(describeAxiosError(makeAxiosError({ code: 'ETIMEDOUT' }))).toContain('超时')
    expect(describeAxiosError(makeAxiosError({ code: 'ECONNABORTED' }))).toContain('超时')
  })

  it('returns the self-signed cert hint for DEPTH_ZERO_SELF_SIGNED_CERT', () => {
    const err = makeAxiosError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    expect(describeAxiosError(err)).toContain('跳过证书验证')
  })

  it('returns err.message for axios errors with no code and no response', () => {
    const err = makeAxiosError({ message: 'network blip' })
    expect(describeAxiosError(err)).toBe('network blip')
  })

  it('returns err.message for non-axios Error instances', () => {
    expect(describeAxiosError(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error values', () => {
    expect(describeAxiosError('raw string')).toBe('raw string')
    expect(describeAxiosError(42)).toBe('42')
  })
})
