// Supabase Edge Function: sends SMS alerts and records them in sms_log.
//
// Credentials live in Supabase secrets, never in the browser. The first one set is used:
//   ClickSend: CLICKSEND_USERNAME, CLICKSEND_API_KEY, CLICKSEND_FROM (the sender: your own mobile,
//              verified in ClickSend, e.g. +61400000000)
//   Twilio:    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (e.g. +61400000000)
//   Other:     SMS_WEBHOOK_URL (receives POST { to, message, event }), optional SMS_WEBHOOK_SECRET
// With none configured, messages are logged as "queued".
//
// Who can send what:
//   new_request / quote_request — the client who created it (or an admin); the
//     server builds the message and sends it only to the admin numbers in settings.
//   admins / direct — admins only (manual alerts, dispatch notices, test sends).
import { createClient } from 'npm:@supabase/supabase-js@2.49.4'

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

/** Australian mobiles are often typed as 04xx xxx xxx; SMS APIs want +614xxxxxxxx. */
function toE164(phone: string): string {
  const p = phone.replace(/[\s()-]/g, '')
  if (p.startsWith('+')) return p
  if (/^0\d{9}$/.test(p)) return `+61${p.slice(1)}`
  if (/^61\d{9}$/.test(p)) return `+${p}`
  return p
}

type Result = { to: string; status: 'dispatched' | 'queued' | 'failed'; detail: string }

/** Sends one text through ClickSend. */
async function clickSend(to: string, message: string): Promise<{ ok: boolean; detail: string }> {
  const user = Deno.env.get('CLICKSEND_USERNAME')!
  const key = Deno.env.get('CLICKSEND_API_KEY')!
  const from = Deno.env.get('CLICKSEND_FROM')
  const res = await fetch(`${Deno.env.get('CLICKSEND_API_URL') ?? 'https://rest.clicksend.com'}/v3/sms/send`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${user}:${key}`), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ source: 'nextphase-portal', to: toE164(to), body: message, ...(from ? { from: toE164(from) } : {}) }] }),
  })
  const body = await res.json().catch(() => ({}))
  const m = body?.data?.messages?.[0]
  return res.ok && m?.status === 'SUCCESS'
    ? { ok: true, detail: `ClickSend ${m.message_id ?? 'sent'}` }
    : { ok: false, detail: `ClickSend ${m?.status ?? `HTTP ${res.status}`}${body?.response_msg ? `: ${body.response_msg}` : ''}` }
}

async function sendOne(to: string, message: string, event: string): Promise<Result> {
  const clicksend = Deno.env.get('CLICKSEND_USERNAME') && Deno.env.get('CLICKSEND_API_KEY')
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID')
  const token = Deno.env.get('TWILIO_AUTH_TOKEN')
  const from = Deno.env.get('TWILIO_FROM')
  const webhook = Deno.env.get('SMS_WEBHOOK_URL')
  let result: Result
  try {
    if (clicksend) {
      const r = await clickSend(to, message)
      result = { to, status: r.ok ? 'dispatched' : 'failed', detail: r.detail }
    } else if (sid && token && from) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`${sid}:${token}`), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: toE164(to), From: from, Body: message }),
      })
      const body = await res.json().catch(() => ({}))
      result = res.ok
        ? { to, status: 'dispatched', detail: `Twilio ${body.sid ?? res.status}` }
        : { to, status: 'failed', detail: `Twilio HTTP ${res.status}: ${body.message ?? 'error'}` }
    } else if (webhook) {
      const secret = Deno.env.get('SMS_WEBHOOK_SECRET')
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Webhook-Secret': secret } : {}) },
        body: JSON.stringify({ to: toE164(to), message, event }),
      })
      result = { to, status: res.ok ? 'dispatched' : 'failed', detail: `Webhook HTTP ${res.status}` }
    } else {
      result = { to, status: 'queued', detail: 'No SMS provider configured — logged only.' }
    }
  } catch (e) {
    result = { to, status: 'failed', detail: (e as Error).message }
  }
  await db.from('sms_log').insert({ recipient_phone: to, message, status: result.status, trigger_event: event, detail: result.detail })
  return result
}

async function sendToAdmins(recipients: string[], message: string, event: string): Promise<Result[]> {
  if (recipients.length === 0) {
    const detail = 'No admin phone numbers set in SMS gateway settings — logged only.'
    await db.from('sms_log').insert({ recipient_phone: '(none)', message, status: 'queued', trigger_event: event, detail })
    return [{ to: '(none)', status: 'queued', detail }]
  }
  return Promise.all(recipients.map((r) => sendOne(r, message, event)))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const jwt = req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
  const { data: auth } = await db.auth.getUser(jwt)
  if (!auth.user) return json({ error: 'Not signed in' }, 401)
  const { data: me } = await db.from('profiles').select('id, role, name').eq('auth_id', auth.user.id).eq('status', 'active').maybeSingle()
  if (!me) return json({ error: 'Account is not active' }, 403)
  const isAdmin = me.role === 'admin' && secondStep(jwt)

  const body = await req.json().catch(() => ({}))
  const { data: settings } = await db.from('settings').select('sms').eq('id', 1).single()
  const sms = (settings?.sms ?? {}) as { recipients?: string[]; notifyOnNewRequest?: boolean; notifyOnUrgentOnly?: boolean }
  const recipients = (sms.recipients ?? []).filter(Boolean)

  switch (body.kind) {
    case 'new_request': {
      const { data: r } = await db.from('requests').select('*, properties(address, suburb)').eq('id', body.requestId).maybeSingle()
      if (!r || (r.client_id !== me.id && !isAdmin)) return json({ error: 'Request not found' }, 404)
      if (r.sms_notified) return json({ results: [] }) // already alerted; stops repeat sends
      const wanted = sms.notifyOnNewRequest !== false && (!sms.notifyOnUrgentOnly || r.urgency === 'urgent')
      if (!wanted) return json({ results: [] })
      const where = r.properties ? ` · ${r.properties.address}, ${r.properties.suburb}` : ''
      const message = `NPM #${r.number}${r.urgency === 'urgent' ? ' URGENT' : ''} — ${r.title}${where} (${r.category})`
      // Claim the alert before sending: only the call that flips sms_notified from false sends, so
      // two calls at once can't both text the admins.
      const { data: claimed, error: claimError } = await db.from('requests').update({ sms_notified: true })
        .eq('id', r.id).eq('sms_notified', false).select('id')
      if (claimError) return json({ error: claimError.message }, 500)
      if (!claimed?.length) return json({ results: [] }) // another call is sending it
      const results = await sendToAdmins(recipients, message, 'New maintenance request')
      return json({ results })
    }

    case 'quote_request': {
      const { data: p } = await db.from('projects').select('*').eq('id', body.projectId).maybeSingle()
      if (!p || (p.client_id !== me.id && !isAdmin)) return json({ error: 'Project not found' }, 404)
      const prefix = `NPM quote request P-${p.number} `
      const { count } = await db.from('sms_log').select('id', { count: 'exact', head: true }).like('message', `${prefix}%`)
      if (count) return json({ results: [] }) // already alerted
      // An admin may request it from the client's dashboard: name both.
      let who = me.name
      if (p.client_id !== me.id) {
        const { data: client } = await db.from('profiles').select('name').eq('id', p.client_id).maybeSingle()
        who = `${me.name} for ${client?.name ?? 'client'}`
      }
      const results = await sendToAdmins(recipients, `${prefix}— ${p.title} (${who})`, 'Renovation quote request')
      return json({ results })
    }

    case 'admins': {
      if (!isAdmin) return json({ error: 'Admins only' }, 403)
      const message = String(body.message ?? '').slice(0, 480)
      if (!message) return json({ error: 'Message is empty' }, 400)
      return json({ results: await sendToAdmins(recipients, message, String(body.event ?? 'Manual alert')) })
    }

    case 'direct': {
      if (!isAdmin) return json({ error: 'Admins only' }, 403)
      const to = String(body.to ?? '').trim()
      const message = String(body.message ?? '').slice(0, 480)
      if (!to || !message) return json({ error: 'Recipient and message are required' }, 400)
      return json({ results: [await sendOne(to, message, String(body.event ?? 'Direct message'))] })
    }

    default:
      return json({ error: 'Unknown request' }, 400)
  }
})
