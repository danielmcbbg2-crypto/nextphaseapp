// Which uploaded request photos are leftovers: sitting in incoming/ for over a day and never
// attached to a request (unit tested).

export type Upload = { name: string; created_at: string | null }

export const KEEP_MS = 86_400_000

/** Names (full paths) of incoming/ uploads older than a day that no request uses. */
export function staleUploads(uploads: Upload[], claimed: Set<string>, now = Date.now(), prefix = 'incoming'): string[] {
  return uploads
    .filter((u) => {
      const t = u.created_at ? new Date(u.created_at).getTime() : NaN
      return Number.isFinite(t) && now - t > KEEP_MS && !claimed.has(`${prefix}/${u.name}`)
    })
    .map((u) => `${prefix}/${u.name}`)
}
