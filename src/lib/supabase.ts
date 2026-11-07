import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { DbAdapter, Row, TableName } from './db'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
/** For calls that read a server function's answer as it streams in (the AI product finder). */
export const FUNCTIONS_URL = url ? `${url}/functions/v1` : ''
export const ANON_KEY = anonKey ?? ''

/** Null when the app runs in local demo mode (no Supabase project configured). */
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null
export const CLOUD = supabase !== null
/**
 * Demo mode (sample data kept in the browser) only runs in local development or in a build made
 * with VITE_DEMO=true (`npm run build:demo`). DEMO_BUILD is fixed when the app is built, so a normal
 * production build leaves the sample data out of the bundle entirely; without Supabase settings it
 * shows a setup notice instead, so a live site can never fall back to sample data.
 */
export const DEMO_BUILD = import.meta.env.DEV || import.meta.env.VITE_DEMO === 'true'
export const DEMO = !CLOUD && DEMO_BUILD

const PAGE = 1000

/**
 * projects.quote_token is kept from signed-in users (anyone holding it can accept the quote; the
 * office gets it from admin_quote_token), so `select *` on projects is refused: read these columns.
 * A new projects column needs adding here and a column grant in its migration (a DB test checks).
 */
export const PROJECT_COLUMNS: string =
  'id,number,client_id,property_id,title,description,type,budget,quote_amount,scope_of_works,status,assigned_provider_id,created_at,created_by,quote_decided_by,quote_decision,quote_inclusions,quote_exclusions,quote_valid_until,quote_issued_at,quote_decided_at,quote_followed_up_at,order_id,quote_answered_name,deposit_status,deposit_amount,deposit_invoice_id,deposit_error,deposit_attempts,deposit_next_try,qbo_estimate_id,estimate_number,estimate_status,estimate_error,estimate_attempts,estimate_next_try'
const columns = (table: TableName) => (table === 'projects' ? PROJECT_COLUMNS : '*')

export function supabaseAdapter(client: SupabaseClient): DbAdapter {
  return {
    async select(table: TableName) {
      // The API returns at most 1,000 rows per request, so read in pages until a short one.
      const rows: Row[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await client.from(table).select(columns(table)).order('id').range(from, from + PAGE - 1)
        if (error) throw new Error(`${table}: ${error.message}`)
        rows.push(...((data ?? []) as unknown as Row[]))
        if (!data || data.length < PAGE) return rows
      }
    },
    async insert(table: TableName, rows: Row[]) {
      const { error } = await client.from(table).insert(rows)
      if (error) throw new Error(`${table}: ${error.message}`)
    },
    async update(table: TableName, id: string | number, patch: Row) {
      // Ask for the id back: an update that row-level security filters out returns no rows rather than an error.
      const { data, error } = await client.from(table).update(patch).eq('id', id).select('id')
      if (error) throw new Error(`${table}: ${error.message}`)
      if (!data?.length) throw new Error(`${table}: you don't have permission to change this record`)
    },
    async remove(table: TableName, id: string | number) {
      const { error } = await client.from(table).delete().eq('id', id)
      if (error) throw new Error(`${table}: ${error.message}`)
    },
    async call(fn) {
      const { data, error } = await client.rpc(fn)
      if (error) throw new Error(`${fn}: ${error.message}`)
      return data
    },
  }
}

/** Uploads a visitor's photo for a maintenance request to the private "lead-photos" bucket; returns its path. */
export async function uploadLeadPhoto(client: SupabaseClient, dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const path = `incoming/${crypto.randomUUID()}.jpg`
  const { error } = await client.storage.from('lead-photos').upload(path, blob, { contentType: 'image/jpeg' })
  if (error) throw new Error(`A photo didn’t upload (${error.message}). Please try again.`)
  return path
}

/** Uploads a data-URL image to the public "photos" bucket and returns its URL. */
/** Uploads a product clip (MP4 or WebM, store managers only) to the public product-videos bucket; returns its public link. */
export async function uploadVideo(client: SupabaseClient, file: File, aiMade = false): Promise<string> {
  const ext = file.type === 'video/webm' ? 'webm' : 'mp4'
  // Clips AI made go under videos/ai/, so the product page can say they're renders.
  const path = `videos/${aiMade ? 'ai/' : ''}${crypto.randomUUID()}.${ext}`
  const { error } = await client.storage.from('product-videos').upload(path, file, { contentType: file.type || 'video/mp4' })
  if (error) throw new Error(`Video upload failed: ${error.message}`)
  return client.storage.from('product-videos').getPublicUrl(path).data.publicUrl
}

export async function uploadPhoto(client: SupabaseClient, dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const path = `${crypto.randomUUID()}.jpg`
  const { error } = await client.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' })
  if (error) throw new Error(`Photo upload failed: ${error.message}`)
  return client.storage.from('photos').getPublicUrl(path).data.publicUrl
}
