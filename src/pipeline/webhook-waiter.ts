/**
 * WebhookWaiter — adapter between external webhook deliveries and
 * LangGraph Command({resume}).
 *
 * Task 3 shape:
 *   - Holds an in-memory Map<tag, { runId, stageIndex }>
 *   - `register(tag, runId, stageIndex)` — graph-runner (Task 4) calls this
 *     when a wait_webhook stage hits `interrupt(...)`
 *   - `resume(tag, data)` — webhook-receiver calls this when the external
 *     event arrives; we look up the entry, hand it to the injected
 *     resumeHandler (Task 4 wires it to graph.invoke with a Command),
 *     then clear the mapping.
 *
 * Non-responsibility (vs legacy WebhookWaiter):
 *   - No Promise pool / resolvers — interrupt() replaces that
 *   - No timeout management — Task 4 graph-runner owns it and dispatches
 *     `new Command({ resume: { timeout: true } })` directly
 */

import type { WebhookResume } from './graph-builder.js'

export interface WebhookResumeParams {
  tag: string
  runId: number
  stageIndex: number
  payload: WebhookResume
}

export type WebhookResumeHandler = (
  params: WebhookResumeParams,
) => void | Promise<void>

interface WaiterEntry {
  runId: number
  stageIndex: number
}

export class WebhookWaiter {
  private static instance: WebhookWaiter | null = null
  private waiters = new Map<string, WaiterEntry>()
  private resumeHandler: WebhookResumeHandler | null = null

  static getInstance(): WebhookWaiter {
    if (!WebhookWaiter.instance) {
      WebhookWaiter.instance = new WebhookWaiter()
    }
    return WebhookWaiter.instance
  }

  /** Test utility: clear all internal state and drop the singleton. */
  static resetInstance(): void {
    if (WebhookWaiter.instance) {
      WebhookWaiter.instance.waiters.clear()
      WebhookWaiter.instance.resumeHandler = null
    }
    WebhookWaiter.instance = null
  }

  /**
   * Inject the resume handler. Called once at startup by graph-runner (Task 4).
   */
  setResumeHandler(handler: WebhookResumeHandler): void {
    this.resumeHandler = handler
  }

  /**
   * Register a tag → (runId, stageIndex) mapping.
   *
   * If the same tag is already registered, the new entry overwrites the old
   * one — this mirrors the legacy behaviour where re-`wait()`ing the same tag
   * cancelled the previous waiter.
   */
  register(tag: string, runId: number, stageIndex: number): void {
    this.waiters.set(tag, { runId, stageIndex })
    console.log(
      `[WebhookWaiter] registered tag=${tag} runId=${runId} stage=${stageIndex}`,
    )
  }

  /**
   * Called by webhook-receiver when the external event arrives.
   *
   * Returns `true` if a matching waiter was found (and the handler was
   * invoked), `false` otherwise. The handler is invoked synchronously from
   * this function's perspective — we fire-and-forget the promise it returns,
   * which matches the existing webhook-receiver's non-async call site.
   *
   * The payload sent to the handler is `{ data }` — timeout is the
   * graph-runner's responsibility and does not come through here.
   */
  resume(tag: string, data: unknown): boolean {
    const entry = this.waiters.get(tag)
    if (!entry) return false

    this.waiters.delete(tag)

    if (!this.resumeHandler) {
      console.warn(
        `[WebhookWaiter] no resumeHandler registered; dropping webhook for tag=${tag}`,
      )
      return true
    }

    console.log(
      `[WebhookWaiter] resumed tag=${tag} runId=${entry.runId} stage=${entry.stageIndex}`,
    )
    // Fire-and-forget; graph-runner propagates any error to the run record.
    void Promise.resolve(
      this.resumeHandler({
        tag,
        runId: entry.runId,
        stageIndex: entry.stageIndex,
        payload: { data },
      }),
    ).catch((err) => {
      console.error(`[WebhookWaiter] resumeHandler threw for tag=${tag}:`, err)
    })
    return true
  }

  /** Number of outstanding registrations (monitoring). */
  get pendingCount(): number {
    return this.waiters.size
  }

  /**
   * @deprecated Legacy Promise-returning API removed in Task 3.
   *   The executor (Task 4) will switch to graph-runner + `register`.
   *   Kept as a throwing stub so `tsc --noEmit` keeps passing.
   */
  wait(
    _tag: string,
    _timeoutMs: number,
  ): Promise<{ data: unknown } | null> {
    return Promise.reject(
      new Error(
        'WebhookWaiter.wait: legacy API removed in Task 3; use register() + resumeHandler instead',
      ),
    )
  }

  /**
   * @deprecated Legacy cancel-on-timeout API. Superseded by the resumeHandler
   *   clearing its own entry on success and by graph-runner owning the
   *   timeout path. Retained as a defensive best-effort `waiters.delete(tag)`
   *   for stray call sites — safe to call with an unregistered tag.
   */
  cancel(tag: string): void {
    this.waiters.delete(tag)
  }
}
