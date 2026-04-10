import { upsertImageCache } from '../../db/repositories/image-cache.js'

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

    if (body.object_kind === 'pipeline') {
      await this.handlePipeline(body)
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
