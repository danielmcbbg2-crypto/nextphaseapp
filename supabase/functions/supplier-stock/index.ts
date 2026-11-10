// Supabase Edge Function: checks suppliers' product pages for stock.
//
//   { scheduled: true }  the 6-hourly job (pg_cron): checks every tracked product, oldest check
//       first, and records each reading with apply_supplier_stock (which switches listings and tells
//       store managers when something runs out or comes back). Needs no login (deployed with
//       verify_jwt off) because it runs at most once every 5 hours, whoever calls it.
//   { productId }  "Check now" from the product editor (store managers): checks one product.
//   { url }  reads a supplier page without saving anything (store managers), for a new listing.
//
// Pages are read for what they state (product data for search engines, shop data, plain wording).
// When a page doesn't say plainly and has changed since last time, Claude reads it (needs the
// ANTHROPIC_API_KEY secret; without it such pages stay "unknown").
import { createClient } from 'npm:@supabase/supabase-js@2.49.4'
import Anthropic from 'npm:@anthropic-ai/sdk@0.131.0'
import { findPrice, fingerprint, fromShopify, pageText, readStock, type Reading } from './stock.ts'
import { safeFetch } from './web.ts'
import { GENERIC_ERROR, cronAllowed } from '../_shared/guard.ts'

/** Whether the login has done its second sign-in step (its token, already checked by getUser, says "aal2"). Admin powers need it. */
function secondStep(jwt: string): boolean {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4))).aal === 'aal2'
  } catch {
    return false
  }
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// Small and quick: it only has to read one page's wording about stock.
const MODEL = 'claude-haiku-5-5'
const EVERY_MS = 5 * 3600_000
const PER_RUN = 60

const STOCK_TOOL = {
  name: 'report_stock',
  description: 'Report the stock of the main product on the page.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', enum: ['in_stock', 'low', 'out_of_stock', 'unknown'], description: 'low = the page says only a few are left' },
      qty: { type: ['integer', 'null'], description: 'How many are available, if the page says; otherwise null' },
      price: { type: ['number', 'null'], description: 'The price in AUD as shown, if any; otherwise null' },
      evidence: { type: 'string', description: 'The words on the page this is based on, quoted briefly' },
    },
    required: ['status', 'qty', 'price', 'evidence'],
  },
}

/** Claude reads the page's words when they don't say plainly. */
async function askClaude(text: string, url: string): Promise<Reading | null> {
  if (!Deno.env.get('ANTHROPIC_API_KEY')) return null
  // The parts that talk about stock or price, or the start of the page.
  const near = [...text.matchAll(/.{0,300}(?:stock|availab|sold out|in store|delivery|dispatch|\$\s?\d).{0,300}/gi)].map((m) => m[0]).join(' … ')
  const excerpt = (near || text).slice(0, 12000)
  const client = new Anthropic()
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      'You read Australian supplier product pages and report the stock of the page’s main product (not related or recommended products). Use only what the page says; if it doesn’t say, report unknown. Call report_stock once.',
    tools: [STOCK_TOOL],
    messages: [{ role: 'user', content: `Product page: ${url}\n\nPage text:\n${excerpt}` }],
  })
  const call = message.content.find((b) => b.type === 'tool_use' && b.name === STOCK_TOOL.name)
  if (!call || call.type !== 'tool_use') return null
  const r = call.input as { status: Reading['status']; qty: number | null; price: number | null; evidence: string }
  if (!['in_stock', 'low', 'out_of_stock', 'unknown'].includes(r.status)) return null
  return { status: r.status, qty: typeof r.qty === 'number' && r.qty >= 0 ? Math.round(r.qty) : null, price: typeof r.price === 'number' && r.price >= 0 ? r.price : null, note: r.evidence ? `read by AI: “${String(r.evidence).slice(0, 120)}”` : 'read by AI' }
}

/** What a supplier page says about stock now. `lastHash` skips the AI when the page hasn't changed. */
async function check(url: string, lastHash: string): Promise<Reading & { hash?: string }> {
  const signal = AbortSignal.timeout(20000)
  let page
  try {
    page = await safeFetch(url, signal, 'text/html', 2_000_000)
  } catch (e) {
    return { status: 'unknown', qty: null, price: null, note: `Couldn’t open the page (${(e as Error).message}).` }
  }
  if (!page.type.includes('html')) return { status: 'unknown', qty: null, price: null, note: 'The link isn’t a web page.' }
  const html = new TextDecoder().decode(page.bytes)
  const stated = readStock(html)
  // Shopify shops publish exact stock in their product data more often than on the page.
  if (/cdn\.shopify\.com|Shopify\.theme/i.test(html) && (!stated || stated.qty === null)) {
    try {
      const u = new URL(page.url)
      if (/\/products\/[^/]+/.test(u.pathname)) {
        const data = await safeFetch(`${u.origin}${u.pathname.replace(/\/$/, '')}.js`, signal, 'application/json', 1_000_000)
        const shop = fromShopify(JSON.parse(new TextDecoder().decode(data.bytes)))
        if (shop) return shop
      }
    } catch {
      /* use what the page says */
    }
  }
  const text = pageText(html)
  const hash = await fingerprint(text)
  if (stated) {
    if (stated.price !== null) return stated
    // Stock is plain but the price isn't in the stock data: look for it elsewhere on the page, then
    // (when the page has changed) ask Claude for it.
    const price = findPrice(html)
    if (price !== null) return { ...stated, price }
    if (hash === lastHash) return { ...stated, hash }
    try {
      const ai = await askClaude(text, page.url)
      return { ...stated, price: ai?.price ?? null, hash }
    } catch {
      return { ...stated, hash }
    }
  }
  if (hash === lastHash) return { status: 'unknown', qty: null, price: null, note: 'The page hasn’t changed and doesn’t say plainly.', hash }
  try {
    const ai = await askClaude(text, page.url)
    if (ai) return { ...ai, price: ai.price ?? findPrice(html), hash }
  } catch (e) {
    const status = e instanceof Anthropic.APIError ? ` (error ${e.status ?? 'network'})` : ''
    return { status: 'unknown', qty: null, price: null, note: `The AI couldn’t read the page${status}.` }
  }
  return { status: 'unknown', qty: null, price: null, note: 'The page doesn’t say whether it’s in stock.', hash }
}

type Source = { id: string; source_url: string; page_hash: string }

async function checkAndSave(s: Source): Promise<{ id: string; result: string; reading: Reading }> {
  const r = await check(s.source_url, s.page_hash)
  const { data, error } = await db.rpc('apply_supplier_stock', { p_product: s.id, p_status: r.status, p_qty: r.qty, p_price: r.price, p_note: r.note, p_hash: r.hash ?? null })
  if (error) throw new Error(error.message)
  return { id: s.id, result: String(data), reading: { status: r.status, qty: r.qty, price: r.price, note: r.note } }
}

/** A signed-in store manager, or null. */
async function manager(req: Request) {
  const jwt = req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
  if (!jwt) return null
  const { data: auth } = await db.auth.getUser(jwt)
  if (!auth.user) return null
  const { data: me } = await db.from('profiles').select('id, role, permissions').eq('auth_id', auth.user.id).eq('status', 'active').maybeSingle()
  return me && me.role === 'admin' && me.permissions.includes('canManageStore') && secondStep(jwt) ? me : null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const body = await req.json().catch(() => ({}))

  if (body.scheduled) {
    if (!cronAllowed(req, Deno.env.get('CRON_SECRET'))) return json({ error: 'Not allowed' }, 401)
    const { data: last } = await db.from('stock_check_runs').select('started_at').order('started_at', { ascending: false }).limit(1).maybeSingle()
    if (last && Date.now() - new Date(last.started_at).getTime() < EVERY_MS) return json({ skipped: 'checked recently' })
    const { data: run, error } = await db.from('stock_check_runs').insert({ trigger: 'scheduled' }).select('id').single()
    if (error) {
      console.error('supplier-stock failed:', error.message)
      return json({ error: GENERIC_ERROR }, 500)
    }
    const { data: sources, error: e1 } = await db
      .from('product_sources')
      .select('id, source_url, page_hash, stock_checked_at')
      .eq('track_stock', true)
      .order('stock_checked_at', { ascending: true, nullsFirst: true })
    const { data: archived, error: e2 } = await db.from('products').select('id').eq('status', 'archived')
    if (e1 || e2) {
      console.error('supplier-stock failed:', (e1 ?? e2)!.message)
      return json({ error: GENERIC_ERROR }, 500)
    }
    const skip = new Set((archived ?? []).map((p) => p.id as string))
    const list = ((sources ?? []) as Source[]).filter((s) => /^https?:\/\//.test(s.source_url) && !skip.has(s.id)).slice(0, PER_RUN)
    let changed = 0
    let failed = 0
    // A few at a time, to be gentle on suppliers' sites.
    for (let i = 0; i < list.length; i += 4) {
      const done = await Promise.allSettled(list.slice(i, i + 4).map(checkAndSave))
      for (const d of done) {
        if (d.status === 'rejected' || d.value.reading.status === 'unknown') failed++
        else if (d.value.result === 'changed') changed++
      }
    }
    await db.from('stock_check_runs').update({ checked: list.length, changed, failed }).eq('id', run.id)
    return json({ checked: list.length, changed, failed })
  }

  if (!(await manager(req))) return json({ error: 'You need the “Manage store & orders” permission' }, 403)

  if (body.productId) {
    const { data: s } = await db.from('product_sources').select('id, source_url, page_hash').eq('id', String(body.productId)).maybeSingle()
    if (!s?.source_url) return json({ error: 'This product has no supplier link to check.' }, 400)
    try {
      return json(await checkAndSave(s as Source))
    } catch (e) {
      console.error('supplier-stock check failed:', (e as Error).message)
      return json({ error: GENERIC_ERROR }, 500)
    }
  }

  const url = String(body.url ?? '')
  if (!/^https?:\/\/\S+$/.test(url)) return json({ error: 'Give the supplier’s product link.' }, 400)
  const r = await check(url, '')
  return json({ reading: { status: r.status, qty: r.qty, price: r.price, note: r.note } })
})
