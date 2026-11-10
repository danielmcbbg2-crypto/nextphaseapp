// Supabase Edge Function: sends texts queued in public.sms_outbox.
//
// Called by a database trigger whenever a row is queued (and by a 5-minute retry job). It takes no
// input and only sends what's already queued (admins' texts, the website enquiry auto-reply, booking
// reminders), so it needs no caller authentication (deployed with verify_jwt off). Rows are claimed
// atomically so a text is never sent twice.
//
// Provider credentials are the same Supabase secrets the send-sms function uses; the first set wins:
//   ClickSend: CLICKSEND_USERNAME, CLICKSEND_API_KEY, CLICKSEND_FROM (your own mobile, verified in ClickSend)
//   Twilio:    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   Other:     SMS_WEBHOOK_URL (POST { to, message, event }), optional SMS_WEBHOOK_SECRET
// With none set, claimed rows are marked 'held' (not sent) so stale texts never go out later by
// surprise; queue them again once a provider is connected.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4'
import { GENERIC_ERROR, cronAllowed, makeThrottle } from '../_shared/guard.ts'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

function toE164(phone: string): string {
  const p = phone.replace(/[\s()-]/g, '')
  if (p.startsWith('+')) return p
  if (/^0\d{9}$/.test(p)) return `+61${p.slice(1)}`
  if (/^61\d{9}$/.test(p)) return `+${p}`
  return p
}

type Row = { id: string; to_phone: string; message: string; event: string; attempts: number }
type Outcome = { status: 'dispatched' | 'failed' | 'held'; detail: string }

async function send(row: Row): Promise<Outcome> {
  const csUser = Deno.env.get('CLICKSEND_USERNAME')
  const csKey = Deno.env.get('CLICKSEND_API_KEY')
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID')
  const token = Deno.env.get('TWILIO_AUTH_TOKEN')
  const from = Deno.env.get('TWILIO_FROM')
  const webhook = Deno.env.get('SMS_WEBHOOK_URL')
  const to = toE164(row.to_phone)
  if (!/^\+\d{8,15}$/.test(to)) return { status: 'failed', detail: `Invalid phone number: ${row.to_phone}` }
  try {
    if (csUser && csKey) {
      const csFrom = Deno.env.get('CLICKSEND_FROM')
      const res = await fetch(`${Deno.env.get('CLICKSEND_API_URL') ?? 'https://rest.clicksend.com'}/v3/sms/send`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`${csUser}:${csKey}`), 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ source: 'nextphase-portal', to, body: row.message, ...(csFrom ? { from: toE164(csFrom) } : {}) }] }),
      })
      const body = await res.json().catch(() => ({}))
      const m = body?.data?.messages?.[0]
      return res.ok && m?.status === 'SUCCESS'
        ? { status: 'dispatched', detail: `ClickSend ${m.message_id ?? 'sent'}` }
        : { status: 'failed', detail: `ClickSend ${m?.status ?? `HTTP ${res.status}`}${body?.response_msg ? `: ${body.response_msg}` : ''}` }
    }
    if (sid && token && from) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`${sid}:${token}`), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: row.message }),
      })
      const body = await res.json().catch(() => ({}))
      return res.ok
        ? { status: 'dispatched', detail: `Twilio ${body.sid ?? res.status}` }
        : { status: 'failed', detail: `Twilio HTTP ${res.status}: ${body.message ?? 'error'}` }
    }
    if (webhook) {
      const secret = Deno.env.get('SMS_WEBHOOK_SECRET')
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Webhook-Secret': secret } : {}) },
        body: JSON.stringify({ to, message: row.message, event: row.event }),
      })
      return { status: res.ok ? 'dispatched' : 'failed', detail: `Webhook HTTP ${res.status}` }
    }
    return { status: 'held', detail: 'No SMS provider connected yet, so this text was not sent. Queue it again once one is connected.' }
  } catch (e) {
    return { status: 'failed', detail: (e as Error).message }
  }
}

const throttle = makeThrottle(10_000)

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!cronAllowed(req, Deno.env.get('CRON_SECRET'))) return Response.json({ error: 'Not allowed' }, { status: 401 })
  if (!throttle()) return Response.json({ skipped: 'ran a moment ago' }, { status: 429 })
  const { data: rows, error } = await db.rpc('claim_sms_outbox', { max_rows: 20 })
  if (error) {
    console.error('process-sms-outbox failed:', error.message)
    return Response.json({ error: GENERIC_ERROR }, { status: 500 })
  }

  const results = []
  for (const row of (rows ?? []) as Row[]) {
    const out = await send(row)
    await db.from('sms_outbox').update({
      status: out.status,
      detail: out.detail,
      sent_at: out.status === 'dispatched' ? new Date().toISOString() : null,
    }).eq('id', row.id)
    await db.from('sms_log').insert({
      recipient_phone: row.to_phone, message: row.message, status: out.status === 'held' ? 'queued' : out.status,
      trigger_event: row.event, detail: out.detail,
    })
    results.push({ id: row.id, ...out })
  }
  return Response.json({ processed: results.length, results })
})
