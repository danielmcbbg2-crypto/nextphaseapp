// Pure checks for the invite-user function (unit tested).

export const MASTER_ID = 'u-admin'

/** Whether `me` may delete `targetId`: not yourself, and only the master admin may delete the master admin. */
export function deleteBlocked(targetId: string, meId: string): string | null {
  if (targetId === meId) return "You can't delete your own account"
  if (targetId === MASTER_ID) return 'The master admin account can’t be deleted'
  return null
}

/** The origins the portal's links may point to: the portal's own address plus any listed in APP_ORIGINS (comma separated). */
export function allowedOrigins(portalUrl: string, extra = ''): string[] {
  return [portalUrl, ...extra.split(',')]
    .map((u) => u.trim())
    .filter(Boolean)
    .flatMap((u) => {
      try {
        const o = new URL(u)
        return o.protocol === 'https:' || o.hostname === 'localhost' ? [o.origin] : []
      } catch {
        return []
      }
    })
}

/** A link address on one of the portal's own origins (so a link can never be built pointing at another site). */
export function isAppUrl(u: unknown, origins: string[]): u is string {
  if (typeof u !== 'string' || !/^https?:\/\/[^\s]+$/.test(u)) return false
  try {
    const url = new URL(u)
    return !url.username && !url.password && origins.includes(url.origin)
  } catch {
    return false
  }
}
