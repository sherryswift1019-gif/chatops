import bcrypt from 'bcryptjs'

const BCRYPT_ROUNDS = 12

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash)
  } catch {
    return false
  }
}

export interface PasswordStrengthResult {
  ok: boolean
  reason?: string
}

export function validatePasswordStrength(password: string): PasswordStrengthResult {
  if (password.length < 8) {
    return { ok: false, reason: '密码长度至少 8 位' }
  }
  if (/^\d+$/.test(password)) {
    return { ok: false, reason: '密码不能为纯数字' }
  }
  return { ok: true }
}
