// Supabase Edge Function: QuickBooks Online invoices for store orders.
//
//   POST { run: true }  does whatever is waiting, and nothing else: invoices for new orders (find or
//       create the customer, create the GST-inclusive invoice, have QuickBooks email it with its pay
//       link), retries of failed ones, voiding the invoices of cancelled orders (or flagging a refund
//       when one was paid), and now and then marking paid invoices' orders paid. It takes no input,
//       so it needs no login (deployed with verify_jwt off): the database wakes it when an order is
//       placed or cancelled, and every 15 minutes.
//   GET ?code&state&realmId  QuickBooks sending the office back after they approve the connection.
//   POST { action: 'connect' }  (store managers) the QuickBooks sign-in address to send them to.
//   POST { action: 'disconnect' }  (store managers) revokes the connection.
// It also keeps issued quotes as QuickBooks estimates (created or updated when a quote is issued,
// marked Accepted or Rejected when it's answered), and sends the deposit invoices of accepted quotes (queued by the database when a quote is
// accepted), records them in invoices, and marks them paid. When a quote is deleted, its estimate is
// deleted in QuickBooks and an unpaid deposit invoice voided (queued in qbo_cleanup).
//
// Secrets: QBO_CLIENT_ID and QBO_CLIENT_SECRET (from the app made at developer.intuit.com), and
// QBO_ENVIRONMENT=sandbox while testing with a sandbox company. The connection's tokens are kept in
// public.qbo_connection, which only the server can read, and are encrypted there (seal.ts) with a key
// only this function has (QBO_TOKEN_KEY, or one derived from QBO_CLIENT_SECRET).
// The connection is locked to one QuickBooks company: QBO_REALM_ID if set, otherwise the first one
// connected. Connecting another is refused, and every connect, disconnect and refused attempt is
// sent to all admins (inbox and text), so a stolen admin login can't quietly swap in someone else's
// company (and its pay links).
import { createClient } from 'npm:@supabase/supabase-js@2.49.4'
import { seal, tokenKey, unseal } from './seal.ts'
import { customerBody, depositBody, displayName, estimateBody, invoiceBody, invoiceTotal, qboError, qboErrorCode, quoted, type ItemRow, type OrderRow } from './invoice.ts'

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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const SANDBOX = Deno.env.get('QBO_ENVIRONMENT') === 'sandbox'
const API = Deno.env.get('QBO_API_URL') ?? (SANDBOX ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com')
const AUTH_URL = Deno.env.get('QBO_AUTH_URL') ?? 'https://appcenter.intuit.com/connect/oauth2'
const TOKEN_URL = Deno.env.get('QBO_TOKEN_URL') ?? 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const REVOKE_URL = Deno.env.get('QBO_REVOKE_URL') ?? 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
const REDIRECT_URI = Deno.env.get('QBO_REDIRECT_URI') ?? `${Deno.env.get('SUPABASE_URL')}/functions/v1/quickbooks`
const RETURN_URL = (Deno.env.get('QBO_RETURN_URL') ?? 'https://portal.nextphasemaintenance.com.au').replace(/\/+$/, '')
const CLIENT_ID = Deno.env.get('QBO_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('QBO_CLIENT_SECRET') ?? ''
const REALM_LOCK = (Deno.env.get('QBO_REALM_ID') ?? '').trim()
const basic = () => 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)

type Conn = {
  realm_id: string | null
  refresh_token: string | null
  access_token: string | null
  access_expires_at: string | null
  connected_at: string | null
  item_id: string | null
  tax_code_id: string | null
  last_paid_check: string | null
  deposit_item_id?: string | null
  estimate_item_id?: string | null
}

const TOKENS = ['refresh_token', 'access_token'] as const
let keyPromise: Promise<CryptoKey> | null = null
const key = () => (keyPromise ??= tokenKey(CLIENT_SECRET, Deno.env.get('QBO_TOKEN_KEY') ?? ''))

/** The connection, with its tokens unlocked. A token that can't be unlocked (the key changed) means connecting again. */
async function loadConn(): Promise<Conn | null> {
  const { data } = await db.from('qbo_connection').select('*').eq('id', 1).maybeSingle()
  const conn = (data as Conn | null) ?? null
  if (!conn?.refresh_token) return conn
  try {
    for (const f of TOKENS) if (conn[f]) conn[f] = await unseal(await key(), f, conn[f]!)
  } catch {
    conn.refresh_token = null
    conn.access_token = null
    await saveConn({ refresh_token: null, access_token: null, access_expires_at: null, last_error: 'The saved QuickBooks connection can’t be unlocked (its key has changed). Connect QuickBooks again.' })
  }
  return conn
}
/** Saves to the connection; its tokens are locked first. */
const saveConn = async (patch: Record<string, unknown>) => {
  const row: Record<string, unknown> = { id: 1, ...patch }
  for (const f of TOKENS) if (typeof row[f] === 'string') row[f] = await seal(await key(), f, row[f] as string)
  const { error } = await db.from('qbo_connection').upsert(row)
  if (error) throw new Error(`Couldn't save the QuickBooks connection (${error.message})`)
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body: body as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } }
}

/** A working access token: the saved one, or a fresh one (QuickBooks may hand back a new refresh token too). */
async function accessToken(conn: Conn): Promise<string> {
  if (conn.access_token && conn.access_expires_at && new Date(conn.access_expires_at).getTime() - 60_000 > Date.now()) return conn.access_token
  const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: conn.refresh_token ?? '' })
  if (!r.ok || !r.body.access_token) {
    if (r.body.error === 'invalid_grant') {
      // The connection has expired or been revoked in QuickBooks: it has to be connected again.
      conn.refresh_token = null
      conn.access_token = null
      await saveConn({ refresh_token: null, access_token: null, access_expires_at: null, last_error: 'The QuickBooks connection has expired or was removed. Connect QuickBooks again.' })
      throw new Error('The QuickBooks connection has expired or was removed. Connect QuickBooks again.')
    }
    throw new Error(qboError(r.body, r.status))
  }
  conn.access_token = r.body.access_token
  conn.access_expires_at = new Date(Date.now() + (r.body.expires_in ?? 3600) * 1000).toISOString()
  if (r.body.refresh_token) conn.refresh_token = r.body.refresh_token
  await saveConn({ access_token: conn.access_token, access_expires_at: conn.access_expires_at, refresh_token: conn.refresh_token })
  return conn.access_token
}

class QboError extends Error {
  constructor(message: string, public code: string) {
    super(message)
  }
}

async function qbo(conn: Conn, method: 'GET' | 'POST', path: string, body?: unknown, query: Record<string, string> = {}) {
  const token = await accessToken(conn)
  const url = new URL(`${API}/v3/company/${conn.realm_id}/${path}`)
  url.searchParams.set('minorversion', '75')
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': body === null ? 'application/octet-stream' : 'application/json' } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new QboError(qboError(out, res.status), qboErrorCode(out))
  return out
}
const query = async (conn: Conn, sql: string) => ((await qbo(conn, 'GET', 'query', undefined, { query: sql })) as { QueryResponse?: Record<string, Record<string, unknown>[]> }).QueryResponse ?? {}

/**
 * A transaction's number. A company that types its own numbers ("Custom transaction numbers" on in
 * QuickBooks) gets none from QuickBooks, so the portal gives it one of its own (WEB-5002, DEP-P203,
 * Q-P203) before the client sees it; otherwise QuickBooks' own number is kept.
 */
async function numbered(conn: Conn, kind: 'invoice' | 'estimate', obj: { Id: string; SyncToken: string; DocNumber?: string }, ours: string): Promise<string> {
  if (obj.DocNumber) return obj.DocNumber
  const out = (await qbo(conn, 'POST', kind, { Id: obj.Id, SyncToken: obj.SyncToken, sparse: true, DocNumber: ours.slice(0, 21) })) as Record<string, { DocNumber?: string }>
  return out[kind === 'invoice' ? 'Invoice' : 'Estimate']?.DocNumber || ours
}

/** The item store sales go against and the GST tax code: found (or the item made) once, then remembered. */
async function setup(conn: Conn) {
  if (!conn.item_id) {
    const found = (await query(conn, "select * from Item where Name = 'Online store sale'")).Item?.[0] as { Id: string } | undefined
    if (found) conn.item_id = found.Id
    else {
      const accounts = ((await query(conn, "select * from Account where AccountType = 'Income' and Active = true")).Account ?? []) as { Id: string; Name: string }[]
      const account = accounts.find((a) => /sales/i.test(a.Name)) ?? accounts[0]
      if (!account) throw new Error('QuickBooks has no income account to record store sales against. Add one in QuickBooks (Chart of accounts).')
      const made = (await qbo(conn, 'POST', 'item', { Name: 'Online store sale', Type: 'Service', IncomeAccountRef: { value: account.Id } })) as { Item: { Id: string } }
      conn.item_id = made.Item.Id
    }
  }
  if (conn.tax_code_id === null) {
    const codes = ((await query(conn, 'select * from TaxCode')).TaxCode ?? []) as { Id: string; Name: string; Active?: boolean }[]
    const gst = codes.find((c) => /^GST$/i.test(c.Name)) ?? codes.find((c) => /GST/i.test(c.Name) && !/free|export|input|non|exempt/i.test(c.Name))
    conn.tax_code_id = gst?.Id ?? ''
  }
  await saveConn({ item_id: conn.item_id, tax_code_id: conn.tax_code_id })
}

/** The item deposits go against ("Project deposit"), found or made once. */
async function depositItem(conn: Conn): Promise<string> {
  if (conn.deposit_item_id) return conn.deposit_item_id
  await setup(conn)
  const found = (await query(conn, "select * from Item where Name = 'Project deposit'")).Item?.[0] as { Id: string } | undefined
  let id = found?.Id
  if (!id) {
    const accounts = ((await query(conn, "select * from Account where AccountType = 'Income' and Active = true")).Account ?? []) as { Id: string; Name: string }[]
    const account = accounts.find((a) => /service|sales/i.test(a.Name)) ?? accounts[0]
    if (!account) throw new Error('QuickBooks has no income account to record deposits against. Add one in QuickBooks (Chart of accounts).')
    id = ((await qbo(conn, 'POST', 'item', { Name: 'Project deposit', Type: 'Service', IncomeAccountRef: { value: account.Id } })) as { Item: { Id: string } }).Item.Id
  }
  conn.deposit_item_id = id
  await saveConn({ deposit_item_id: id })
  return id
}

/** The item quoted work goes against on estimates ("Quoted work"), found or made once. */
async function estimateItem(conn: Conn): Promise<string> {
  if (conn.estimate_item_id) return conn.estimate_item_id
  await setup(conn)
  const found = (await query(conn, "select * from Item where Name = 'Quoted work'")).Item?.[0] as { Id: string } | undefined
  let id = found?.Id
  if (!id) {
    const accounts = ((await query(conn, "select * from Account where AccountType = 'Income' and Active = true")).Account ?? []) as { Id: string; Name: string }[]
    const account = accounts.find((a) => /service|sales/i.test(a.Name)) ?? accounts[0]
    if (!account) throw new Error('QuickBooks has no income account for estimates. Add one in QuickBooks (Chart of accounts).')
    id = ((await qbo(conn, 'POST', 'item', { Name: 'Quoted work', Type: 'Service', IncomeAccountRef: { value: account.Id } })) as { Item: { Id: string } }).Item.Id
  }
  conn.estimate_item_id = id
  await saveConn({ estimate_item_id: id })
  return id
}

/**
 * A quote's client for QuickBooks. A quote made from a store order whose client has no email (the
 * customer checked out signed out with an email that's already a portal login, which is never copied
 * to another account) uses the email typed on that order, the one its store invoice went to.
 */
async function quoteClient(projectId: string, clientId: string): Promise<{ name: string; email: string | null; phone: string | null } | null> {
  const { data: client } = await db.from('profiles').select('name, email, phone').eq('id', clientId).maybeSingle()
  if (!client || client.email?.trim()) return client
  const { data: p } = await db.from('projects').select('order_id').eq('id', projectId).maybeSingle()
  if (!p?.order_id) return client
  const { data: o } = await db.from('orders').select('email').eq('id', p.order_id).maybeSingle()
  return o?.email?.trim() ? { ...client, email: o.email } : client
}

type EstimateRow = {
  id: string; number: number; title: string; status: string; client_id: string; qbo_estimate_id: string | null; estimate_attempts: number
  quote_amount: number | string | null; quote_valid_until: string | null; quote_inclusions: string; quote_exclusions: string
  quote_answered_name: string; quote_decided_at: string | null; quote_issued_at: string | null
}

/** Creates or updates a quote's estimate, and marks it Accepted or Rejected once answered. */
async function syncEstimate(conn: Conn, q: EstimateRow) {
  const client = await quoteClient(q.id, q.client_id)
  if (!client?.email?.trim()) throw new Error('The client has no email address, which QuickBooks needs to find or add them. Add it to their account, then try again.')
  const customerId = await customerFor(conn, { id: q.id, number: q.number, name: client.name, email: client.email, phone: client.phone ?? '', delivery: 'pickup', address: '', total: 0 })
  const { data: items } = await db.from('project_quote_items').select('section, description, qty, unit, rate').eq('project_id', q.id).order('position')
  const itemId = await estimateItem(conn)
  const today = (q.quote_issued_at ? new Date(q.quote_issued_at) : new Date()).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' })
  const body = estimateBody(q, items ?? [], customerId, itemId, conn.tax_code_id ?? '', today)
  const answer =
    q.status === 'rejected'
      ? { TxnStatus: 'Rejected' }
      : ['approved', 'in_progress', 'completed'].includes(q.status)
        ? { TxnStatus: 'Accepted', ...(q.quote_answered_name ? { AcceptedBy: q.quote_answered_name.slice(0, 100) } : {}), ...(q.quote_decided_at ? { AcceptedDate: q.quote_decided_at.slice(0, 10) } : {}) }
        : { TxnStatus: 'Pending' }
  let est: { Id: string; SyncToken: string; DocNumber?: string }
  if (!q.qbo_estimate_id) {
    est = ((await qbo(conn, 'POST', 'estimate', { ...body, ...answer }, { requestid: `estimate-${q.id}` })) as { Estimate: typeof est }).Estimate
  } else {
    const now = ((await qbo(conn, 'GET', `estimate/${q.qbo_estimate_id}`)) as { Estimate: typeof est }).Estimate
    // Issued (again): the lines as they are now; answered: just its status.
    const patch = q.status === 'quoted' ? { ...body, ...answer, Id: now.Id, SyncToken: now.SyncToken } : { ...answer, Id: now.Id, SyncToken: now.SyncToken, sparse: true }
    est = ((await qbo(conn, 'POST', 'estimate', patch)) as { Estimate: typeof est }).Estimate
  }
  const number = await numbered(conn, 'estimate', est, `Q-P${q.number}`)
  await db.from('projects').update({ qbo_estimate_id: est.Id, estimate_number: number, estimate_status: 'synced', estimate_error: '' }).eq('id', q.id)
}

async function failEstimate(q: EstimateRow, message: string) {
  const attempts = q.estimate_attempts + 1
  await db
    .from('projects')
    .update({ estimate_status: 'failed', estimate_error: message.slice(0, 400), estimate_attempts: attempts, estimate_next_try: new Date(Date.now() + attempts * 15 * 60_000).toISOString() })
    .eq('id', q.id)
}

type DepositRow = { id: string; number: number; title: string; client_id: string; property_id: string | null; deposit_amount: number | string; deposit_attempts: number; first_stage: string | null }

const melbourneToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date())

/** An accepted quote's deposit invoice: made in QuickBooks, emailed with its pay link, and recorded. */
async function depositInvoice(conn: Conn, q: DepositRow) {
  const client = await quoteClient(q.id, q.client_id)
  if (!client?.email?.trim()) throw new Error('The client has no email address for the deposit invoice. Add it to their account, then send the deposit invoice.')
  const { data: place } = q.property_id ? await db.from('properties').select('address, suburb, postcode').eq('id', q.property_id).maybeSingle() : { data: null }
  const address = place ? [place.address, place.suburb, place.postcode].filter(Boolean).join(', ') : ''
  const itemId = await depositItem(conn)
  const customerId = await customerFor(conn, { id: q.id, number: q.number, name: client.name, email: client.email, phone: client.phone ?? '', delivery: address ? 'delivery' : 'pickup', address, total: q.deposit_amount })
  const amount = Number(q.deposit_amount)
  const made = (await qbo(conn, 'POST', 'invoice', depositBody(q, amount, client.email, customerId, itemId, conn.tax_code_id ?? '', melbourneToday()), { requestid: `deposit-${q.id}` })) as { Invoice: { Id: string } }
  const invoiceId = made.Invoice.Id
  const inv = ((await qbo(conn, 'GET', `invoice/${invoiceId}`, undefined, { include: 'invoiceLink' })) as { Invoice: { Id: string; SyncToken: string; DocNumber?: string; InvoiceLink?: string; DueDate?: string } }).Invoice
  const docNumber = await numbered(conn, 'invoice', inv, `DEP-P${q.number}`)
  await qbo(conn, 'POST', `invoice/${invoiceId}/send`, null, { sendTo: client.email.trim() })
  // Recorded with the project's invoices (once, even if this runs again), and against the first payment stage.
  let { data: rec } = await db.from('invoices').select('id').eq('qbo_invoice_id', invoiceId).maybeSingle()
  if (!rec) {
    const { data, error } = await db
      .from('invoices')
      .insert({ project_id: q.id, client_id: q.client_id, qb_invoice_number: docNumber, amount, status: 'sent', due_date: inv.DueDate ?? melbourneToday(), qbo_invoice_id: invoiceId, pay_link: inv.InvoiceLink ?? '' })
      .select('id')
      .single()
    if (error) throw new Error(`The deposit invoice was sent but couldn't be recorded (${error.message}).`)
    rec = data
  }
  if (q.first_stage) await db.from('project_payments').update({ invoice_id: rec.id }).eq('id', q.first_stage).is('invoice_id', null)
  await db.from('projects').update({ deposit_status: 'sent', deposit_invoice_id: rec.id, deposit_error: '' }).eq('id', q.id)
}

async function failDeposit(q: DepositRow, message: string) {
  const attempts = q.deposit_attempts + 1
  await db
    .from('projects')
    .update({ deposit_status: 'failed', deposit_error: message.slice(0, 400), deposit_attempts: attempts, deposit_next_try: new Date(Date.now() + attempts * 15 * 60_000).toISOString() })
    .eq('id', q.id)
  if (attempts === 1 || attempts === 3) {
    const { data: admins } = await db.from('profiles').select('id, permissions').eq('role', 'admin').eq('status', 'active')
    const to = (admins ?? []).filter((a) => (a.permissions as string[]).includes('canManageProjects'))
    if (to.length) await db.from('inbox').insert(to.map((a) => ({ user_id: a.id, project_id: q.id, title: `Deposit invoice failed: quote P-${q.number}`, body: `${message}\n\nIt's tried again automatically; you can also send it from the quote's Payments tab.`.slice(0, 2000) })))
  }
}

async function customerFor(conn: Conn, o: OrderRow): Promise<string> {
  const byEmail = (await query(conn, `select * from Customer where PrimaryEmailAddr = ${quoted(o.email.trim())}`)).Customer?.[0] as { Id: string } | undefined
  if (byEmail) return byEmail.Id
  try {
    return ((await qbo(conn, 'POST', 'customer', customerBody(o))) as { Customer: { Id: string } }).Customer.Id
  } catch (e) {
    // Someone with the same name and email already there (but not matched by email): use them.
    if (e instanceof QboError && e.code === '6240') {
      const byName = (await query(conn, `select * from Customer where DisplayName = ${quoted(displayName(o))}`)).Customer?.[0] as { Id: string } | undefined
      if (byName) return byName.Id
    }
    throw e
  }
}

async function adminsNote(title: string, body: string) {
  const { data: admins } = await db.from('profiles').select('id, permissions').eq('role', 'admin').eq('status', 'active')
  const to = (admins ?? []).filter((a) => (a.permissions as string[]).includes('canManageStore'))
  if (to.length) await db.from('inbox').insert(to.map((a) => ({ user_id: a.id, title: title.slice(0, 200), body: body.slice(0, 2000) })))
}

/**
 * A change to the QuickBooks connection, to every active admin: an inbox message, and a text to
 * the office alert numbers and admins' mobiles (sent by process-sms-outbox).
 */
async function securityAlert(title: string, body: string) {
  const { data: admins } = await db.from('profiles').select('id, phone').eq('role', 'admin').eq('status', 'active')
  if (admins?.length) await db.from('inbox').insert(admins.map((a) => ({ user_id: a.id, title: title.slice(0, 200), body: body.slice(0, 2000) })))
  const { data: settings } = await db.from('settings').select('sms').eq('id', 1).maybeSingle()
  const phones = new Map<string, string>()
  for (const p of [...(((settings?.sms as { recipients?: string[] } | null)?.recipients) ?? []), ...(admins ?? []).map((a) => a.phone as string)]) {
    const digits = (p ?? '').replace(/\D/g, '')
    if (digits.length >= 8 && !phones.has(digits.slice(-9))) phones.set(digits.slice(-9), p.trim())
  }
  if (phones.size) {
    const message = `Next Phase portal: ${title}. ${body}`.slice(0, 480)
    const { error } = await db.from('sms_outbox').insert([...phones.values()].map((to_phone) => ({ to_phone, message, event: 'QuickBooks connection', source: 'security' })))
    if (error) console.error('quickbooks alert text not queued:', error.message)
  }
}

const personName = async (id: string | null) =>
  id ? (((await db.from('profiles').select('name').eq('id', id).maybeSingle()).data?.name as string | undefined) ?? 'an admin') : 'an admin'

/** Creates the order's invoice in QuickBooks and has QuickBooks email it. */
async function invoiceOrder(conn: Conn, o: OrderRow & { qbo_invoice_id: string | null; invoice_attempts: number }) {
  const { data: items, error } = await db.from('order_items').select('title, sku, unit_price, qty, options').eq('order_id', o.id).order('seq')
  if (error) throw new Error(error.message)
  await setup(conn)
  let invoiceId = o.qbo_invoice_id
  if (!invoiceId) {
    const customerId = await customerFor(conn, o)
    // requestid makes creating it safe to repeat: QuickBooks returns the same invoice for the same id.
    const made = (await qbo(conn, 'POST', 'invoice', invoiceBody(o, (items ?? []) as ItemRow[], customerId, conn.item_id!, conn.tax_code_id ?? ''), { requestid: `order-${o.id}` })) as { Invoice: { Id: string } }
    invoiceId = made.Invoice.Id
    await db.from('orders').update({ qbo_invoice_id: invoiceId }).eq('id', o.id)
  }
  const inv = ((await qbo(conn, 'GET', `invoice/${invoiceId}`, undefined, { include: 'invoiceLink' })) as { Invoice: { Id: string; SyncToken: string; DocNumber?: string; InvoiceLink?: string; TotalAmt?: number } }).Invoice
  const docNumber = await numbered(conn, 'invoice', inv, `WEB-${o.number}`)
  await qbo(conn, 'POST', `invoice/${invoiceId}/send`, null, { sendTo: o.email.trim() })
  // Items plus any confirmed delivery cost (on the invoice as a line of its own).
  const total = invoiceTotal(o)
  const differs = inv.TotalAmt !== undefined && Math.abs(inv.TotalAmt - total) > 0.02
  await db
    .from('orders')
    .update({
      invoice_status: 'sent',
      invoice_number: docNumber,
      pay_link: inv.InvoiceLink ?? '',
      invoice_error: differs ? `The QuickBooks invoice comes to $${inv.TotalAmt!.toFixed(2)} but the order to $${total.toFixed(2)}: check its GST.` : '',
      invoiced_at: new Date().toISOString(),
    })
    .eq('id', o.id)
}

async function failOrder(o: { id: string; number: number; invoice_attempts: number }, message: string) {
  const attempts = o.invoice_attempts + 1
  await db
    .from('orders')
    .update({ invoice_status: 'failed', invoice_error: message.slice(0, 400), invoice_attempts: attempts, invoice_next_try: new Date(Date.now() + attempts * 15 * 60_000).toISOString() })
    .eq('id', o.id)
  if (attempts === 3) await adminsNote(`QuickBooks invoice failed: order #${o.number}`, `${message}\n\nIt's tried again automatically; you can also retry it from the order in Admin → Store → Orders.`)
}

/** Voids the invoices of cancelled orders (or flags a refund when the customer had paid). */
async function voidCancelled(conn: Conn) {
  await db.from('orders').update({ invoice_status: 'skipped' }).eq('status', 'cancelled').in('invoice_status', ['pending', 'failed'])
  const { data } = await db.from('orders').select('id, number, qbo_invoice_id').eq('status', 'cancelled').eq('invoice_status', 'sent').not('qbo_invoice_id', 'is', null).limit(20)
  for (const o of data ?? []) {
    try {
      const inv = ((await qbo(conn, 'GET', `invoice/${o.qbo_invoice_id}`)) as { Invoice: { Id: string; SyncToken: string; Balance: number; TotalAmt: number } }).Invoice
      if (inv.Balance < inv.TotalAmt) {
        await db.from('orders').update({ invoice_status: 'refund_needed' }).eq('id', o.id)
        await adminsNote(`Refund needed: order #${o.number}`, `Order #${o.number} was cancelled but its QuickBooks invoice has been paid ($${(inv.TotalAmt - inv.Balance).toFixed(2)}). Refund the customer, then record the refund in QuickBooks.`)
      } else {
        await qbo(conn, 'POST', 'invoice', { Id: inv.Id, SyncToken: inv.SyncToken }, { operation: 'void' })
        await db.from('orders').update({ invoice_status: 'voided', invoice_error: '' }).eq('id', o.id)
      }
    } catch (e) {
      await db.from('orders').update({ invoice_error: `Couldn't void the invoice: ${(e as Error).message}`.slice(0, 400) }).eq('id', o.id)
    }
  }
}

type CleanupRow = { id: number; kind: 'estimate' | 'invoice'; qbo_id: string; realm_id: string; label: string; attempts: number }

/**
 * What deleted quotes left in QuickBooks: estimates are deleted; invoices are voided (a sent tax
 * invoice stays on record as void), unless something has been paid on them, which is left for the
 * office to refund. Only ever in the company the quote was made in.
 */
async function cleanUp(conn: Conn) {
  for (let round = 0; round < 5; round++) {
    const { data: claimed, error } = await db.rpc('claim_qbo_cleanup', { max_rows: 10 })
    if (error) throw new Error(error.message)
    if (!claimed?.length) return
    for (const c of claimed as CleanupRow[]) {
      const done = (status: 'done' | 'kept', note = '') => db.from('qbo_cleanup').update({ status, error: note.slice(0, 400) }).eq('id', c.id)
      try {
        if (c.realm_id !== conn.realm_id) {
          await done('kept', 'Made in a different QuickBooks company from the one connected now, so it was left alone.')
          continue
        }
        const kind = c.kind === 'estimate' ? 'Estimate' : 'Invoice'
        let found: { Id: string; SyncToken: string; Balance?: number; TotalAmt?: number }
        try {
          found = ((await qbo(conn, 'GET', `${c.kind}/${c.qbo_id}`)) as Record<string, typeof found>)[kind]
        } catch (e) {
          // Already deleted in QuickBooks: nothing to do.
          if (e instanceof QboError && e.code === '610') {
            await done('done', 'It was already gone from QuickBooks.')
            continue
          }
          throw e
        }
        if (c.kind === 'estimate') {
          await qbo(conn, 'POST', 'estimate', { Id: found.Id, SyncToken: found.SyncToken }, { operation: 'delete' })
          await done('done')
        } else if ((found.Balance ?? 0) < (found.TotalAmt ?? 0)) {
          await done('kept', 'Something has been paid on it, so it was left for you to refund.')
          await adminsNote(`Refund needed: ${c.label}`, `${c.label} was deleted, but its QuickBooks invoice has payments on it ($${((found.TotalAmt ?? 0) - (found.Balance ?? 0)).toFixed(2)}). Refund the client, then void it in QuickBooks.`)
        } else {
          if ((found.TotalAmt ?? 0) > 0) await qbo(conn, 'POST', 'invoice', { Id: found.Id, SyncToken: found.SyncToken }, { operation: 'void' })
          await done('done')
        }
      } catch (e) {
        const attempts = c.attempts + 1
        const message = (e as Error).message
        await db
          .from('qbo_cleanup')
          .update({ status: 'failed', error: message.slice(0, 400), attempts, next_try: new Date(Date.now() + attempts * 15 * 60_000).toISOString() })
          .eq('id', c.id)
        if (attempts === 6) await adminsNote(`QuickBooks clean-up failed: ${c.label}`, `The ${c.kind} (QuickBooks ID ${c.qbo_id}) of a deleted quote couldn't be ${c.kind === 'estimate' ? 'deleted' : 'voided'} in QuickBooks: ${message}\n\nPlease ${c.kind === 'estimate' ? 'delete' : 'void'} it in QuickBooks yourself.`)
        if (!conn.refresh_token) return
      }
    }
  }
}

/** Marks orders paid once their invoice is paid in QuickBooks (at most every 25 minutes). */
async function checkPaid(conn: Conn, force = false) {
  if (!force && conn.last_paid_check && Date.now() - new Date(conn.last_paid_check).getTime() < 25 * 60_000) return
  await saveConn({ last_paid_check: new Date().toISOString() })
  const { data } = await db
    .from('orders')
    .select('id, number, status, qbo_invoice_id, invoice_number')
    .eq('invoice_status', 'sent')
    .neq('status', 'cancelled')
    .not('qbo_invoice_id', 'is', null)
    .gte('created_at', new Date(Date.now() - 180 * 86_400_000).toISOString())
    .limit(300)
  const open = data ?? []
  for (let i = 0; i < open.length; i += 30) {
    const batch = open.slice(i, i + 30)
    const found = ((await query(conn, `select Id, Balance, TotalAmt from Invoice where Id in (${batch.map((o) => quoted(o.qbo_invoice_id!)).join(', ')})`)).Invoice ?? []) as { Id: string; Balance: number; TotalAmt: number }[]
    for (const inv of found) {
      if (!(inv.TotalAmt > 0 && inv.Balance === 0)) continue
      const o = batch.find((x) => x.qbo_invoice_id === inv.Id)!
      await db.from('orders').update({ invoice_status: 'paid', ...(o.status === 'new' || o.status === 'confirmed' ? { status: 'paid' } : {}) }).eq('id', o.id)
      await adminsNote(`Order #${o.number} paid`, `QuickBooks invoice ${o.invoice_number || inv.Id} for order #${o.number} has been paid.`)
    }
  }
  // Deposit invoices (and any others QuickBooks made for projects).
  const { data: sent } = await db.from('invoices').select('id, project_id, qb_invoice_number, qbo_invoice_id').eq('status', 'sent').not('qbo_invoice_id', 'is', null).limit(300)
  const list = sent ?? []
  for (let i = 0; i < list.length; i += 30) {
    const batch = list.slice(i, i + 30)
    const found = ((await query(conn, `select Id, Balance, TotalAmt from Invoice where Id in (${batch.map((r) => quoted(r.qbo_invoice_id!)).join(', ')})`)).Invoice ?? []) as { Id: string; Balance: number; TotalAmt: number }[]
    for (const inv of found) {
      if (!(inv.TotalAmt > 0 && inv.Balance === 0)) continue
      const r = batch.find((x) => x.qbo_invoice_id === inv.Id)!
      await db.from('invoices').update({ status: 'paid', paid_date: melbourneToday() }).eq('id', r.id)
      const { data: p } = r.project_id ? await db.from('projects').update({ deposit_status: 'paid' }).eq('deposit_invoice_id', r.id).select('number, title') : { data: null }
      const { data: admins } = await db.from('profiles').select('id, permissions').eq('role', 'admin').eq('status', 'active')
      const to = (admins ?? []).filter((a) => (a.permissions as string[]).includes('canManageProjects') || (a.permissions as string[]).includes('canManageInvoices'))
      const what = p?.[0] ? `the deposit for quote P-${p[0].number} (${p[0].title})` : `invoice ${r.qb_invoice_number}`
      if (to.length) await db.from('inbox').insert(to.map((a) => ({ user_id: a.id, project_id: r.project_id, title: p?.[0] ? `Deposit paid: P-${p[0].number}` : `Invoice ${r.qb_invoice_number} paid`, body: `QuickBooks invoice ${r.qb_invoice_number}, ${what}, has been paid.` })))
    }
  }
}

/** Everything that's waiting. One run at a time; keeps going while new orders arrive. */
async function run() {
  const conn = await loadConn()
  if (!conn?.refresh_token || !conn.realm_id) return { skipped: 'QuickBooks isn’t connected' }
  if (!CLIENT_ID || !CLIENT_SECRET) return { skipped: 'QBO_CLIENT_ID / QBO_CLIENT_SECRET aren’t set' }
  const now = new Date()
  const { data: locked } = await db
    .from('qbo_connection')
    .update({ run_lock_until: new Date(now.getTime() + 3 * 60_000).toISOString() })
    .eq('id', 1)
    .or(`run_lock_until.is.null,run_lock_until.lt.${now.toISOString()}`)
    .select('id')
  if (!locked?.length) return { skipped: 'already running' }
  // Time budget well inside the 3-minute lock: once it's used, no new batch is claimed (the batch in
  // hand is finished) and the tidy-up steps wait for the next run, so the lock can't lapse while
  // this run is still working and let a second run start alongside it.
  const deadline = now.getTime() + 2 * 60_000
  const outOfTime = () => Date.now() > deadline
  let invoiced = 0
  let failed = 0
  try {
    // Orders from before QuickBooks was connected aren't invoiced by it.
    if (conn.connected_at) await db.from('orders').update({ invoice_status: 'skipped' }).eq('invoice_status', 'pending').lt('created_at', conn.connected_at)
    // Estimates first (a quote's estimate before its deposit invoice); not for ones queued before QuickBooks was connected
    // (a retry after connecting is queued afresh, so it goes ahead).
    if (conn.connected_at) await db.from('projects').update({ estimate_status: 'skipped' }).eq('estimate_status', 'pending').is('qbo_estimate_id', null).lt('estimate_next_try', conn.connected_at)
    for (let round = 0; round < 10 && !outOfTime(); round++) {
      const { data: claimed, error } = await db.rpc('claim_quote_estimates', { max_rows: 5 })
      if (error) throw new Error(error.message)
      if (!claimed?.length) break
      for (const q of claimed as EstimateRow[]) {
        try {
          await syncEstimate(conn, q)
        } catch (e) {
          await failEstimate(q, (e as Error).message)
          if (!conn.refresh_token) return { invoiced, failed, stopped: 'connection expired' }
        }
      }
    }
    // Deposits queued before QuickBooks was connected aren't sent by it (one sent again after connecting is).
    if (conn.connected_at) await db.from('projects').update({ deposit_status: 'skipped' }).eq('deposit_status', 'pending').lt('deposit_next_try', conn.connected_at)
    for (let round = 0; round < 10 && !outOfTime(); round++) {
      const { data: claimed, error } = await db.rpc('claim_deposit_invoices', { max_rows: 5 })
      if (error) throw new Error(error.message)
      if (!claimed?.length) break
      for (const q of claimed as DepositRow[]) {
        try {
          await depositInvoice(conn, q)
          invoiced++
        } catch (e) {
          failed++
          await failDeposit(q, (e as Error).message)
          if (!conn.refresh_token) return { invoiced, failed, stopped: 'connection expired' }
        }
      }
    }
    for (let round = 0; round < 10 && !outOfTime(); round++) {
      const { data: claimed, error } = await db.rpc('claim_order_invoices', { max_rows: 5 })
      if (error) throw new Error(error.message)
      if (!claimed?.length) break
      for (const o of claimed) {
        try {
          await invoiceOrder(conn, o)
          invoiced++
        } catch (e) {
          failed++
          await failOrder(o, (e as Error).message)
          if (!conn.refresh_token) return { invoiced, failed, stopped: 'connection expired' }
        }
      }
    }
    if (outOfTime()) {
      await saveConn({ last_error: '' })
      return { invoiced, failed, stopped: 'time budget used; the rest waits for the next run' }
    }
    await voidCancelled(conn)
    if (!outOfTime()) await cleanUp(conn)
    if (!outOfTime()) await checkPaid(conn)
    await saveConn({ last_error: '' })
    return { invoiced, failed }
  } catch (e) {
    await saveConn({ last_error: (e as Error).message.slice(0, 400) }).catch(() => {})
    throw e
  } finally {
    await saveConn({ run_lock_until: null }).catch(() => {})
  }
}

/**
 * A signed-in store manager, or why not: the sign-in has expired (or was signed out elsewhere), the
 * second sign-in step hasn't been done, or the login lacks the permission.
 */
async function manager(req: Request): Promise<{ id: string } | { why: string; status: number }> {
  const expired = { why: 'Your sign-in has expired. Sign out, sign in again (with your two-step code), then try again.', status: 401 }
  const jwt = req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
  if (!jwt) return expired
  const { data: auth } = await db.auth.getUser(jwt)
  if (!auth.user) return expired
  const { data: me } = await db.from('profiles').select('id, role, permissions').eq('auth_id', auth.user.id).eq('status', 'active').maybeSingle()
  if (!me || me.role !== 'admin' || !(me.permissions.includes('canManageStore') || me.permissions.includes('canManageInvoices'))) return { why: 'You need the “Manage store & orders” permission', status: 403 }
  if (!secondStep(jwt)) return { why: 'Finish signing in with your two-step code, then try again.', status: 403 }
  return me
}

const back = (outcome: string) => Response.redirect(`${RETURN_URL}/#/admin/store?quickbooks=${encodeURIComponent(outcome)}`, 302)

/** QuickBooks sends the office back here once they've approved (or declined) the connection. */
async function callback(url: URL) {
  if (url.searchParams.get('error')) return back(url.searchParams.get('error') === 'access_denied' ? 'declined' : 'error')
  const code = url.searchParams.get('code') ?? ''
  const state = url.searchParams.get('state') ?? ''
  const realm = url.searchParams.get('realmId') ?? ''
  const { data: c } = await db.from('qbo_connection').select('oauth_state, oauth_state_at, oauth_by, pinned_realm_id').eq('id', 1).maybeSingle()
  const fresh = c?.oauth_state_at && Date.now() - new Date(c.oauth_state_at).getTime() < 15 * 60_000
  if (!code || !realm || !state || !c?.oauth_state || c.oauth_state !== state || !fresh) return back('expired')
  await saveConn({ oauth_state: null, oauth_state_at: null })
  // Only our own QuickBooks company. (The code isn't exchanged, so nothing of the other company is touched.)
  const allowed = REALM_LOCK || c.pinned_realm_id
  if (allowed && realm !== allowed) {
    await securityAlert(
      'QuickBooks: another company was refused',
      `${await personName(c.oauth_by)} tried to connect a different QuickBooks company (ID ${realm}) to the store. It was refused; the store stays with your own company. If this wasn't you or your team, change that admin's password straight away.`,
    )
    return back('wrong_company')
  }
  const r = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
  if (!r.ok || !r.body.access_token || !r.body.refresh_token) {
    console.error('quickbooks connect failed:', JSON.stringify(r.body).slice(0, 300))
    return back('error')
  }
  const conn: Conn = {
    realm_id: realm,
    refresh_token: r.body.refresh_token,
    access_token: r.body.access_token,
    access_expires_at: new Date(Date.now() + (r.body.expires_in ?? 3600) * 1000).toISOString(),
    connected_at: new Date().toISOString(),
    item_id: null,
    tax_code_id: null,
    last_paid_check: null,
    deposit_item_id: null,
    estimate_item_id: null,
  }
  let company = ''
  try {
    company = ((await qbo(conn, 'GET', `companyinfo/${realm}`)) as { CompanyInfo?: { CompanyName?: string } }).CompanyInfo?.CompanyName ?? ''
  } catch {
    /* the name is only for show */
  }
  // A new connection (perhaps to another company) starts afresh.
  await saveConn({ ...conn, company_name: company, connected_by: c.oauth_by, last_error: '', run_lock_until: null, pinned_realm_id: c.pinned_realm_id ?? realm })
  await securityAlert(
    'QuickBooks connected',
    `${await personName(c.oauth_by)} connected the store to QuickBooks${company ? ` (${company})` : ''}. New store orders are now invoiced there. If this wasn't you or your team, disconnect it in Admin → Store → Orders and change your passwords.`,
  )
  return back('connected')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)
  if (req.method === 'GET') {
    if (url.searchParams.has('code') || url.searchParams.has('error')) return callback(url)
    return json({ error: 'Not found' }, 404)
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const body = await req.json().catch(() => ({}))

  if (body.run) {
    try {
      return json(await run())
    } catch (e) {
      console.error('quickbooks run failed:', (e as Error).message)
      return json({ error: (e as Error).message }, 500)
    }
  }

  const me = await manager(req)
  if ('why' in me) return json({ error: me.why }, me.status)

  if (body.action === 'connect') {
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: 'QuickBooks isn’t set up yet: add QBO_CLIENT_ID and QBO_CLIENT_SECRET to the Supabase secrets (see the README).', code: 'not_configured' }, 503)
    const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
    await saveConn({ oauth_state: state, oauth_state_at: new Date().toISOString(), oauth_by: me.id })
    const u = new URL(AUTH_URL)
    u.search = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: REDIRECT_URI, state }).toString()
    return json({ url: u.toString() })
  }

  if (body.action === 'disconnect') {
    const conn = await loadConn()
    if (conn?.refresh_token) {
      await fetch(REVOKE_URL, { method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ token: conn.refresh_token }) }).catch(() => {})
    }
    await saveConn({ realm_id: null, refresh_token: null, access_token: null, access_expires_at: null, company_name: '', connected_at: null, connected_by: null, item_id: null, tax_code_id: null, deposit_item_id: null, estimate_item_id: null, last_error: '' })
    await securityAlert('QuickBooks disconnected', `${await personName(me.id)} disconnected the store from QuickBooks. New orders won't be invoiced until it's connected again.`)
    return json({ disconnected: true })
  }

  return json({ error: 'Unknown action' }, 400)
})
