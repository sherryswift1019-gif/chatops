import { upsertImageCache } from '../../db/repositories/image-cache.js'
import { handleIssueEvent, handleMergeRequestEvent } from './issue-handler.js'
import { WebhookWaiter } from '../../pipeline/webhook-waiter.js'

type PipelineNotifyFn = (project: string, status: string, pipelineId: number) => void | Promise<void>

export class GitLabWebhookReceiver {
  private pipelineNotify: PipelineNotifyFn | null = null

  constructor(private readonly secret: string) {}

  onPipelineEvent(fn: PipelineNotifyFn): void {
    this.pipelineNotify = fn
  }

  async handle(payload: unknown, headers: Record<string, string>): Promise<void> {
    const token = headers['x-gitlab-token']
    if (token !== this.secret) throw new Error('Invalid token')

    const body = payload as Record<string, unknown>

    // 尝试匹配 Pipeline wait_webhook 阶段的等待
    const tag = buildWebhookTag(body)
    if (tag) WebhookWaiter.getInstance().resume(tag, body)

    if (body.object_kind === 'pipeline') {
      await this.handlePipeline(body)
    } else if (body.object_kind === 'issue') {
      await handleIssueEvent(body as any).catch(err => {
        console.error('[GitLab] issue event handler error:', err)
      })
    } else if (body.object_kind === 'merge_request') {
      await handleMergeRequestEvent(body as any).catch(err => {
        console.error('[GitLab] merge_request event handler error:', err)
      })
    }
  }

  private async handlePipeline(body: Record<string, unknown>): Promise<void> {
    const attrs = body.object_attributes as Record<string, unknown>
    const status = attrs.status as string
    const pipelineId = attrs.id as number
    const project = (body.project as Record<string, string>).name
    const commit = body.commit as Record<string, string> | undefined
    const variables = (body.variables as Array<{ key: string; value: string }>) ?? []
    const imageTag = variables.find(v => v.key === 'IMAGE_TAG')?.value

    if (status === 'success' && imageTag) {
      await upsertImageCache({
        project,
        tag: imageTag,
        builtAt: commit?.timestamp ? new Date(commit.timestamp) : new Date(),
        commitSha: commit?.id,
        commitMessage: commit?.message,
        pipelineId,
      })
    }

    await this.pipelineNotify?.(project, status, pipelineId)
  }
}

/** 从 GitLab webhook body 构建匹配 tag，如 'mr-merged:PAM/java-code/pas-6.0:123' */
function buildWebhookTag(body: Record<string, unknown>): string | null {
  const kind = body.object_kind as string
  const project = (body.project as Record<string, string>)?.path_with_namespace

  if (kind === 'merge_request') {
    const attrs = body.object_attributes as Record<string, unknown>
    const action = attrs?.action as string
    const iid = attrs?.iid as number
    if (project && action && iid) {
      return `mr-${action}:${project}:${iid}`
    }
  }

  if (kind === 'pipeline') {
    const attrs = body.object_attributes as Record<string, unknown>
    const status = attrs?.status as string
    const id = attrs?.id as number
    if (project && status && id) {
      return `pipeline-${status}:${project}:${id}`
    }
  }

  if (kind === 'issue') {
    const attrs = body.object_attributes as Record<string, unknown>
    const action = attrs?.action as string
    const iid = attrs?.iid as number
    if (project && action && iid) {
      return `issue-${action}:${project}:${iid}`
    }
  }

  return null
}
