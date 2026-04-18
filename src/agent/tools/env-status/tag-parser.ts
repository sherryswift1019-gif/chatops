export interface ParsedTag {
  branch: string
  shortId: string
}

export interface DeployedTag extends ParsedTag {
  imageTag: string
}

const TAG_RE = /^(.+)_([0-9a-f]{8})$/

export function parseImageTag(tag: string): ParsedTag | null {
  const m = TAG_RE.exec(tag)
  if (!m) return null
  return { branch: m[1], shortId: m[2] }
}

export function findDeployedTag(
  repoTags: string[],
  registryHost: string,
  harborProject: string,
): DeployedTag | null {
  const prefix = `${registryHost}/${harborProject}:`
  for (const full of repoTags) {
    if (!full.startsWith(prefix)) continue
    const tag = full.slice(prefix.length)
    const parsed = parseImageTag(tag)
    if (parsed) return { ...parsed, imageTag: tag }
  }
  return null
}
