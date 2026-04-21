import { describe, it, expect } from 'vitest'
import { assertDatabaseUrlForTests } from '../helpers/db.js'

/**
 * 此函数在 main 的 LangGraph 改造合并后被放宽为"仅非空校验"，
 * 名字约定（含 _test 或白名单）已废弃，真正的测试库判别交给 resetTestDb
 * 内部的 marker 表 chatops_test_db_marker。
 *
 * 放宽原因：GitLab CI 的 postgres service 默认 db 名就叫 `chatops`，
 * 严格要 _test 后缀会导致 CI 启动即失败（见截图：
 * "DATABASE_URL 指向非测试库 (postgres://chatops:chatops@postgres:5432/chatops)"）
 */
describe('assertDatabaseUrlForTests', () => {
  it('NODE_ENV=test + URL 非空（含 _test）→ 通过', () => {
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops_test', 'test'),
    ).not.toThrow()
  })

  it('NODE_ENV=test + URL 非空（不含 _test，形如 CI 的 chatops）→ 通过', () => {
    expect(() =>
      assertDatabaseUrlForTests('postgres://chatops:chatops@postgres:5432/chatops', 'test'),
    ).not.toThrow()
  })

  it('NODE_ENV=test + URL=undefined → throw', () => {
    expect(() =>
      assertDatabaseUrlForTests(undefined, 'test'),
    ).toThrow(/DATABASE_URL 未设置/)
  })

  it('NODE_ENV=production → 跳过（不校验，允许任意 URL）', () => {
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops', 'production'),
    ).not.toThrow()
    expect(() =>
      assertDatabaseUrlForTests(undefined, 'production'),
    ).not.toThrow()
  })

  it('NODE_ENV=undefined → 跳过（不校验）', () => {
    expect(() =>
      assertDatabaseUrlForTests('postgres://x/chatops', undefined),
    ).not.toThrow()
  })

  it('throw 信息里提示 marker 表名以便排查', () => {
    expect(() =>
      assertDatabaseUrlForTests(undefined, 'test'),
    ).toThrow(/chatops_test_db_marker/)
  })
})
