import { posix } from 'node:path'

/**
 * Path of a file that does not exist yet: the real parent plus the missing
 * suffix. A symlink parent resolves to its target, so `link → /etc` plus
 * `evil` becomes `/etc/evil` before the writable-root check.
 */
export function composeCreatedPath(ancestorReal: string, missingNames: readonly string[]): string {
  const suffix = missingNames.filter(name => name.length > 0 && name !== '.' && name !== '..')
  if (suffix.length === 0) return posix.normalize(ancestorReal)
  return posix.normalize(posix.join(ancestorReal, ...suffix))
}

/** Walk from the leaf toward the root until `exists` is true. */
export function existingAncestor(lexicalPath: string, exists: (path: string) => boolean): { readonly cursor: string, readonly missing: readonly string[] } {
  let cursor = posix.normalize(lexicalPath)
  const missing: string[] = []
  while (cursor !== '/' && !exists(cursor)) {
    missing.push(posix.basename(cursor))
    const parent = posix.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  missing.reverse()
  return { cursor, missing }
}
