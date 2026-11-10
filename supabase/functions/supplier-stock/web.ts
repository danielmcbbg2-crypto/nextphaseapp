// Fetching supplier pages safely: public web addresses only (never local or private ones), with each
// redirect checked. The same checks as store-assistant/photo.ts.

/** Only public web addresses: no IP addresses, local names or logins in the link. */
export function fetchable(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  return (
    host.length > 0 &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    !url.username &&
    !url.password &&
    host.includes('.') &&
    !host.includes(':') &&
    !/^[\d.]+$/.test(host) &&
    !/(^|\.)(localhost|localdomain|local|internal|lan|home|arpa)$/.test(host)
  )
}

/** A private, local or reserved address (IPv4 or IPv6, including IPv4 inside IPv6). */
export function privateAddress(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const v4 = a.match(/(?:^|:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [b0, b1] = [Number(v4[1]), Number(v4[2])]
    return (
      b0 === 0 || b0 === 10 || b0 === 127 || b0 >= 224 ||
      (b0 === 100 && b1 >= 64 && b1 <= 127) ||
      (b0 === 169 && b1 === 254) ||
      (b0 === 172 && b1 >= 16 && b1 <= 31) ||
      (b0 === 192 && b1 === 168) ||
      (b0 === 198 && (b1 === 18 || b1 === 19))
    )
  }
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('::ffff:')
}

type Dns = (h: string, t: 'A' | 'AAAA') => Promise<string[]>

/**
 * Where a name really points: refuses names that lead to private addresses, that can't be looked up,
 * or when DNS lookup isn't available at all (fails closed). `dns` is only passed in by tests.
 */
export async function resolvesPublic(host: string, dns: Dns | undefined = (globalThis as { Deno?: { resolveDns?: Dns } }).Deno?.resolveDns): Promise<boolean> {
  if (!dns) return false // can't check where the name points, so don't fetch
  const found = (await Promise.all([dns(host, 'A').catch(() => []), dns(host, 'AAAA').catch(() => [])])).flat()
  return found.length > 0 && !found.some(privateAddress)
}

const UA = 'Mozilla/5.0 (compatible; NextPhaseStore/1.0; +https://portal.nextphasemaintenance.com.au)'


/**
 * Fetches a public web address (following up to 3 redirects, each checked), and returns its bytes,
 * up to `maxBytes`. Refuses local and private addresses.
 */
export async function safeFetch(start: string, signal: AbortSignal, accept: string, maxBytes: number): Promise<{ url: string; type: string; bytes: Uint8Array }> {
  let url = new URL(start)
  for (let hop = 0; hop < 4; hop++) {
    if (!fetchable(url) || !(await resolvesPublic(url.hostname.replace(/\.+$/, '')))) throw new Error(`Can't open ${url.hostname}`)
    const res = await fetch(url, { signal, redirect: 'manual', headers: { 'user-agent': UA, accept } })
    // Look the name up again now the connection is made: a site that answered differently the second
    // time (DNS rebinding) is refused, and nothing it sent is used.
    if (!(await resolvesPublic(url.hostname.replace(/\.+$/, '')))) {
      await res.body?.cancel()
      throw new Error(`Can't open ${url.hostname}`)
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel()
      url = new URL(res.headers.get('location')!, url)
      continue
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      throw new Error(`${url.hostname} answered ${res.status}`)
    }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (size < maxBytes) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
    }
    await reader.cancel().catch(() => {})
    const bytes = new Uint8Array(Math.min(size, maxBytes))
    let at = 0
    for (const c of chunks) {
      const part = c.subarray(0, Math.max(0, bytes.length - at))
      bytes.set(part, at)
      at += part.length
    }
    return { url: url.href, type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), bytes }
  }
  throw new Error('Too many redirects')
}
