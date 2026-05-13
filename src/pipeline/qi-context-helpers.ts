import { access, symlink, unlink, mkdir } from 'fs/promises'
import { join } from 'path'

async function safeSymlink(target: string, link: string): Promise<void> {
  try {
    await access(target)
  } catch {
    return  // target doesn't exist, skip silently (forward-compatible)
  }
  try {
    await unlink(link)
  } catch {
    // didn't exist; fine
  }
  await symlink(target, link)
}

export async function linkBrainstormArtifacts(args: {
  worktreePath: string
  requirementId: number
}): Promise<void> {
  const ctxDir = join(args.worktreePath, '.qi-context')
  await mkdir(ctxDir, { recursive: true })
  const mdSrc = join(args.worktreePath, `docs/brainstorm/qi-${args.requirementId}.md`)
  const jsonSrc = join(args.worktreePath, `docs/brainstorm/qi-${args.requirementId}.json`)
  await safeSymlink(mdSrc, join(ctxDir, 'brainstorm.md'))
  await safeSymlink(jsonSrc, join(ctxDir, 'enriched-input.json'))
}
