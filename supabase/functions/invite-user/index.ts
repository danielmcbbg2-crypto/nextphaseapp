// Supabase Edge Function: invite-only account management (admins with canEditPermissions).
//
//   { action: 'invite', profile: {...}, redirectTo, delivery? }  creates the profile and emails a
//       Supabase invite link; the person chooses a password when they open it. With
//       delivery: 'link' nothing is emailed and the link comes back for the admin to send.
//   { action: 'link', profileId, redirectTo }  a fresh link for an existing account: an invite link
//       for someone added without a login or with an invite pending (cancelling any earlier one),
//       otherwise a link to choose a new password.
//   { action: 'delete', profileId }  removes the login and the profile.
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

const MASTER_ID = 'u-admin'
const ROLES = ['admin', 'client', 'provider']
const PERMISSIONS = ['canSubmitRequests', 'canDispatchJobs', 'canManageInvoices', 'canEditPermissions', 'canManageProjects', 'canSubmitExpenses', 'canManageStore']

/**
 * A one-time link to the app's accept page, which only uses the token when the person presses
 * Continue, so link previews in SMS and email apps can't use it up first.
 *
 * Someone without a login, or with a pending invite, gets an invite token: for an existing login
 * that replaces the earlier invite token, so a link sent to the wrong person stops working. Once
 * the login is confirmed, GoTrue refuses invites (the old token was used), so it falls back to a
 * password token, as it does for everyone else. `purpose` sets the accept page's wording.
 */
async function signInLink(email: string, hasLogin: boolean, purpose: 'invite' | 'password', redirectTo: string): Promise<{ link: string; userId: string }> {
  const generate = (type: 'invite' | 'recovery') =>
    type === 'invite'
      ? db.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } })
      : db.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } })
  let res = await generate(!hasLogin || purpose === 'invite' ? 'invite' : 'recovery')
  if (res.error && hasLogin && purpose === 'invite' && (res.error.code === 'email_exists' || res.error.status === 422)) {
    res = await generate('recovery')
  }
  if (res.error) throw res.error
  const { hashed_token, verification_type } = res.data.properties
  const query = new URLSearchParams({ token_hash: hashed_token, type: verification_type, for: purpose })
  return { link: `${redirectTo.split('#')[0]}#/accept?${query}`, userId: res.data.user.id }
}

const isAppUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\/[^\s]+$/.test(u)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const jwt = req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
  const { data: auth } = await db.auth.getUser(jwt)
  if (!auth.user) return json({ error: 'Not signed in' }, 401)
  const { data: me } = await db.from('profiles').select('id, role, permissions').eq('auth_id', auth.user.id).eq('status', 'active').maybeSingle()
  if (!me || me.role !== 'admin' || !me.permissions.includes('canEditPermissions') || !secondStep(jwt)) {
    return json({ error: 'You need the “Edit accounts & permissions” permission' }, 403)
  }

  const body = await req.json().catch(() => ({}))

  if (body.action === 'invite') {
    const byLink = body.delivery === 'link'
    if (byLink && !isAppUrl(body.redirectTo)) return json({ error: 'Missing app address' }, 400)
    const p = body.profile ?? {}
    const email = String(p.email ?? '').trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email address' }, 400)
    if (!ROLES.includes(p.role)) return json({ error: 'Invalid role' }, 400)
    const { data: created, error: insertError } = await db
      .from('profiles')
      .insert({
        name: String(p.name ?? '').trim() || email,
        email,
        role: p.role,
        phone: String(p.phone ?? ''),
        company: p.company || null,
        trade: p.trade || null,
        permissions: (Array.isArray(p.permissions) ? p.permissions : []).filter((x: string) => PERMISSIONS.includes(x)),
        status: 'invited',
        // Lets the database link the login created below to this account.
        login_invited: true,
      })
      .select('id')
      .single()
    if (insertError) {
      return json({ error: insertError.code === '23505' ? 'An account with this email already exists' : insertError.message }, 400)
    }
    if (byLink) {
      try {
        return json({ id: created.id, link: (await signInLink(email, false, 'invite', body.redirectTo)).link })
      } catch (e) {
        await db.from('profiles').delete().eq('id', created.id)
        return json({ error: `Couldn't create the invite link: ${(e as Error).message}` }, 400)
      }
    }
    const { error: inviteError } = await db.auth.admin.inviteUserByEmail(email, { redirectTo: body.redirectTo })
    if (inviteError) {
      await db.from('profiles').delete().eq('id', created.id)
      return json({ error: `Invite email failed: ${inviteError.message}. Try “Create invite link” instead.` }, 400)
    }
    return json({ id: created.id })
  }

  if (body.action === 'link') {
    if (!isAppUrl(body.redirectTo)) return json({ error: 'Missing app address' }, 400)
    const { data: target } = await db.from('profiles').select('id, email, auth_id, status').eq('id', body.profileId).maybeSingle()
    if (!target) return json({ error: 'Account not found' }, 404)
    if (target.status === 'suspended') return json({ error: 'This account is suspended. Reactivate it first.' }, 400)
    if (!target.email) return json({ error: 'Add their email address and save it first.' }, 400)
    if (target.id === MASTER_ID && me.id !== MASTER_ID) return json({ error: 'Only the master admin can do this for the master admin account' }, 403)
    // The first link creates the login: allow the database to link it to this account (and only
    // for as long as it takes), then check that it did.
    const firstLogin = !target.auth_id
    if (firstLogin) {
      const { error } = await db.from('profiles').update({ login_invited: true }).eq('id', target.id)
      if (error) return json({ error: `Couldn't create the link: ${error.message}` }, 400)
    }
    try {
      const purpose = target.status === 'invited' ? 'invite' : 'password'
      const { link, userId } = await signInLink(target.email, !!target.auth_id, purpose, body.redirectTo)
      if (firstLogin) {
        const { data: linked } = await db.from('profiles').select('auth_id').eq('id', target.id).maybeSingle()
        // Auth reused a login that already existed for this email but isn't this account's (left
        // over from a deleted account, say): don't hand out a link to it.
        if (linked?.auth_id !== userId) {
          await db.from('profiles').update({ login_invited: false }).eq('id', target.id).is('auth_id', null)
          return json({ error: 'This email already has a login that isn’t linked to this account, so no link was made. Use another email, or delete that login in Supabase (Authentication → Users) and try again.' }, 409)
        }
      }
      return json({ link })
    } catch (e) {
      if (firstLogin) await db.from('profiles').update({ login_invited: false }).eq('id', target.id).is('auth_id', null)
      return json({ error: `Couldn't create the link: ${(e as Error).message}` }, 400)
    }
  }

  if (body.action === 'delete') {
    if (body.profileId === me.id) return json({ error: "You can't delete your own account" }, 400)
    // The master admin can never be deleted (the database refuses too).
    if (body.profileId === MASTER_ID) return json({ error: 'The master admin account can’t be deleted' }, 403)
    const { data: target } = await db.from('profiles').select('id, auth_id').eq('id', body.profileId).maybeSingle()
    if (!target) return json({ error: 'Account not found' }, 404)
    // Profile first: the database refuses if jobs or invoices still reference this client, or if the
    // account did work for other people (admins), which it explains in its own message.
    const { error: profileError } = await db.from('profiles').delete().eq('id', target.id)
    if (profileError) {
      const kept = profileError.message.startsWith('This account')
        ? profileError.message
        : 'This account has jobs or invoices on record, so it can’t be deleted. Suspend it instead.'
      return json({ error: profileError.code === '23503' ? kept : profileError.message }, 400)
    }
    if (target.auth_id) {
      const { error } = await db.auth.admin.deleteUser(target.auth_id)
      if (error) return json({ error: `Profile removed, but the login could not be deleted: ${error.message}` }, 400)
    }
    return json({ ok: true })
  }

  return json({ error: 'Unknown action' }, 400)
})
