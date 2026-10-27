/** Publish a shared promise before the caller can await, so concurrent claims share one flight. */
export function claimPending<T>(map: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const pending = create().catch(error => {
    if (map.get(key) === pending) map.delete(key)
    throw error
  })
  map.set(key, pending)
  return pending
}