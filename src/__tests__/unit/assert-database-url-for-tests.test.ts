import { describe, it, expect } from 'vitest'
import { assertDatabaseUrlForTests } from '../helpers/db.js'

describe('assertDatabaseUrlForTests', () => {
  it('NODE_ENV=test + URL 含 _test → 通过', () => {
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops_test', 'test'),
    ).not.toThrow()
  })

  it('NODE_ENV=test + URL 指向开发库 (不含 _test) → throw', () => {
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops', 'test'),
    ).toThrow(/DATABASE_URL 指向非测试库/)
  })

  it('NODE_ENV=test + URL=undefined → throw', () => {
    expect(() =>
      assertDatabaseUrlForTests(undefined, 'test'),
    ).toThrow(/DATABASE_URL 未设置/)
  })

  it('NODE_ENV=production → 跳过（不校验）', () => {
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops', 'production'),
    ).not.toThrow()
  })

  it('NODE_ENV=undefined → 跳过（不校验）', () => {
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops', undefined),
    ).not.toThrow()
  })

  it('throw 信息里暴露 DATABASE_URL 以便诊断', () => {
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops', 'test'),
    ).toThrow(/postgres:\/\/x\/chatops/)
  })

  it('可扩展：允许通过环境变量 ALLOWED_TEST_DB_NAMES 加白名单', () => {
    const allowed = 'chatops_e2e,chatops_staging'
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops_e2e', 'test', allowed),
    ).not.toThrow()
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops_staging', 'test', allowed),
    ).not.toThrow()
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops', 'test', allowed),
    ).toThrow(/非测试库/)
  })
})
