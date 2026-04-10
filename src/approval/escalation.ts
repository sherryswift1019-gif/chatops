interface EscalationConfig {
  primaryTimeoutMs: number
  totalTimeoutMs: number
  onPrimaryTimeout: () => void | Promise<void>
  onTotalTimeout: () => void | Promise<void>
}

export class EscalationTimer {
  private primaryTimer: ReturnType<typeof setTimeout> | null = null
  private totalTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly cfg: EscalationConfig) {}

  start(): void {
    this.primaryTimer = setTimeout(
      () => { void this.cfg.onPrimaryTimeout() },
      this.cfg.primaryTimeoutMs
    )
    this.totalTimer = setTimeout(
      () => { void this.cfg.onTotalTimeout() },
      this.cfg.totalTimeoutMs
    )
  }

  cancel(): void {
    if (this.primaryTimer) clearTimeout(this.primaryTimer)
    if (this.totalTimer) clearTimeout(this.totalTimer)
    this.primaryTimer = null
    this.totalTimer = null
  }
}
