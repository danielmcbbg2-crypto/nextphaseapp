/**
 * Tests for the fixes from the code review (ORDER-20261107-02): the pure helpers behind them.
 * Run with `npm run test:unit`.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GENERIC_ERROR, fromServiceDotComAu, linkExpired, senderAddress, stripContacts, LINK_DAYS } from '../functions/service-leads/guards.ts'
import { MASTER_ID, allowedOrigins, deleteBlocked, isAppUrl } from '../functions/invite-user/guards.ts'
import { claimOnce, releaseClaim } from '../functions/send-sms/claim.ts'
import { resolvesPublic as resolvesPublicWeb } from '../functions/supplier-stock/web.ts'
import { resolvesPublic as resolvesPublicPhoto } from '../functions/store-assistant/photo.ts'
import { cronAllowed, makeThrottle, GENERIC_ERROR as SHARED_ERROR } from '../functions/_shared/guard.ts'
import { staleUploads } from '../functions/purge-lead-photos/stale.ts'
import { missingSupabaseSettings } from '../../src/lib/buildCheck.ts'

const day = 86_400_000

describe('issue 1: service-leads reply links', () => {
  test('links last 7 days, not 30', () => {
    const now = Date.now()
    assert.equal(LINK_DAYS, 7)
    assert.equal(linkExpired(new Date(now - 6 * day).toISOString(), now), false)
    assert.equal(linkExpired(new Date(now - 8 * day).toISOString(), now), true)
    assert.equal(linkExpired('garbage', now), true)
  })

  test('the function decides once and texts once, atomically', () => {
    const src = readFileSync(new URL('../functions/service-leads/index.ts', import.meta.url), 'utf8')
    assert.match(src, /\.eq\('status', 'awaiting'\)\.select\('lead_id'\)/) // decide only while undecided
    assert.match(src, /This reply has already been decided/)
    assert.match(src, /\.eq\('phone', ''\)\.select\('id'\)/) // contact only while no number is set
    assert.match(src, /already been texted/)
  })
})

describe('issue 3: service-leads email handling', () => {
  test('only a sender address that really is @service.com.au passes', () => {
    assert.equal(senderAddress('Service <leads@service.com.au>'), 'leads@service.com.au')
    assert.ok(fromServiceDotComAu('Service <leads@service.com.au>'))
    assert.ok(fromServiceDotComAu('alerts@mail.service.com.au'))
    assert.ok(!fromServiceDotComAu('x@service.com.au.evil.com'))
    assert.ok(!fromServiceDotComAu('x@evilservice.com.au'))
    assert.ok(!fromServiceDotComAu('"leads@service.com.au" <x@evil.com>'))
    assert.ok(!fromServiceDotComAu('not an address'))
    assert.ok(!fromServiceDotComAu(''))
  })

  test('links, email addresses and phone numbers are stripped from drafted text', () => {
    const out = stripContacts('Hi Sam, see https://evil.example/x or www.evil.com/a, email me at a@b.com or call 0412 345 678 / +61 3 9123 4567. Thanks!')
    assert.ok(!/https?:|www\.|@|\d{4}/.test(out), out)
    assert.match(out, /Hi Sam/)
    assert.match(out, /Thanks!/)
    assert.equal(stripContacts('Small bathroom renovation'), 'Small bathroom renovation')
    assert.equal(stripContacts('Replace 2 taps, 3 rooms, 12 weeks'), 'Replace 2 taps, 3 rooms, 12 weeks')
  })

  test('the Gmail script checks the sender too', () => {
    const gs = readFileSync(new URL('../../scripts/gmail-service-leads.gs', import.meta.url), 'utf8')
    assert.match(gs, /service\\\.com\\\.au\$/)
  })
})

describe('issue 4: invite-user', () => {
  test('nobody can delete the master admin or themselves', () => {
    assert.ok(deleteBlocked(MASTER_ID, 'u-other'))
    assert.ok(deleteBlocked('u-5', 'u-5'))
    assert.equal(deleteBlocked('u-5', 'u-admin'), null)
  })

  test('links may only point at the portal’s own address', () => {
    const o = allowedOrigins('https://portal.nextphasemaintenance.com.au', 'http://localhost:5173, ftp://x.com, junk')
    assert.deepEqual(o, ['https://portal.nextphasemaintenance.com.au', 'http://localhost:5173'])
    assert.ok(isAppUrl('https://portal.nextphasemaintenance.com.au/', o))
    assert.ok(isAppUrl('https://portal.nextphasemaintenance.com.au/#/x', o))
    assert.ok(isAppUrl('http://localhost:5173/', o))
    assert.ok(!isAppUrl('https://evil.example/', o))
    assert.ok(!isAppUrl('https://portal.nextphasemaintenance.com.au.evil.example/', o))
    assert.ok(!isAppUrl('https://user:pw@portal.nextphasemaintenance.com.au/', o))
    assert.ok(!isAppUrl('http://portal.nextphasemaintenance.com.au/', o)) // wrong scheme, so a different origin
    assert.ok(!isAppUrl(undefined, o))
    assert.ok(!isAppUrl('javascript:alert(1)', o))
  })
})

describe('issue 6: send-sms claims before sending', () => {
  /** A fake table where update…eq…eq…select behaves like one atomic conditional update. */
  const fake = (rows: Record<string, Record<string, unknown>>) => ({
    from: () => ({
      update: (v: Record<string, unknown>) => ({
        eq: (c1: string, v1: unknown) => ({
          eq: (c2: string, v2: unknown) => ({
            select: async () => {
              const row = rows[String(v1)]
              if (c1 === 'id' && row && row[c2] === v2) {
                Object.assign(row, v)
                return { data: [{ id: v1 }], error: null }
              }
              return { data: [], error: null }
            },
          }),
        }),
      }),
    }),
  })

  test('of two simultaneous calls only one wins the claim; a failed send can be released', async () => {
    const rows = { r1: { sms_notified: false } }
    const db = fake(rows)
    const wins = await Promise.all([claimOnce(db, 'requests', 'r1', 'sms_notified'), claimOnce(db, 'requests', 'r1', 'sms_notified')])
    assert.deepEqual(wins.filter(Boolean).length, 1)
    assert.equal(await claimOnce(db, 'requests', 'r1', 'sms_notified'), false)
    await releaseClaim(db, 'requests', 'r1', 'sms_notified')
    assert.equal(rows.r1.sms_notified, false)
    assert.equal(await claimOnce(db, 'requests', 'r1', 'sms_notified'), true)
  })

  test('send-sms claims first for both kinds of text', () => {
    const src = readFileSync(new URL('../functions/send-sms/index.ts', import.meta.url), 'utf8')
    assert.match(src, /claimOnce\(db, 'requests', r\.id, 'sms_notified'\)/)
    assert.match(src, /claimOnce\(db, 'projects', p\.id, 'quote_sms_notified'\)/)
    assert.ok(src.indexOf("claimOnce(db, 'requests'") < src.indexOf("'New maintenance request')"))
  })
})

describe('issue 2: web address checks fail closed', () => {
  for (const [name, resolvesPublic] of [['supplier-stock/web.ts', resolvesPublicWeb], ['store-assistant/photo.ts', resolvesPublicPhoto]] as const) {
    test(`${name}: refuses when DNS is unavailable, finds nothing, or finds a private address`, async () => {
      // Under Node there is no Deno.resolveDns, so the default is "can't check" = refuse.
      assert.equal(await resolvesPublic('shop.example.com.au'), false)
      assert.equal(await resolvesPublic('x.example.com', async (_h, t) => (t === 'A' ? ['104.16.1.1'] : [])), true)
      assert.equal(await resolvesPublic('x.example.com', async () => []), false)
      assert.equal(await resolvesPublic('x.example.com', async (_h, t) => (t === 'A' ? ['104.16.1.1'] : ['fd00::1'])), false)
      assert.equal(await resolvesPublic('x.example.com', async (_h, t) => (t === 'A' ? ['10.0.0.5'] : [])), false)
    })
  }

  test('a second lookup after connecting is made (DNS rebinding)', () => {
    for (const f of ['supplier-stock/web.ts', 'store-assistant/photo.ts']) {
      const src = readFileSync(new URL(`../functions/${f}`, import.meta.url), 'utf8')
      const after = src.slice(src.indexOf("redirect: 'manual'"))
      assert.match(after, /resolvesPublic\(url\.hostname/, f)
    }
  })
})

describe('issue 5: open endpoints', () => {
  test('callers get a generic error, not the internal message', () => {
    assert.equal(SHARED_ERROR, GENERIC_ERROR)
    for (const f of ['service-leads/index.ts', 'quickbooks/index.ts', 'supplier-stock/index.ts', 'process-sms-outbox/index.ts']) {
      const src = readFileSync(new URL(`../functions/${f}`, import.meta.url), 'utf8')
      assert.ok(!/json\(\{ error: \(e as Error\)\.message/.test(src), f)
      assert.ok(!/Response\.json\(\{ error: error\.message/.test(src), f)
      assert.match(src, /GENERIC_ERROR/, f)
    }
  })

  test('the shared secret is optional, and checked when set', () => {
    const req = (h: Record<string, string> = {}) => new Request('https://x.test/', { method: 'POST', headers: h })
    assert.ok(cronAllowed(req(), undefined)) // not set: unchanged
    assert.ok(cronAllowed(req({ 'x-cron-secret': 's3cret' }), 's3cret'))
    assert.ok(!cronAllowed(req(), 's3cret'))
    assert.ok(!cronAllowed(req({ 'x-cron-secret': 'wrong!' }), 's3cret'))
  })

  test('the throttle lets one call through per interval', () => {
    let t = 1000
    const go = makeThrottle(10_000, () => t)
    assert.ok(go())
    t += 5_000
    assert.ok(!go())
    t += 5_001
    assert.ok(go())
  })

  test('run-style endpoints use the secret and the throttle', () => {
    for (const f of ['quickbooks/index.ts', 'process-sms-outbox/index.ts']) {
      const src = readFileSync(new URL(`../functions/${f}`, import.meta.url), 'utf8')
      assert.match(src, /cronAllowed\(req, Deno\.env\.get\('CRON_SECRET'\)\)/, f)
      assert.match(src, /makeThrottle\(/, f)
    }
    assert.match(readFileSync(new URL('../functions/supplier-stock/index.ts', import.meta.url), 'utf8'), /cronAllowed/)
  })
})

describe('issue 7: unused lead photos', () => {
  test('only day-old uploads that no request uses are stale', () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    const uploads = [
      { name: 'old-unused.jpg', created_at: '2026-11-08T12:00:00Z' },
      { name: 'old-used.jpg', created_at: '2026-11-08T12:00:00Z' },
      { name: 'new.jpg', created_at: '2026-11-10T11:00:00Z' },
      { name: 'nodate.jpg', created_at: null },
    ]
    assert.deepEqual(staleUploads(uploads, new Set(['incoming/old-used.jpg']), now), ['incoming/old-unused.jpg'])
  })
})

describe('issue 8: security headers', () => {
  const csp = readFileSync(new URL('../../netlify.toml', import.meta.url), 'utf8').match(/Content-Security-Policy = "([^"]+)"/)![1]
  const dir = (n: string) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${n} `))!
  test('images are not allowed from every https host', () => {
    const img = dir('img-src').split(' ')
    assert.ok(!img.includes('https:'))
    assert.ok(img.includes('https://*.supabase.co'))
  })
  test('scripts stay self-only with no inline', () => {
    assert.ok(!dir('script-src').includes("'unsafe-inline'"))
  })
})

describe('issue 9: CI workflow', () => {
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  test('token is read-only', () => assert.match(ci, /^permissions:\n {2}contents: read$/m))
  test('actions are pinned to commit SHAs', () => {
    const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
    assert.ok(uses.length >= 2)
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u)
  })
})

describe('issue 10: live builds need Supabase settings', () => {
  test('a build without them stops, unless it is a demo or explicitly allowed', () => {
    assert.match(missingSupabaseSettings({}, 'production')!, /VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set/)
    assert.match(missingSupabaseSettings({ VITE_SUPABASE_URL: 'https://x.supabase.co' }, 'production')!, /VITE_SUPABASE_ANON_KEY is not set/)
    assert.equal(missingSupabaseSettings({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'k' }, 'production'), null)
    assert.equal(missingSupabaseSettings({ VITE_DEMO: 'true' }, 'production'), null)
    assert.equal(missingSupabaseSettings({}, 'demo'), null)
    assert.equal(missingSupabaseSettings({}, 'single-file'), null)
    assert.equal(missingSupabaseSettings({ ALLOW_UNCONFIGURED_BUILD: 'true' }, 'production'), null)
  })
})
