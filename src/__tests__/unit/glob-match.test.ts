import { describe, it, expect } from 'vitest'
import { globMatch } from '../../pipeline/glob-match.js'

describe('globMatch', () => {
  it('matches simple suffix pattern', () => {
    expect(globMatch('PAM-Docker-develop.tar.gz', 'PAM-Docker-develop*.tar.gz')).toBe(true)
  })
  it('matches with multiple stars', () => {
    expect(globMatch('PAM-Docker-6.7.0.10.tar.gz', 'PAM-*.tar.gz')).toBe(true)
  })
  it('rejects non-matching name', () => {
    expect(globMatch('other.tar.gz', 'PAM-*.tar.gz')).toBe(false)
  })
  it('? matches single char', () => {
    expect(globMatch('a1b', 'a?b')).toBe(true)
    expect(globMatch('a12b', 'a?b')).toBe(false)
  })
  it('escapes regex special chars in glob (dot)', () => {
    expect(globMatch('file.tar.gz', 'file.tar.gz')).toBe(true)
    expect(globMatch('fileXtar.gz', 'file.tar.gz')).toBe(false)
  })
  it('empty glob matches everything', () => {
    expect(globMatch('any', '')).toBe(true)
  })
})
