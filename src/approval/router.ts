import type { ApprovalRule } from '../db/repositories/approval-rules.js'

export class ApprovalRouter {
  constructor(private readonly rules: ApprovalRule[]) {}

  route(action: string, env: string): ApprovalRule | null {
    // Priority: exact action + exact env > exact action + * > * + exact env > * + *
    const candidates = [
      this.find(action, env),
      this.find(action, '*'),
      this.find('*', env),
      this.find('*', '*'),
    ]
    return candidates.find(Boolean) ?? null
  }

  private find(action: string, env: string): ApprovalRule | null {
    return this.rules.find(r => r.action === action && r.env === env) ?? null
  }
}
