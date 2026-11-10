// Pure safety helpers for the service-leads function (no Deno or network use, so they are unit tested).

/** Reply links stop working after this many days (was 30). */
export const LINK_DAYS = 7

export const linkExpired = (createdAt: string, now = Date.now()): boolean => {
  const t = new Date(createdAt).getTime()
  return !Number.isFinite(t) || now - t > LINK_DAYS * 86_400_000
}

/** The address inside a From header: `Name <a@b.com>` or `a@b.com`, lower-cased. '' if none. */
export const senderAddress = (from: string): string => {
  const angle = from.match(/<([^<>\s]+)>\s*$/)
  const raw = (angle ? angle[1] : from).trim().toLowerCase()
  return /^[^@\s<>]+@[^@\s<>]+$/.test(raw) ? raw : ''
}

/** Only mail whose sender address really is @service.com.au (or a subdomain of it). */
export const fromServiceDotComAu = (from: string): boolean => {
  const addr = senderAddress(from)
  if (!addr) return false
  const domain = addr.slice(addr.lastIndexOf('@') + 1)
  return domain === 'service.com.au' || domain.endsWith('.service.com.au')
}

/** Removes web links, email addresses and phone numbers from model-written text. */
export const stripContacts = (s: string): string =>
  s
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|au|nz|uk)(?:\/\S*)?\b/gi, '')
    .replace(/(?:\+?\d[\s().-]?){8,}/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .trim()

/** What callers of the public functions see when something fails (details go to the log only). */
export const GENERIC_ERROR = 'Something went wrong. Please try again.'
