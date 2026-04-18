export function globMatch(name: string, glob: string): boolean {
  if (!glob) return true
  const pattern = '^' + glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$'
  return new RegExp(pattern).test(name)
}
