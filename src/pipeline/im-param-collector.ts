import { notifyImGroup } from './im-notifier.js'
import {
  registerParamCollectWaiter,
  unregisterParamCollectWaiter,
} from './im-router.js'
import { consultImInputAgent } from './im-input-agent.js'

const COLLECTION_TIMEOUT_MS = 300_000

interface SchemaProperty { type?: string; enum?: string[]; title?: string }

function buildPrompt(paramSchema: Record<string, unknown>, imPrompt?: string | null): string {
  if (imPrompt) return imPrompt
  const props = (paramSchema.properties ?? {}) as Record<string, SchemaProperty>
  const required = (paramSchema.required ?? []) as string[]
  const parts = required.map(k => {
    const p = props[k]
    const label = p?.title ?? k
    const hint = p?.enum ? `（${p.enum.join(' / ')}）` : ''
    return `${label}${hint}`
  })
  const example = required.map(k => `${k}=xxx`).join(' ')
  return `请提供以下参数：${parts.join('，')}。\n示例：\`${example}\``
}

/**
 * 注册一个 (platform, groupId) 上的等待者，挂在那等下一条 IM 消息。
 * session-manager 收到该群消息会通过 im-router.findParamCollectWaiter 命中这里 resolve。
 *
 * 多消费方共用：im-param-collector / pipeline-b/await-human-review 等。
 *
 * @param timeoutMs 超时（默认 300s）。pipeline-b 人审 gate 会传 24h。
 */
export function waitForImMessage(
  platform: string,
  groupId: string,
  timeoutMs: number = COLLECTION_TIMEOUT_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      unregisterParamCollectWaiter(platform, groupId)
      reject(new Error(`IM 等待消息超时（${timeoutMs}ms）`))
    }, timeoutMs)

    registerParamCollectWaiter({
      platform, groupId,
      resolve: (msg: string) => {
        clearTimeout(timer)
        unregisterParamCollectWaiter(platform, groupId)
        resolve(msg)
      },
      reject: (err: Error) => {
        clearTimeout(timer)
        unregisterParamCollectWaiter(platform, groupId)
        reject(err)
      },
    })
  })
}

export async function collectImParams(
  platform: string,
  groupId: string,
  paramSchema: Record<string, unknown>,
  imPrompt?: string | null,
): Promise<Record<string, unknown>> {
  let collected: Record<string, unknown> = {}
  let prompt = buildPrompt(paramSchema, imPrompt)

  while (true) {
    const msgPromise = waitForImMessage(platform, groupId)
    try {
      await notifyImGroup(platform, groupId, prompt)
    } catch (notifyErr) {
      // Notification failed: clean up waiter and suppress orphaned promise rejection
      unregisterParamCollectWaiter(platform, groupId)
      msgPromise.catch(() => {})
      throw notifyErr
    }
    const userMessage = await msgPromise

    const result = await consultImInputAgent({ userMessage, currentParams: collected, paramSchema })

    if (result.aborted) {
      await notifyImGroup(platform, groupId, '已取消。').catch(() => {})
      throw new Error('用户取消了参数采集')
    }

    collected = result.params

    if (result.done) return collected

    prompt = result.nextPrompt ?? buildPrompt(paramSchema)
  }
}
