import type { ApprovalRule } from '../db/repositories/approval-rules.js'

export class ApprovalRouter {
  constructor(private readonly rules: ApprovalRule[]) {}

  route(imTriggerKey: string, env: string): ApprovalRule | null {
    // Priority: exact imTriggerKey + exact env > exact imTriggerKey + * > * + exact env > * + *
    const candidates = [
      this.find(imTriggerKey, env),
      this.find(imTriggerKey, '*'),
      this.find('*', env),
      this.find('*', '*'),
    ]
    return candidates.find(Boolean) ?? null
  }

  private find(imTriggerKey: string, env: string): ApprovalRule | null {
    return this.rules.find(r => r.imTriggerKey === imTriggerKey && r.env === env) ?? null
  }
}
