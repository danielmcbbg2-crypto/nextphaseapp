// Supabase Edge Function: clears out request photos that were uploaded but never used.
//
// Visitors can upload photos to the private lead-photos bucket before they send the form. Photos
// still in incoming/ a day later that no request uses are deleted here (through the Storage API, so
// the files go too). Runs daily from pg_cron (see migration 20261119000000); deployed with verify_jwt
// off. If the CRON_SECRET setting is set, callers must send it in the x-cron-secret header.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4'
import { GENERIC_ERROR, cronAllowed, makeThrottle } from '../_shared/guard.ts'
import { staleUploads } from './stale.ts'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const throttle = makeThrottle(60_000)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!cronAllowed(req, Deno.env.get('CRON_SECRET'))) return json({ error: 'Not allowed' }, 401)
  if (!throttle()) return json({ skipped: 'ran a moment ago' }, 429)
  try {
    const { data: leads, error: lErr } = await db.from('leads').select('photos')
    if (lErr) throw new Error(lErr.message)
    const claimed = new Set<string>((leads ?? []).flatMap((l) => (l.photos ?? []) as string[]))
    let removed = 0
    // Up to 1,000 oldest uploads per run; the daily schedule catches up over time.
    const { data: files, error } = await db.storage.from('lead-photos').list('incoming', { limit: 1000, sortBy: { column: 'created_at', order: 'asc' } })
    if (error) throw new Error(error.message)
    const stale = staleUploads((files ?? []).map((f) => ({ name: f.name, created_at: f.created_at ?? null })), claimed)
    for (let i = 0; i < stale.length; i += 100) {
      const { error: rErr } = await db.storage.from('lead-photos').remove(stale.slice(i, i + 100))
      if (rErr) throw new Error(rErr.message)
      removed += Math.min(100, stale.length - i)
    }
    return json({ removed })
  } catch (e) {
    console.error('purge-lead-photos failed:', (e as Error).message)
    return json({ error: GENERIC_ERROR }, 500)
  }
})
