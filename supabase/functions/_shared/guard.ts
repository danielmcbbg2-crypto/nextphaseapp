// Small protections for the functions that run without a sign-in (unit tested).

/** What callers see when something fails; the detail goes to the log only. */
export const GENERIC_ERROR = 'Something went wrong. Please try again.'

const same = (a: string, b: string) => {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Optional shared secret for "run"-style endpoints. When the CRON_SECRET setting is set, callers must
 * send it in the x-cron-secret header; when it isn't set, nothing changes (so existing schedules keep working).
 */
export function cronAllowed(req: Request, secret: string | undefined): boolean {
  if (!secret) return true
  return same(req.headers.get('x-cron-secret') ?? '', secret)
}

/** Lets one call through per `minMs` (per running instance): returns false if called again too soon. */
export function makeThrottle(minMs: number, now: () => number = Date.now): () => boolean {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < minMs) return false
    last = t
    return true
  }
}
