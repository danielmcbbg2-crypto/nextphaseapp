// Supabase Edge Function: Service.com.au leads, answered with one tap.
//
//   { action: 'intake', email }  (header x-intake-secret = the intake key) — from the script in
//       the office's Gmail, one call per Service.com.au email. Claude reads it; if it's a job lead,
//       it's added to the leads (source 'service.com.au') with a drafted reply, and the office's
//       phones (settings.sms.recipients) get a text with a private link to the reply page.
//   { action: 'get', token }  — the reply page: the job and the drafted reply.
//   { action: 'decide', token, decision: 'approve' | 'skip', draft? }  — the office's tap.
//   { action: 'contact', token, phone }  — once Service.com.au shows the customer's number, adds it
//       to the lead and texts the customer from Next Phase (through the SMS queue).
//
// The page's link is the only key it needs (no sign-in), so links are long and random, and only
// the job, the draft and the decision are reachable through them. Deployed with verify_jwt off.
// Secrets: ANTHROPIC_API_KEY; the Gmail script's key is the 'lead_intake' row of the locked
// integration_keys table (or a LEAD_INTAKE_SECRET secret, which wins); optional PORTAL_URL.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4'
import Anthropic from 'npm:@anthropic-ai/sdk@0.131.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-intake-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const PORTAL = (Deno.env.get('PORTAL_URL') ?? 'https://portal.nextphasemaintenance.com.au').replace(/\/+$/, '')
const MODEL = 'claude-sonnet-5-5'

// Same list as the website's quote form (SITE_SERVICES, less subscriptions), plus renovations.
const SERVICES = [
  'Plumbing Services', 'Electrical Services', 'Painting and Decorating', 'Handyman Services',
  'Carpentry Services', 'Plastering Services', 'Emergency Repairs', 'Bathroom Renovations',
]

const SYSTEM = `Next Phase Maintenance is a property maintenance and renovation business in Melbourne, Australia, run by Daniel. It does plastering and ceiling repairs, painting, plumbing, electrical, carpentry, handyman work, emergency repairs and bathroom renovations, across metropolitan Melbourne. It pays Service.com.au for job leads.

You are given one email from Service.com.au from the office's inbox. Decide whether it announces a new job lead (a homeowner or business asking for work). Account notices, invoices, newsletters, reviews, quote reminders and messages about jobs already answered are not new leads.

If it is a new lead, call record_lead with:
- customer_name: the customer's name as the email gives it (often a first name only), or empty.
- suburb: the job's suburb or area, or empty.
- services: the services from the list that fit the job (one or more).
- urgency: urgent (emergency or within a day or two), soon (within a few weeks) or flexible.
- summary: one plain sentence saying what the customer wants done, with any size, budget or timing they gave.
- headline: the job in 3 to 7 words for a text message, e.g. "Small bathroom renovation" or "Ceiling crack repair, 2 rooms".
- job_url: the link in the email that opens this job on Service.com.au (to view or respond), copied exactly from the links given; empty if there is none.
- fit: good if it's work Next Phase does in metropolitan Melbourne; check if it's unclear (vague details, edge of Melbourne, a trade it may not do); skip if it's clearly not its work or clearly outside Melbourne.
- fit_reason: a few words explaining the fit.
- reply: the first message to send the customer through Service.com.au, from Daniel at Next Phase Maintenance. 50 to 110 words, plain Australian English, warm and professional, no emojis. Mention the job's specifics so they can tell it was read, say briefly that Next Phase can help, and ask one or two useful questions (photos, measurements, access, timing) to get to a quote. Don't give a price, and don't include phone numbers, emails or web links (the platform shows contact details itself). Sign off "Daniel, Next Phase Maintenance".

If it is not a new lead, call record_lead with is_lead false and empty or default values for the rest. Use only what the email says; never make up details.`

const TOOL = {
  name: 'record_lead',
  description: 'Record what this email is. Call once.',
  strict: true,
  input_schema: {
    type: 'object' as const,
    properties: {
      is_lead: { type: 'boolean' },
      customer_name: { type: 'string' },
      suburb: { type: 'string' },
      services: { type: 'array', items: { type: 'string', enum: SERVICES } },
      urgency: { type: 'string', enum: ['urgent', 'soon', 'flexible'] },
      summary: { type: 'string' },
      headline: { type: 'string' },
      job_url: { type: 'string' },
      fit: { type: 'string', enum: ['good', 'check', 'skip'] },
      fit_reason: { type: 'string' },
      reply: { type: 'string' },
    },
    required: ['is_lead', 'customer_name', 'suburb', 'services', 'urgency', 'summary', 'headline', 'job_url', 'fit', 'fit_reason', 'reply'],
    additionalProperties: false,
  },
}

type Read = {
  is_lead: boolean; customer_name: string; suburb: string; services: string[]; urgency: 'urgent' | 'soon' | 'flexible'
  summary: string; headline: string; job_url: string; fit: 'good' | 'check' | 'skip'; fit_reason: string; reply: string
}
type Email = { id: string; from: string; subject: string; date: string; body: string; links: string[] }

const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n)
const sameSecret = (a: string, b: string) => {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
const newToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** Only links on Service.com.au itself become the "open job" button. */
const serviceLink = (url: string, offered: string[]) => {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const ours = host === 'service.com.au' || host.endsWith('.service.com.au')
    return u.protocol === 'https:' && ours && offered.includes(url) ? url : ''
  } catch {
    return ''
  }
}

/** Claude's reading of the email (one retry if it stops without recording it). */
async function readEmail(email: Email): Promise<Read> {
  const client = new Anthropic()
  const prompt = [
    `From: ${email.from}`, `Subject: ${email.subject}`, `Date: ${email.date}`, '',
    'Links in the email:', ...(email.links.length ? email.links.map((l) => `- ${l}`) : ['(none)']), '',
    'Email text:', email.body,
  ].join('\n')
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content: prompt }]
  for (let i = 0; i < 2; i++) {
    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: 'low' },
      system: SYSTEM,
      tools: [TOOL],
      messages,
    })
    const call = msg.content.find((b) => b.type === 'tool_use' && b.name === TOOL.name)
    if (call && call.type === 'tool_use') return call.input as Read
    messages.push({ role: 'assistant', content: msg.content.filter((b) => b.type === 'text') }, { role: 'user', content: 'Call record_lead now.' })
  }
  throw new Error('Claude did not record the email')
}

async function queueText(to: string, message: string, event: string, leadId: string, source: string) {
  const { error } = await db.from('sms_outbox').insert({ to_phone: to, message: message.slice(0, 480), event, source, lead_id: leadId })
  if (error) console.error('service-leads: text not queued:', error.message)
}

async function intake(email: Email) {
  if (!email.id || !email.body) return json({ error: 'Missing email id or text' }, 400)
  const { data: seen } = await db.from('leads').select('id').eq('external_id', `gmail:${email.id}`).maybeSingle()
  if (seen) return json({ status: 'duplicate', lead_id: seen.id })

  const r = await readEmail(email)
  if (!r.is_lead) return json({ status: 'not_a_lead' })

  const first = clip(r.customer_name, 120) || 'Service.com.au customer'
  const jobUrl = serviceLink(clip(r.job_url, 1000), email.links)
  const { data: lead, error } = await db.from('leads').insert({
    name: first,
    suburb: clip(r.suburb, 80),
    services: (r.services ?? []).filter((s) => SERVICES.includes(s)),
    urgency: r.urgency,
    contact_by: 'phone',
    message: clip(`${r.summary}\n\n— Service.com.au alert: ${email.subject}`, 2000),
    source: 'service.com.au',
    external_id: `gmail:${email.id}`,
    job_url: jobUrl,
  }).select('id, number').single()
  if (error) {
    // Two runs of the script at once: the other one added it.
    if (error.code === '23505') return json({ status: 'duplicate' })
    throw new Error(error.message)
  }

  const token = newToken()
  const { error: rErr } = await db.from('lead_replies').insert({
    lead_id: lead.id, token, draft: clip(r.reply, 2000), fit: r.fit, fit_reason: clip(r.fit_reason, 200), summary: clip(r.summary, 500), headline: clip(r.headline, 80),
  })
  if (rErr) throw new Error(rErr.message)

  // In the portal's inbox for the office, as website enquiries are.
  const { data: admins } = await db.from('profiles').select('id, permissions').eq('role', 'admin').eq('status', 'active')
  const inbox = (admins ?? [])
    .filter((a) => (a.permissions ?? []).includes('canManageProjects') || (a.permissions ?? []).includes('canDispatchJobs'))
    .map((a) => ({ user_id: a.id, title: `Service.com.au lead #${lead.number}: ${first}`, body: [r.summary, r.suburb].filter(Boolean).join(' · ') }))
  if (inbox.length) await db.from('inbox').insert(inbox)

  const { data: settings } = await db.from('settings').select('sms').eq('id', 1).maybeSingle()
  const recipients: string[] = settings?.sms?.recipients ?? []
  const fitNote = r.fit === 'good' ? '' : r.fit === 'skip' ? ` (Claude suggests skipping: ${clip(r.fit_reason, 60)})` : ' (worth a check)'
  const text = `New Service.com.au lead${r.urgency === 'urgent' ? ' (URGENT)' : ''}: ${clip(r.headline || r.summary, 80)}${r.suburb ? `, ${clip(r.suburb, 40)}` : ''}${fitNote}. Reply drafted, tap to send: ${PORTAL}/#/reply/${token}`
  for (const to of recipients) await queueText(to, text, `Service.com.au lead #${lead.number}`, lead.id, 'service_lead')

  return json({ status: 'lead', lead_id: lead.id, number: lead.number, fit: r.fit })
}

async function byToken(token: string) {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) return null
  const { data } = await db.from('lead_replies').select('*, leads(id, number, name, suburb, services, urgency, phone, job_url, created_at)').eq('token', token).maybeSingle()
  // Links stop working after 30 days.
  if (!data || Date.now() - new Date(data.created_at).getTime() > 30 * 86_400_000) return null
  return data
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const body = await req.json().catch(() => ({}))
  try {
    if (body.action === 'intake') {
      // The key is kept in the locked integration_keys table (or the LEAD_INTAKE_SECRET secret).
      const { data: key } = await db.from('integration_keys').select('value').eq('name', 'lead_intake').maybeSingle()
      const expected = Deno.env.get('LEAD_INTAKE_SECRET') || key?.value || ''
      if (!sameSecret(req.headers.get('x-intake-secret') ?? '', expected)) return json({ error: 'Not allowed' }, 401)
      if (!Deno.env.get('ANTHROPIC_API_KEY')) return json({ error: 'ANTHROPIC_API_KEY is not set' }, 503)
      const e = body.email ?? {}
      return await intake({
        id: clip(e.id, 200), from: clip(e.from, 300), subject: clip(e.subject, 300), date: clip(e.date, 100),
        body: clip(e.body, 20000), links: (Array.isArray(e.links) ? e.links : []).map((l: unknown) => clip(l, 1000)).filter(Boolean).slice(0, 60),
      })
    }

    const row = await byToken(String(body.token ?? ''))
    if (!row) return json({ error: 'This link has expired or isn’t valid.' }, 404)
    const lead = row.leads

    if (body.action === 'get') {
      return json({
        lead: { number: lead.number, name: lead.name, suburb: lead.suburb, services: lead.services, urgency: lead.urgency, jobUrl: lead.job_url, hasPhone: !!lead.phone, createdAt: lead.created_at },
        summary: row.summary, draft: row.draft, fit: row.fit, fitReason: row.fit_reason, status: row.status, decidedAt: row.decided_at,
      })
    }

    if (body.action === 'decide') {
      const decision = body.decision === 'skip' ? 'skipped' : body.decision === 'approve' ? 'approved' : null
      if (!decision) return json({ error: 'Approve or skip?' }, 400)
      const draft = clip(body.draft ?? row.draft, 2000) || row.draft
      await db.from('lead_replies').update({ status: decision, draft, decided_at: new Date().toISOString() }).eq('lead_id', lead.id)
      await db.from('leads').update({ status: decision === 'approved' ? 'contacted' : 'lost' }).eq('id', lead.id)
      return json({ status: decision })
    }

    if (body.action === 'contact') {
      const phone = clip(body.phone, 40)
      if (phone.replace(/\D/g, '').length < 8) return json({ error: 'Enter the customer’s mobile number.' }, 400)
      if (lead.phone) return json({ error: 'This customer has already been texted.' }, 409)
      // Claim the lead by setting its phone only while it's still empty (leads.phone is not null,
      // default ''), so two taps or two tabs can't both queue the text.
      const { data: claimed, error: claimError } = await db.from('leads').update({ phone, status: 'contacted' })
        .eq('id', lead.id).eq('phone', '').select('id')
      if (claimError) throw new Error(claimError.message)
      if (!claimed?.length) return json({ error: 'This customer has already been texted.' }, 409)
      const first = lead.name === 'Service.com.au customer' ? 'there' : String(lead.name).split(' ')[0]
      const job = String(row.headline || 'job').replace(/\.$/, '').toLowerCase()
      const msg = `Hi ${first}, it's Daniel from Next Phase Maintenance. I've just replied to your ${job} request on Service.com.au. Happy to chat or come out for a look. If you can, text through a few photos and I'll get you a quote.`
      await queueText(phone, msg, `Service.com.au lead #${lead.number} follow-up`, lead.id, 'service_lead')
      return json({ status: 'texted' })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    console.error('service-leads failed:', (e as Error).message)
    return json({ error: (e as Error).message }, 500)
  }
})
