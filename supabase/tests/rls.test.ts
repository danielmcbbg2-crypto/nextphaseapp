/**
 * Row-level security + data-sync tests against a real Postgres.
 * Run with `npm run test:db` (see supabase/tests/run.sh).
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { applyOps, diff, fetchAll, type DbAdapter, type Row, type TableName } from '../../src/lib/db'
import { createSeed } from '../../src/lib/seed'
import type { AppData } from '../../src/lib/types'

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })

/** Runs each statement as the given auth user under the `authenticated` role, like PostgREST does. */
// Signed in, having done the second sign-in step (aal2) unless aal says otherwise.
async function asUser<T>(uid: string, sql: string, params: unknown[] = [], aal: 'aal1' | 'aal2' = 'aal2'): Promise<pg.QueryResult<T & pg.QueryResultRow>> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role authenticated')
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', aal })])
    const r = await c.query<T & pg.QueryResultRow>(sql, params)
    await c.query('commit')
    return r
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

/** DbAdapter with the same semantics as the Supabase adapter (insert sends only the given columns). */
function adapter(uid: string): DbAdapter {
  return {
    async select(t: TableName) {
      return (await asUser<{ j: Row }>(uid, `select to_jsonb(x) j from public.${t} x`)).rows.map((r) => r.j)
    },
    async insert(t: TableName, rows: Row[]) {
      const cols = Object.keys(rows[0]).map((c) => `"${c}"`).join(',')
      await asUser(uid, `insert into public.${t} (${cols}) select ${cols} from jsonb_populate_recordset(null::public.${t}, $1)`, [JSON.stringify(rows)])
    },
    async update(t: TableName, id: string | number, patch: Row) {
      const cols = Object.keys(patch).map((c) => `"${c}"`).join(',')
      const r = await asUser(
        uid,
        `update public.${t} set (${cols}) = (select ${cols} from jsonb_populate_record(null::public.${t}, $1)) where id = $2 returning id`,
        [JSON.stringify(patch), id],
      )
      if (r.rowCount === 0) throw new Error(`${t}: you don't have permission to change this record`)
    },
    async remove(t: TableName, id: string | number) {
      await asUser(uid, `delete from public.${t} where id = $1`, [id])
    },
    async call(fn: string) {
      return (await asUser<{ j: unknown }>(uid, `select to_jsonb(public.${fn}()) j`)).rows[0].j
    },
  }
}

/** Creates a login the way Supabase Auth does: as the non-superuser supabase_auth_admin role. */
async function createAuthUser(email: string): Promise<string> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role supabase_auth_admin')
    const r = await c.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email])
    await c.query('commit')
    return r.rows[0].id
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

/** What the invite-user function does: allow a login for the account, then create it. */
async function inviteAuthUser(email: string): Promise<string> {
  await pool.query('update public.profiles set login_invited = true where lower(email) = lower($1)', [email])
  return createAuthUser(email)
}

async function mutate(db: DbAdapter, fn: (d: AppData) => void) {
  const prev = await fetchAll(db)
  const next = structuredClone(prev)
  fn(next)
  await applyOps(db, diff(prev, next))
}

const uid: Record<string, string> = {}
let admin: DbAdapter, sarah: DbAdapter, marcus: DbAdapter, dan: DbAdapter

before(async () => {
  uid.admin = await createAuthUser('admin@nextphasemaintenance.com.au')
  admin = adapter(uid.admin)

  // Admin loads the sample business data (minus SMS log, which only the server function writes).
  const seed = createSeed()
  await mutate(admin, (d) => {
    d.users.push(...seed.users.filter((u) => u.id !== 'u-admin').map((u) => ({ ...u, status: 'invited' as const })))
    d.properties = seed.properties
    d.projects = seed.projects
    d.requests = seed.requests
    d.invoices = seed.invoices
    d.inbox = seed.inbox
  })

  for (const [key, email] of [
    ['sarah', 'sarah@whitfieldproperty.com.au'],
    ['marcus', 'marcus.lee@example.com.au'],
    ['dan', 'dan@kowalskicarpentry.com.au'],
  ]) {
    uid[key] = await inviteAuthUser(email)
    await asUser(uid[key], 'select activate_my_account()')
  }
  sarah = adapter(uid.sarah)
  marcus = adapter(uid.marcus)
  dan = adapter(uid.dan)
})

after(() => pool.end())

describe('accounts', () => {
  test('sign-ups without an invitation are rejected', async () => {
    await assert.rejects(createAuthUser('stranger@example.com'), /No Next Phase Maintenance invitation/)
  })

  test('signed-out visitors cannot call the helper functions; signed-in users can', async () => {
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query('set local role anon')
      await assert.rejects(c.query('select public.is_admin()'), /permission denied/)
    } finally {
      await c.query('rollback')
      c.release()
    }
    const r = await asUser<{ ok: boolean }>(uid.admin, 'select public.is_admin() as ok')
    assert.equal(r.rows[0].ok, true)
  })

  test('master admin is linked and active', async () => {
    const d = await fetchAll(admin)
    const me = d.users.find((u) => u.id === 'u-admin')!
    assert.equal(me.status, 'active')
    assert.equal(d.users.length, 6)
  })

  test('non-admins cannot edit profiles, including their own permissions', async () => {
    await assert.rejects(
      mutate(sarah, (d) => {
        d.users.find((u) => u.id === 'u-client-1')!.permissions.push('canEditPermissions')
      }),
      /permission/,
    )
  })

  test('suspended accounts see nothing', async () => {
    await mutate(admin, (d) => {
      d.users.find((u) => u.id === 'u-client-2')!.status = 'suspended'
    })
    const d = await fetchAll(marcus)
    assert.equal(d.requests.length + d.properties.length + d.projects.length, 0)
    await mutate(admin, (d) => {
      d.users.find((u) => u.id === 'u-client-2')!.status = 'active'
    })
  })
})

describe('client visibility & actions', () => {
  test('sees only their own records and the trades on their jobs', async () => {
    const d = await fetchAll(sarah)
    assert.deepEqual(d.properties.map((p) => p.id).sort(), ['p-1', 'p-2'])
    assert.deepEqual(d.requests.map((r) => r.id).sort(), ['r-1', 'r-3', 'r-4', 'r-5'])
    assert.deepEqual(d.projects.map((p) => p.id), ['pr-1'])
    assert.equal(d.invoices.length, 3)
    assert.deepEqual(d.users.map((u) => u.id).sort(), ['u-client-1', 'u-prov-1', 'u-prov-2', 'u-prov-3'])
    assert.equal(d.sms.length, 0)
    assert.equal(d.smsSettings.recipients.length, 0)
  })

  test('can lodge a request on their own property, and the server numbers it', async () => {
    const r = await asUser<{ number: number }>(
      uid.sarah,
      `insert into requests (client_id, property_id, title, category, urgency) values ('u-client-1', 'p-1', 'Smoke alarm', 'Handyman', 'urgent') returning number`,
    )
    assert.ok(r.rows[0].number > 1000)
  })

  test("cannot lodge a request on someone else's property", async () => {
    await assert.rejects(
      asUser(uid.sarah, `insert into requests (client_id, property_id, title, category) values ('u-client-1', 'p-3', 'x', 'Handyman')`),
      /row-level security/,
    )
  })

  test('cannot edit or reassign requests', async () => {
    await assert.rejects(
      mutate(sarah, (d) => {
        d.requests.find((r) => r.id === 'r-1')!.title = 'changed'
      }),
      /permission/,
    )
  })

  test('can add and edit their own properties', async () => {
    await mutate(sarah, (d) => {
      d.properties.push({ ...d.properties[0], id: 'p-new', address: '1 New Street' })
      d.properties.find((p) => p.id === 'p-1')!.paintColors.walls = 'Dulux Lexicon Quarter'
    })
    const d = await fetchAll(sarah)
    assert.equal(d.properties.length, 3)
    assert.equal(d.properties.find((p) => p.id === 'p-1')!.paintColors.walls, 'Dulux Lexicon Quarter')
  })

  test('quote flow: request, admin prices it, client accepts but cannot change the price', async () => {
    await asUser(uid.sarah, `insert into projects (id, client_id, property_id, title) values ('pr-q', 'u-client-1', 'p-2', 'Kitchen')`)
    await assert.rejects(
      asUser(uid.sarah, `insert into projects (client_id, property_id, title, quote_amount) values ('u-client-1', 'p-2', 'Cheap', 1)`),
      /row-level security/,
    )
    await mutate(admin, (d) => {
      const p = d.projects.find((x) => x.id === 'pr-q')!
      p.quoteAmount = 25000
      p.status = 'quoted'
    })
    await assert.rejects(
      mutate(sarah, (d) => {
        const p = d.projects.find((x) => x.id === 'pr-q')!
        p.status = 'approved'
        p.quoteAmount = 1
      }),
      /only accept or decline/,
    )
    await mutate(sarah, (d) => {
      d.projects.find((x) => x.id === 'pr-q')!.status = 'approved'
    })
    const p = (await fetchAll(admin)).projects.find((x) => x.id === 'pr-q')!
    assert.equal(p.status, 'approved')
    assert.equal(p.quoteAmount, 25000)
  })
})

describe('service provider visibility & actions', () => {
  test('sees assigned jobs, their properties and clients only', async () => {
    const d = await fetchAll(dan)
    assert.deepEqual(d.requests.map((r) => r.id).sort(), ['r-2', 'r-4'])
    assert.deepEqual(d.projects.map((p) => p.id), ['pr-1'])
    assert.deepEqual(d.properties.map((p) => p.id).sort(), ['p-1', 'p-3'])
    assert.deepEqual(d.users.map((u) => u.id).sort(), ['u-client-1', 'u-client-2', 'u-prov-1'])
    assert.equal(d.invoices.length, 0)
    assert.equal(d.projects[0].milestones.length, 5)
    // The quote, variations, payments and costs are between the office and the client.
    const p = d.projects[0]
    assert.equal(p.quoteItems.length + p.variations.length + p.payments.length + p.costs.length, 0)
  })

  test('can update status, notes, schedule and completion photos', async () => {
    await mutate(dan, (d) => {
      const r = d.requests.find((x) => x.id === 'r-2')!
      r.status = 'in_progress'
      r.notes = 'On site'
      r.scheduledDate = '2030-01-02'
      r.completionPhotos.push('https://example.com/a.jpg')
    })
    const r = (await fetchAll(admin)).requests.find((x) => x.id === 'r-2')!
    assert.equal(r.status, 'in_progress')
    assert.equal(r.scheduledDate, '2030-01-02')
    assert.deepEqual(r.completionPhotos, ['https://example.com/a.jpg'])
  })

  test('cannot change job details or send a job back to triage', async () => {
    await assert.rejects(
      mutate(dan, (d) => {
        d.requests.find((x) => x.id === 'r-2')!.title = 'x'
      }),
      /Only status/,
    )
    await assert.rejects(
      mutate(dan, (d) => {
        d.requests.find((x) => x.id === 'r-2')!.status = 'pending'
      }),
      /back to triage/,
    )
  })

  test('can tick off and reschedule milestones but not rename them', async () => {
    await mutate(dan, (d) => {
      const m = d.projects[0].milestones.find((x) => x.id === 'm-3')!
      m.done = true
      m.date = '2030-02-03'
    })
    await assert.rejects(
      mutate(dan, (d) => {
        d.projects[0].milestones.find((x) => x.id === 'm-3')!.title = 'x'
      }),
      /Only milestone/,
    )
  })

  test('can submit expenses only as "submitted" on assigned projects', async () => {
    await mutate(dan, (d) => {
      d.projects[0].expenses.push({ id: 'e-new', providerId: 'u-prov-1', date: '2030-01-01', description: 'Tiles', category: 'Materials', amount: 812.35, status: 'submitted' })
    })
    await assert.rejects(
      mutate(dan, (d) => {
        d.projects[0].expenses.push({ id: 'e-bad', providerId: 'u-prov-1', date: '2030-01-01', description: 'x', category: 'Other', amount: 1, status: 'approved' })
      }),
      /row-level security/,
    )
    await assert.rejects(
      mutate(dan, (d) => {
        d.projects[0].expenses.find((e) => e.id === 'e-new')!.status = 'approved'
      }),
      /permission/,
    )
    const e = (await fetchAll(admin)).projects.find((p) => p.id === 'pr-1')!.expenses.find((x) => x.id === 'e-new')!
    assert.equal(e.amount, 812.35)
  })

  test('can acknowledge inbox items but not rewrite them, and can notify admins', async () => {
    await mutate(dan, (d) => {
      Object.assign(d.inbox.find((m) => m.id === 'n-1')!, { read: true, acknowledged: true })
    })
    await assert.rejects(
      mutate(dan, (d) => {
        d.inbox.find((m) => m.id === 'n-1')!.title = 'x'
      }),
      /Only read/,
    )
    await asUser(uid.dan, `select notify_admins('Job done', 'Ready to invoice', 'r-2', null)`)
    const adminInbox = (await fetchAll(admin)).inbox
    assert.ok(adminInbox.some((m) => m.title === 'Job done' && m.requestId === 'r-2'))
  })
})

describe('granular permissions', () => {
  test('an admin without dispatch or project rights can view jobs and projects but not change them', async () => {
    await mutate(admin, (d) => {
      d.users.push({
        id: 'u-office',
        name: 'Office',
        email: 'office@nextphasemaintenance.com.au',
        role: 'admin',
        phone: '',
        permissions: ['canManageInvoices'],
        createdAt: new Date().toISOString(),
        status: 'invited',
        passwordHash: '',
      })
    })
    uid.office = await inviteAuthUser('office@nextphasemaintenance.com.au')
    await asUser(uid.office, 'select activate_my_account()')
    const office = adapter(uid.office)
    const d = await fetchAll(office)
    assert.ok(d.requests.length > 0 && d.projects.length > 0)
    await assert.rejects(
      mutate(office, (x) => {
        x.requests.find((r) => r.id === 'r-1')!.notes = 'x'
      }),
      /permission/,
    )
    await assert.rejects(
      mutate(office, (x) => {
        x.projects.find((p) => p.id === 'pr-1')!.budget = 1
      }),
      /permission/,
    )
  })

  test('a trade needs expense rights and an open project to submit expenses', async () => {
    const expense = (id: string) => (d: AppData) => {
      d.projects.find((p) => p.id === 'pr-1')!.expenses.push({ id, providerId: 'u-prov-1', date: '2030-01-01', description: 'x', category: 'Other', amount: 1, status: 'submitted' })
    }
    await mutate(admin, (d) => {
      d.users.find((u) => u.id === 'u-prov-1')!.permissions = []
    })
    await assert.rejects(mutate(dan, expense('e-noperm')), /row-level security/)
    await mutate(admin, (d) => {
      d.users.find((u) => u.id === 'u-prov-1')!.permissions = ['canSubmitExpenses']
      d.projects.find((p) => p.id === 'pr-1')!.status = 'completed'
    })
    await assert.rejects(mutate(dan, expense('e-closed')), /row-level security/)
    await mutate(admin, (d) => {
      d.projects.find((p) => p.id === 'pr-1')!.status = 'in_progress'
    })
  })

  test('a quote cannot be issued without a price', async () => {
    await assert.rejects(
      mutate(admin, (d) => {
        d.projects.find((p) => p.id === 'pr-2')!.status = 'quoted'
      }),
      /quoted_needs_price/,
    )
  })
})

describe('server functions (service role)', () => {
  test('can record that a request was SMS-alerted despite the column guards', async () => {
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query('set local role service_role')
      await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
      const r = await c.query(`update requests set sms_notified = true where id = 'r-2' returning sms_notified`)
      await c.query('commit')
      assert.equal(r.rows[0].sms_notified, true)
    } finally {
      c.release()
    }
  })
})

describe('admin', () => {
  test('can dispatch, invoice, approve expenses and update settings', async () => {
    await mutate(admin, (d) => {
      const r = d.requests.find((x) => x.id === 'r-1')!
      r.assignedProviderId = 'u-prov-3'
      r.status = 'assigned'
      d.inbox.unshift({ id: 'n-x', userId: 'u-prov-3', title: 'New work order', body: '', createdAt: new Date().toISOString(), read: false, requiresAck: true, acknowledged: false, requestId: 'r-1' })
      d.invoices.unshift({ id: 'i-x', requestId: 'r-1', clientId: 'u-client-1', qbInvoiceNumber: 'INV-9', amount: 99.5, status: 'sent', bankTransferRef: '', dueDate: '2030-01-01', createdAt: new Date().toISOString() })
      d.projects.find((p) => p.id === 'pr-1')!.expenses.find((e) => e.id === 'e-3')!.status = 'approved'
      d.smsSettings.recipients = ['+61400000000']
      d.bank.bsb = '063-000'
    })
    const d = await fetchAll(admin)
    assert.equal(d.requests.find((x) => x.id === 'r-1')!.assignedProviderId, 'u-prov-3')
    assert.equal(d.invoices.find((x) => x.id === 'i-x')!.amount, 99.5)
    assert.deepEqual(d.smsSettings.recipients, ['+61400000000'])
    assert.equal(d.bank.bsb, '063-000')
    // Admins can message a trade's inbox and read it back (they can open the trade's dashboard).
    assert.ok(d.inbox.some((m) => m.id === 'n-x'))
  })

  test('reloading produces no spurious changes', async () => {
    const d = await fetchAll(admin)
    assert.deepEqual(diff(d, structuredClone(d)), [])
  })

  test("clients with job history can't be deleted; a deleted trade's jobs and expenses are kept", async () => {
    await assert.rejects(pool.query(`delete from profiles where id = 'u-client-1'`), /jobs or invoices on record/)
    // Jobs alone are enough: deleting would otherwise erase them along with the client.
    assert.equal((await pool.query(`select count(*)::int n from invoices where client_id = 'u-client-2'`)).rows[0].n, 0)
    await assert.rejects(asUser(uid.admin, `delete from profiles where id = 'u-client-2'`), /jobs or invoices on record/)
    assert.equal((await pool.query(`select count(*)::int n from projects where client_id = 'u-client-2'`)).rows[0].n > 0, true)
    await pool.query(`delete from profiles where id = 'u-prov-1'`)
    const e = (await fetchAll(admin)).projects.find((p) => p.id === 'pr-1')!.expenses
    assert.equal(e.length, 4)
    assert.ok(e.every((x) => x.providerId === ''))
    const jobs = (await fetchAll(admin)).requests.filter((r) => ['r-2', 'r-4'].includes(r.id))
    assert.equal(jobs.length, 2)
    assert.ok(jobs.every((r) => r.assignedProviderId === undefined))
  })

  test("a client can't delete a property that has job history", async () => {
    await assert.rejects(
      mutate(sarah, (d) => {
        d.properties = d.properties.filter((p) => p.id !== 'p-2')
      }),
      /foreign key/,
    )
  })

  test('deleting a project removes its milestones and expenses', async () => {
    await mutate(admin, (d) => {
      d.projects = d.projects.filter((p) => p.id !== 'pr-q')
    })
    const d = await fetchAll(admin)
    assert.ok(!d.projects.some((p) => p.id === 'pr-q'))
  })
})

describe('admins acting in a client or trade dashboard', () => {
  test('records who really created a job, quote or expense, and it cannot be changed', async () => {
    // A client lodging their own request is recorded as them, whatever the app sends.
    const own = await asUser<{ created_by: string }>(
      uid.sarah,
      `insert into requests (client_id, property_id, title, category, created_by) values ('u-client-1', 'p-1', 'Gutter', 'Handyman', 'u-admin') returning created_by`,
    )
    assert.equal(own.rows[0].created_by, 'u-client-1')
    // An admin lodging one from the client's dashboard is recorded as the admin.
    const forClient = await asUser<{ id: string; created_by: string }>(
      uid.admin,
      `insert into requests (client_id, property_id, title, category, created_by) values ('u-client-1', 'p-1', 'Leaking tap', 'Plumbing', 'u-client-1') returning id, created_by`,
    )
    assert.equal(forClient.rows[0].created_by, 'u-admin')
    const quote = await asUser<{ created_by: string }>(uid.admin, `insert into projects (client_id, property_id, title) values ('u-client-1', 'p-1', 'Deck') returning created_by`)
    assert.equal(quote.rows[0].created_by, 'u-admin')
    const expense = await asUser<{ created_by: string }>(
      uid.admin,
      `insert into project_expenses (project_id, provider_id, date, description, category, amount) values ('pr-1', 'u-prov-3', '2030-01-02', 'Glue', 'Materials', 12) returning created_by`,
    )
    assert.equal(expense.rows[0].created_by, 'u-admin')
    // Nobody signed in through the app can rewrite it afterwards.
    const later = await asUser<{ created_by: string }>(
      uid.admin,
      `update requests set created_by = 'u-client-1', title = 'Leaking tap (kitchen)' where id = $1 returning created_by`,
      [forClient.rows[0].id],
    )
    assert.equal(later.rows[0].created_by, 'u-admin')
  })

  test('the synced app data carries who created each record', async () => {
    const d = await fetchAll(admin)
    assert.ok(d.requests.some((r) => r.title === 'Leaking tap (kitchen)' && r.createdBy === 'u-admin'))
    assert.ok(d.requests.some((r) => r.title === 'Gutter' && r.createdBy === 'u-client-1'))
  })

  test("admins can read and acknowledge a trade's inbox; other people still cannot", async () => {
    const msgs = await asUser<{ id: string }>(uid.admin, `select id from inbox where user_id = 'u-prov-3'`)
    assert.ok(msgs.rows.length > 0)
    const ack = await asUser<{ acknowledged_by: string }>(
      uid.admin,
      `update inbox set acknowledged = true, read = true where id = $1 returning acknowledged_by`,
      [msgs.rows[0].id],
    )
    assert.equal(ack.rowCount, 1)
    // Recorded as the admin, not the trade, and the app can't say otherwise.
    assert.equal(ack.rows[0].acknowledged_by, 'u-admin')
    await assert.rejects(asUser(uid.admin, `update inbox set acknowledged_by = 'u-prov-3' where id = $1`, [msgs.rows[0].id]), /Only read and acknowledged/)
    const d = await fetchAll(admin)
    assert.equal(d.inbox.find((m) => m.id === msgs.rows[0].id)?.acknowledgedBy, 'u-admin')
    await assert.rejects(asUser(uid.admin, `update inbox set title = 'x' where id = $1`, [msgs.rows[0].id]), /Only read and acknowledged/)
    const other = await asUser(uid.sarah, `select id from inbox where user_id = 'u-prov-3'`)
    assert.equal(other.rowCount, 0)
    // Only trades' inboxes: not clients' or other admins' (no dashboard shows them).
    await asUser(uid.admin, `insert into inbox (user_id, title, body) values ('u-client-1', 'For Sarah', 'x'), ('u-office', 'For Office', 'x')`)
    const seen = await asUser<{ title: string }>(uid.admin, `select title from inbox where title in ('For Sarah', 'For Office')`)
    assert.equal(seen.rowCount, 0)
    const marked = await asUser(uid.admin, `update inbox set read = true where title in ('For Sarah', 'For Office')`)
    assert.equal(marked.rowCount, 0)
    assert.equal((await asUser(uid.sarah, `select id from inbox where title = 'For Sarah'`)).rowCount, 1)
  })

  test('records who last accepted or rejected a quote, and clears it when the quote is issued again', async () => {
    type Q = { id: string; status: string; quote_decided_by: string | null; quote_decision: string | null }
    const quoted = `insert into projects (client_id, property_id, title, status, quote_amount, quote_decided_by, quote_decision)
      values ('u-client-1', 'p-1', $1, 'quoted', 5000, 'u-client-1', 'approved') returning id, status, quote_decided_by, quote_decision`
    const set = (who: string, id: string, sql: string) =>
      asUser<Q>(who, `update projects set ${sql} where id = $1 returning id, status, quote_decided_by, quote_decision`, [id]).then((r) => r.rows[0])
    const a = (await asUser<Q>(uid.admin, quoted, ['Fence'])).rows[0]
    assert.deepEqual([a.quote_decided_by, a.quote_decision], [null, null])
    // The client answers their own quote, and can't write the record themselves.
    await assert.rejects(set(uid.sarah, a.id, `quote_decided_by = 'u-admin'`), /accept or decline/)
    await assert.rejects(set(uid.sarah, a.id, `quote_decision = 'rejected'`), /accept or decline/)
    const mine = await set(uid.sarah, a.id, `status = 'approved'`)
    assert.deepEqual([mine.quote_decided_by, mine.quote_decision], ['u-client-1', 'approved'])
    // Carrying on with the project keeps it, and so does moving it back to approved.
    const started = await set(uid.admin, a.id, `status = 'in_progress', quote_decided_by = null, quote_decision = null`)
    assert.deepEqual([started.quote_decided_by, started.quote_decision], ['u-client-1', 'approved'])
    const back = await set(uid.admin, a.id, `status = 'approved'`)
    assert.deepEqual([back.quote_decided_by, back.quote_decision], ['u-client-1', 'approved'])
    // An admin answers one from the client's dashboard.
    const b = (await asUser<Q>(uid.admin, quoted, ['Pergola'])).rows[0]
    const declined = await set(uid.admin, b.id, `status = 'rejected'`)
    assert.deepEqual([declined.quote_decided_by, declined.quote_decision], ['u-admin', 'rejected'])
    // The office re-issues a revised quote: nobody has answered that one yet.
    const reissued = await set(uid.admin, b.id, `status = 'quoted', quote_amount = 4500`)
    assert.deepEqual([reissued.quote_decided_by, reissued.quote_decision], [null, null])
    // The client accepts it, then the office cancels the job: the record follows whoever did each.
    assert.equal((await set(uid.sarah, b.id, `status = 'approved'`)).quote_decided_by, 'u-client-1')
    const cancelled = await set(uid.admin, b.id, `status = 'rejected'`)
    assert.deepEqual([cancelled.quote_decided_by, cancelled.quote_decision], ['u-admin', 'rejected'])
    // Reopening a rejected job, or moving a quote straight into work after a phone call, counts as
    // accepting it, by whoever did it.
    const c = (await asUser<Q>(uid.admin, quoted, ['Shed'])).rows[0]
    const phoned = await set(uid.admin, c.id, `status = 'in_progress'`)
    assert.deepEqual([phoned.quote_decided_by, phoned.quote_decision], ['u-admin', 'approved'])
    const d = await fetchAll(admin)
    const p = d.projects.find((x) => x.id === b.id)
    assert.deepEqual([p?.quoteDecidedBy, p?.quoteDecision], ['u-admin', 'rejected'])
    const reopened = await set(uid.admin, b.id, `status = 'in_progress'`)
    assert.deepEqual([reopened.quote_decided_by, reopened.quote_decision], ['u-admin', 'approved'])
  })

  test("an admin who did work for other people can't be deleted; other accounts delete as before", async () => {
    // The office admin acknowledges a trade's work order from the trade's dashboard.
    const msg = await asUser<{ id: string }>(uid.admin, `insert into inbox (user_id, title, body, requires_ack) values ('u-prov-3', 'WO', 'x', true) returning id`)
    await asUser(uid.office, `update inbox set acknowledged = true where id = $1`, [msg.rows[0].id])
    await assert.rejects(asUser(uid.admin, `delete from profiles where id = 'u-office'`), (e: Error & { code?: string }) => {
      assert.equal(e.code, '23503')
      assert.match(e.message, /done work for other people on record/)
      return true
    })
    // Nor through the server (service role).
    await assert.rejects(pool.query(`delete from profiles where id = 'u-office'`), /done work for other people/)
    assert.equal((await pool.query(`select acknowledged_by from inbox where id = $1`, [msg.rows[0].id])).rows[0].acknowledged_by, 'u-office')
    // Accounts with only their own records still delete (like the trade deleted earlier), and so does a new admin.
    await mutate(admin, (d) => {
      d.users.push({ id: 'u-temp', name: 'Temp', email: 'temp@example.com', role: 'admin', phone: '', permissions: [], createdAt: new Date().toISOString(), status: 'invited', passwordHash: '' })
    })
    const del = await asUser(uid.admin, `delete from profiles where id = 'u-temp'`)
    assert.equal(del.rowCount, 1)
  })
})

describe('clients added without a login', () => {
  const noLogin = (id: string, name: string, email = '') => ({
    id,
    name,
    email,
    role: 'client' as const,
    phone: '0400 000 000',
    permissions: ['canSubmitRequests' as const],
    createdAt: new Date().toISOString(),
    status: 'invited' as const,
    passwordHash: '',
  })

  test('admins add clients with no email or login, and record a property and project for them', async () => {
    await mutate(admin, (d) => {
      d.users.push(noLogin('u-nl-1', 'Olive Nolan'), noLogin('u-nl-2', 'Pete No-Email'))
      d.properties.push({ ...d.properties[0], id: 'p-nl-1', clientId: 'u-nl-1', address: '5 Quiet Lane', suburb: 'Kew', postcode: '3101' })
    })
    await asUser(uid.admin, `insert into projects (id, client_id, property_id, title, status) values ('pr-nl-1', 'u-nl-1', 'p-nl-1', 'Deck rebuild', 'in_progress')`)
    const d = await fetchAll(admin)
    const olive = d.users.find((u) => u.id === 'u-nl-1')!
    assert.equal(olive.email, '')
    assert.equal(olive.hasLogin, false)
    assert.equal(d.users.find((u) => u.id === 'u-nl-2')!.email, '')
    assert.equal(d.projects.find((p) => p.id === 'pr-nl-1')!.createdBy, 'u-admin')
    // Nothing to reload: no spurious changes for accounts without an email.
    assert.deepEqual(diff(d, structuredClone(d)), [])
  })

  test("nobody can sign up as them, even once their email is saved; an admin's invite links the login", async () => {
    await assert.rejects(createAuthUser('olive@example.com'), /No Next Phase Maintenance invitation/)
    await mutate(admin, (d) => {
      d.users.find((u) => u.id === 'u-nl-1')!.email = 'olive@example.com'
    })
    // A sign-up with the right email isn't enough: someone who knows it can't claim the account.
    await assert.rejects(createAuthUser('olive@example.com'), /No Next Phase Maintenance invitation/)
    // Only the invite-user function (service role) can allow a login; the app can't.
    await asUser(uid.admin, `update profiles set login_invited = true where id = 'u-nl-1'`)
    await asUser(uid.admin, `insert into profiles (id, name, email, role, login_invited) values ('u-nl-3', 'Sneaky', 'sneaky@example.com', 'client', true)`)
    const flags = await pool.query<{ id: string; login_invited: boolean }>(`select id, login_invited from profiles where id in ('u-nl-1', 'u-nl-3') order by id`)
    assert.deepEqual(flags.rows.map((r) => r.login_invited), [false, false])
    await assert.rejects(createAuthUser('sneaky@example.com'), /No Next Phase Maintenance invitation/)
    // Changing the email before the login exists withdraws an invite.
    await pool.query(`update profiles set login_invited = true where id = 'u-nl-3'`)
    await asUser(uid.admin, `update profiles set email = 'sneaky2@example.com' where id = 'u-nl-3'`)
    assert.equal((await pool.query(`select login_invited from profiles where id = 'u-nl-3'`)).rows[0].login_invited, false)

    // Inviting creates the login, which is linked to the account by email.
    uid.olive = await inviteAuthUser('olive@example.com')
    assert.equal((await fetchAll(admin)).users.find((u) => u.id === 'u-nl-1')!.hasLogin, true)
    await asUser(uid.olive, 'select activate_my_account()')
    const mine = await fetchAll(adapter(uid.olive))
    assert.deepEqual(mine.properties.map((p) => p.id), ['p-nl-1'])
    assert.deepEqual(mine.projects.map((p) => p.title), ['Deck rebuild'])
    // Once there's a login, the email it signs in with can't be changed or cleared through the app.
    await assert.rejects(asUser(uid.admin, `update profiles set email = 'olive.new@example.com' where id = 'u-nl-1'`), /can’t change once the account has a login/)
    await assert.rejects(asUser(uid.admin, `update profiles set email = null where id = 'u-nl-1'`), /can’t change once the account has a login/)
    await asUser(uid.admin, `update profiles set name = 'Olive N.' where id = 'u-nl-1'`)
    // An account with a login always keeps an email (even for the server).
    await assert.rejects(pool.query(`update profiles set email = null where id = 'u-nl-1'`), /profiles_login_has_email/)
  })

  test('deleting a login in Supabase withdraws the invite, so a sign-up with that email is refused', async () => {
    await pool.query(`delete from auth.users where id = $1`, [uid.olive])
    const p = await pool.query<{ auth_id: string | null; login_invited: boolean }>(`select auth_id, login_invited from profiles where id = 'u-nl-1'`)
    assert.deepEqual(p.rows[0], { auth_id: null, login_invited: false })
    await assert.rejects(createAuthUser('olive@example.com'), /No Next Phase Maintenance invitation/)
    // A fresh invite from the app gives her a login again.
    uid.olive = await inviteAuthUser('olive@example.com')
    assert.equal((await fetchAll(admin)).users.find((u) => u.id === 'u-nl-1')!.hasLogin, true)
  })
})

/** Runs SQL as a signed-out visitor, like the public store page does. */
async function asAnon<T>(sql: string, params: unknown[] = [], ip?: string): Promise<pg.QueryResult<T & pg.QueryResultRow>> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role anon')
    // PostgREST passes the request's headers; Cloudflare sets cf-connecting-ip to the visitor's address.
    if (ip) await c.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ 'cf-connecting-ip': ip })])
    const r = await c.query<T & pg.QueryResultRow>(sql, params)
    await c.query('commit')
    return r
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

describe('store', () => {
  const order = (items: unknown, email: string, extra = '') =>
    `select place_order('${JSON.stringify(items)}'::jsonb, 'Jo Buyer', '${email}', '0400 111 222', 'pickup'${extra}) as r`

  before(async () => {
    await asUser(
      uid.admin,
      `insert into products (id, title, category, sku, price, status, stock) values
        ('sp-1', 'Timber vanity 900', 'Vanities', 'VAN-900', 1200, 'published', 'in_stock'),
        ('sp-2', 'Frameless screen', 'Shower screens', 'SCR-1', 800, 'published', 'to_order'),
        ('sp-3', 'Secret tap', 'Tapware', 'TAP-X', 300, 'draft', 'in_stock'),
        ('sp-4', 'Sold-out mixer', 'Tapware', 'TAP-Y', 250, 'published', 'out_of_stock')`,
    )
    await asUser(uid.admin, `insert into product_trade_prices (id, price) values ('sp-1', 950), ('sp-3', 200)`)
    await asUser(uid.admin, `insert into product_sources (id, supplier, cost, source_url) values ('sp-1', 'Acme Wholesale', 700, 'https://example.com/v900')`)
    // A trade with a login, to order at trade prices.
    await mutate(admin, (d) => {
      d.users.push({ id: 'u-trade', name: 'Tia Trade', email: 'tia@example.com', role: 'provider', phone: '', permissions: ['canSubmitExpenses'], createdAt: new Date().toISOString(), status: 'invited', passwordHash: '' })
    })
    uid.tia = await inviteAuthUser('tia@example.com')
    await asUser(uid.tia, 'select activate_my_account()')
  })

  test('the owner can manage the store; products record who added them', async () => {
    const perms = await asUser<{ ok: boolean }>(uid.admin, `select has_perm('canManageStore') as ok`)
    assert.equal(perms.rows[0].ok, true)
    assert.equal((await pool.query(`select created_by from products where id = 'sp-1'`)).rows[0].created_by, 'u-admin')
    await assert.rejects(asUser(uid.sarah, `insert into products (title, price) values ('x', 1)`), /row-level security/)
  })

  test('visitors and clients see published products only, and no trade prices or supplier details', async () => {
    const pub = await asAnon<{ id: string }>(`select id from products order by id`)
    assert.deepEqual(pub.rows.map((r) => r.id), ['sp-1', 'sp-2', 'sp-4'])
    assert.equal((await asAnon(`select * from product_trade_prices`)).rowCount, 0)
    assert.equal((await asAnon(`select * from product_sources`)).rowCount, 0)
    assert.equal((await asAnon(`select * from orders`)).rowCount, 0)
    const client = await asUser<{ id: string }>(uid.sarah, `select id from products order by id`)
    assert.deepEqual(client.rows.map((r) => r.id), ['sp-1', 'sp-2', 'sp-4'])
    assert.equal((await asUser(uid.sarah, `select * from product_trade_prices`)).rowCount, 0)
    assert.equal((await asUser(uid.sarah, `select * from product_sources`)).rowCount, 0)
  })

  test('service providers see trade prices of published products only; store managers see everything', async () => {
    const trade = await asUser<{ id: string }>(uid.tia, `select id from product_trade_prices`)
    assert.deepEqual(trade.rows.map((r) => r.id), ['sp-1'])
    assert.equal((await asUser(uid.tia, `select * from product_sources`)).rowCount, 0)
    assert.equal((await asUser(uid.admin, `select * from products`)).rowCount, 4)
    assert.equal((await asUser(uid.admin, `select * from product_sources`)).rowCount, 1)
  })

  test('anyone can order; prices come from the database (trade for service providers)', async () => {
    const guest = await asAnon<{ r: { number: number; total: string } }>(order([{ product_id: 'sp-1', qty: 1 }, { product_id: 'sp-2', qty: 2 }, { product_id: 'sp-1', qty: 1 }], 'jo@example.com'))
    assert.ok(guest.rows[0].r.number >= 5001)
    // The vanity has a cost ($700), so it's priced by the price structure: $1,000 public (30% margin),
    // $934 for clients (25%), $844 for trades (17%), rounded up to the dollar.
    assert.equal(Number(guest.rows[0].r.total), 2 * 1000 + 2 * 800)
    const g = await pool.query(`select customer_id, trade, status from orders where number = $1`, [guest.rows[0].r.number])
    assert.deepEqual(g.rows[0], { customer_id: null, trade: false, status: 'new' })
    assert.equal((await pool.query(`select count(*)::int n from order_items where order_id = (select id from orders where number = $1)`, [guest.rows[0].r.number])).rows[0].n, 2)

    const tia = await asUser<{ r: { number: number; total: string } }>(uid.tia, order([{ product_id: 'sp-1', qty: 2 }, { product_id: 'sp-2', qty: 1 }], 'tia@example.com'))
    assert.equal(Number(tia.rows[0].r.total), 2 * 844 + 800)
    const sarahOrder = await asUser<{ r: { number: number; total: string } }>(uid.sarah, order([{ product_id: 'sp-1', qty: 1 }], 'sarah@whitfieldproperty.com.au'))
    assert.equal(Number(sarahOrder.rows[0].r.total), 934)

    // Members see their own orders and items; nobody else's.
    const mine = await asUser<{ number: number }>(uid.sarah, `select number from orders`)
    assert.deepEqual(mine.rows.map((r) => r.number), [sarahOrder.rows[0].r.number])
    assert.equal((await asUser(uid.sarah, `select * from order_items`)).rowCount, 1)
    assert.equal((await asUser(uid.tia, `select * from orders`)).rowCount, 1)
    // Every active admin hears about it.
    assert.ok((await asUser<{ title: string }>(uid.admin, `select title from inbox where title = 'New store order #${tia.rows[0].r.number}'`)).rowCount === 1)
  })

  test('orders are checked: drafts, sold-out items, bad details and empty carts are refused', async () => {
    await assert.rejects(asAnon(order([{ product_id: 'sp-3', qty: 1 }], 'a@example.com')), /No longer available: Secret tap/)
    await assert.rejects(asAnon(order([{ product_id: 'sp-4', qty: 1 }], 'a@example.com')), /No longer available: Sold-out mixer/)
    await assert.rejects(asAnon(order([{ product_id: 'nope', qty: 1 }], 'a@example.com')), /No longer available/)
    await assert.rejects(asAnon(order([], 'a@example.com')), /cart is empty/)
    await assert.rejects(asAnon(order([{ product_id: 'sp-1', qty: 0 }], 'a@example.com')), /quantity from 1 to 99/)
    await assert.rejects(asAnon(order([{ product_id: 'sp-1', qty: 1 }], 'not-an-email')), /valid email/)
    await assert.rejects(
      asAnon(`select place_order('[{"product_id":"sp-1","qty":1}]'::jsonb, 'Jo', 'jo2@example.com', '0400 111 222', 'delivery', '') as r`),
      /delivery address/,
    )
    // Same-day and Australia-wide delivery need an address too; anything else isn't a delivery option.
    for (const d of ['same_day', 'australia']) {
      await assert.rejects(
        asAnon(`select place_order('[{"product_id":"sp-1","qty":1}]'::jsonb, 'Jo', 'jo2@example.com', '0400 111 222', '${d}', '') as r`),
        /delivery address/,
      )
    }
    await assert.rejects(
      asAnon(`select place_order('[{"product_id":"sp-1","qty":1}]'::jsonb, 'Jo', 'jo2@example.com', '0400 111 222', 'drone', '1 A St') as r`),
      /delivery option/,
    )
    // Installation is Melbourne only: not with Australia-wide delivery.
    await assert.rejects(
      asAnon(`select place_order('[{"product_id":"sp-1","qty":1,"install":true}]'::jsonb, 'Jo', 'jo2@example.com', '0400 111 222', 'australia', '1 Main St, Perth WA') as r`),
      /metro Melbourne only/,
    )
    // Visitors can't write orders directly.
    await assert.rejects(asAnon(`insert into orders (name, email, phone, delivery, total) values ('x', 'x@x.co', '1', 'pickup', 0)`), /permission denied|row-level security/)
  })

  test('items to install make a quote request linked to the order, on the right client account', async () => {
    type Placed = { r: { id: string; number: number; install_quote: number | null } }
    const quoteFor = async (number: number) =>
      (
        await pool.query(
          `select p.status, p.client_id, p.property_id, p.scope_of_works, c.email, c.role, c.auth_id, pr.address
             from projects p join profiles c on c.id = p.client_id join properties pr on pr.id = p.property_id
            where p.number = $1`,
          [number],
        )
      ).rows[0]
    // Installing needs an address, even for pickup.
    await assert.rejects(asAnon(order([{ product_id: 'sp-1', qty: 1, install: true }], 'inst@example.com')), /address where it.s to be installed/)
    await assert.rejects(asAnon(order([{ product_id: 'sp-1', qty: 1, install: 'yes' }], 'inst@example.com', ", '1 A St'")), /isn.t right/)

    // A guest: the same product supplied only and installed stays as two lines; only the installed one is in the quote.
    const g = await asAnon<Placed>(order([{ product_id: 'sp-1', qty: 1, install: true }, { product_id: 'sp-1', qty: 2 }, { product_id: 'sp-2', qty: 1 }], 'inst@example.com', ", '12 Smith St, Fitzroy'"))
    assert.ok(g.rows[0].r.install_quote)
    const items = await pool.query(`select qty, install from order_items where order_id = $1 order by install, qty`, [g.rows[0].r.id])
    assert.deepEqual(items.rows, [{ qty: 1, install: false }, { qty: 2, install: false }, { qty: 1, install: true }])
    const q = await quoteFor(g.rows[0].r.install_quote!)
    assert.equal(q.status, 'quote_requested')
    assert.equal(q.email, 'inst@example.com')
    assert.equal(q.role, 'client')
    assert.equal(q.auth_id, null)
    assert.equal(q.address, '12 Smith St, Fitzroy')
    assert.match(q.scope_of_works, /1 × Timber vanity 900/)
    assert.doesNotMatch(q.scope_of_works, /Frameless screen/)
    assert.equal((await pool.query(`select order_id from projects where number = $1`, [g.rows[0].r.install_quote])).rows[0].order_id, g.rows[0].r.id)
    // The office hears it needs pricing.
    assert.equal((await asUser(uid.admin, `select 1 from inbox where title = 'New store order #${g.rows[0].r.number}' and body like '%quote #${g.rows[0].r.install_quote}%'`)).rowCount, 1)

    // The same guest again: same client account and property, a new quote.
    const g2 = await asAnon<Placed>(order([{ product_id: 'sp-2', qty: 1, install: true }], 'INST@example.com', ", '12 Smith St, Fitzroy'"))
    const q2 = await quoteFor(g2.rows[0].r.install_quote!)
    assert.equal(q2.client_id, q.client_id)
    assert.equal(q2.property_id, q.property_id)

    // Supply only: no quote.
    assert.equal((await asAnon<Placed>(order([{ product_id: 'sp-1', qty: 1 }], 'inst@example.com'))).rows[0].r.install_quote, null)

    // A guest using a member's email can't add requests to that member's portal.
    const sarahId = (await pool.query(`select id from profiles where lower(email) = 'sarah@whitfieldproperty.com.au'`)).rows[0].id
    const before = (await asUser(uid.sarah, `select id from projects`)).rowCount
    const spoof = await asAnon<Placed>(order([{ product_id: 'sp-1', qty: 1, install: true }], 'sarah@whitfieldproperty.com.au', ", '1 Fake St'"))
    const sq = await quoteFor(spoof.rows[0].r.install_quote!)
    assert.notEqual(sq.client_id, sarahId)
    assert.equal(sq.email, null)
    assert.equal((await asUser(uid.sarah, `select id from projects`)).rowCount, before)

    // A signed-in client's request goes on their own account, and they see it.
    const own = await asUser<Placed>(uid.sarah, order([{ product_id: 'sp-1', qty: 1, install: true }], 'sarah@whitfieldproperty.com.au', ", '8 Home Rd, Kew'"))
    assert.equal((await quoteFor(own.rows[0].r.install_quote!)).client_id, sarahId)
    assert.equal((await asUser(uid.sarah, `select id from projects where order_id = '${own.rows[0].r.id}'`)).rowCount, 1)

    await pool.query(`delete from projects where order_id is not null`)
    await pool.query(`delete from orders where id = $1`, [own.rows[0].r.id])
    await pool.query(`delete from properties where notes like 'From store order #%'`)
    await pool.query(`delete from profiles where role = 'client' and auth_id is null and (lower(email) = 'inst@example.com' or (email is null and name = 'Jo Buyer'))`)
  })

  test('one email can only place a few orders an hour', async () => {
    for (let i = 0; i < 5; i++) await asAnon(order([{ product_id: 'sp-1', qty: 1 }], 'flood@example.com'))
    await assert.rejects(asAnon(order([{ product_id: 'sp-1', qty: 1 }], 'FLOOD@example.com')), /Too many orders/)
  })

  test('limits are per visitor: one flooding the form doesn’t block anyone else', async () => {
    const one = [{ product_id: 'sp-1', qty: 1 }]
    for (let i = 0; i < 5; i++) await asAnon(order(one, `bot${i}@example.com`), [], '203.0.113.7')
    await assert.rejects(asAnon(order(one, 'bot9@example.com'), [], '203.0.113.7'), /Too many orders/)
    await asAnon(order(one, 'real@example.com'), [], '198.51.100.2')
    // Visitors using a member's email don't stop the member ordering when signed in.
    for (let i = 0; i < 5; i++) await asAnon(order(one, 'tia@example.com'), [], `192.0.2.${i}`)
    await asUser(uid.tia, order(one, 'tia@example.com', ", '', 'member-test'"))
    // Where visitors' orders came from can't be read through the API, even by admins.
    await assert.rejects(asAnon('select * from order_attempts'), /permission denied/)
    await assert.rejects(asUser(uid.admin, 'select * from order_attempts'), /permission denied/)
    // A backstop on all visitors' orders together still holds.
    const recent = Number((await pool.query(`select count(*) from orders where customer_id is null and created_at > now() - interval '10 minutes'`)).rows[0].count)
    for (let i = recent; i < 100; i++) await asAnon(order(one, `cap${i}@example.com`), [], `10.9.${Math.floor(i / 250)}.${i % 250}`)
    await assert.rejects(asAnon(order(one, 'late@example.com'), [], '10.10.0.1'), /Too many orders/)
    await pool.query(`delete from orders where email like 'cap%@example.com' or email like 'bot%@example.com' or email = 'real@example.com' or (email = 'tia@example.com' and (customer_id is null or notes = 'member-test'))`)
  })

  test('a cart over 30 different products says so', async () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ product_id: `x${i}`, qty: 1 }))
    await assert.rejects(asAnon(order(many, 'many@example.com')), /Up to 30 different products/)
    await assert.rejects(asAnon(order([], 'none@example.com')), /Your cart is empty/)
  })

  test('store managers move orders along but cannot change what was ordered', async () => {
    const o = (await pool.query<{ id: string }>(`select id from orders where email = 'jo@example.com'`)).rows[0]
    const upd = await asUser(uid.admin, `update orders set status = 'confirmed' where id = $1 returning id`, [o.id])
    assert.equal(upd.rowCount, 1)
    await asUser(uid.admin, `insert into order_notes (id, notes) values ($1, 'Called Jo')`, [o.id])
    await assert.rejects(asUser(uid.admin, `update orders set total = 1 where id = $1`, [o.id]), /Only an order's status can be changed/)
    assert.equal((await asUser(uid.sarah, `update orders set status = 'paid' where id = $1 returning id`, [o.id])).rowCount, 0)
    assert.equal((await asUser(uid.sarah, `update orders set status = 'cancelled' returning id`)).rowCount, 0)
  })
})

describe('store through the app', () => {
  test('store managers edit products, trade prices and supplier details; each person loads what they may see', async () => {
    await mutate(admin, (d) => {
      const v = d.products.find((p) => p.id === 'sp-2')!
      v.price = 820
      v.tradePrice = 650
      // Priced by hand: automatic pricing off.
      v.source = { supplier: 'Glass Co', url: 'https://example.com/screen', cost: 400, notes: '', autoPrice: false }
      d.products.push({
        id: 'sp-new', title: 'Towel rail', description: '', category: 'Accessories', brand: '', sku: 'TR-1', price: 99,
        images: [], status: 'published', stock: 'in_stock', createdAt: new Date().toISOString(),
      })
    })
    const a = await fetchAll(admin)
    const screen = a.products.find((p) => p.id === 'sp-2')!
    assert.deepEqual([screen.price, screen.tradePrice, screen.source?.supplier, screen.source?.cost], [820, 650, 'Glass Co', 400])
    assert.equal(a.products.find((p) => p.id === 'sp-new')!.createdBy, 'u-admin')
    assert.deepEqual(diff(a, structuredClone(a)), [])

    const t = await fetchAll(adapter(uid.tia))
    assert.equal(t.products.find((p) => p.id === 'sp-2')!.tradePrice, 650)
    assert.equal(t.products.find((p) => p.id === 'sp-2')!.source, undefined)
    assert.equal(t.products.some((p) => p.status !== 'published'), false)
    const c = await fetchAll(sarah)
    assert.equal(c.products.find((p) => p.id === 'sp-2')!.tradePrice, undefined)
    assert.ok(c.orders.length === 1 && c.orders[0].items.length === 1)
    // A client changing an order (e.g. through the API) does nothing.
    await assert.rejects(mutate(sarah, (d) => { d.orders[0].status = 'paid' }), /permission/)
  })

  test('store managers update an order\'s status and notes through the app', async () => {
    await mutate(admin, (d) => {
      const o = d.orders.find((x) => x.email === 'tia@example.com')!
      o.status = 'paid'
      o.adminNotes = 'Paid by transfer'
    })
    const o = (await fetchAll(admin)).orders.find((x) => x.email === 'tia@example.com')!
    assert.deepEqual([o.status, o.adminNotes, o.trade], ['paid', 'Paid by transfer', true])
    // The customer sees the new status but never the office's notes, even reading the tables directly.
    const mine = (await fetchAll(adapter(uid.tia))).orders.find((x) => x.id === o.id)!
    assert.deepEqual([mine.status, mine.adminNotes], ['paid', ''])
    assert.equal((await asUser(uid.tia, `select * from order_notes`)).rowCount, 0)
    assert.ok(!JSON.stringify((await asUser(uid.tia, `select to_jsonb(o) j from orders o`)).rows).includes('Paid by transfer'))
    assert.equal((await asUser(uid.tia, `insert into order_notes (id, notes) select id, 'mine' from orders returning id`).catch(() => ({ rowCount: 0 }))).rowCount, 0)
    // Clearing the note removes it.
    await mutate(admin, (d) => { d.orders.find((x) => x.id === o.id)!.adminNotes = '' })
    assert.equal((await pool.query(`select count(*)::int n from order_notes where id = $1`, [o.id])).rows[0].n, 0)
  })
})

describe('construction: quotes, variations, payments and costs', () => {
  test('the office loads the itemised quote, variations, payment schedule and costs', async () => {
    const p = (await fetchAll(admin)).projects.find((x) => x.id === 'pr-1')!
    assert.equal(p.quoteItems.length, 17)
    // Added variations always start as proposed; the office can record the client's answer.
    assert.deepEqual(p.variations.map((v) => [v.number, v.status]), [[1, 'proposed'], [2, 'proposed']])
    await mutate(admin, (d) => {
      d.projects.find((x) => x.id === 'pr-1')!.variations.find((x) => x.id === 'v-1')!.status = 'approved'
    })
    const v1 = (await fetchAll(admin)).projects.find((x) => x.id === 'pr-1')!.variations.find((x) => x.id === 'v-1')!
    assert.equal(v1.status, 'approved')
    assert.equal(v1.decidedBy, 'u-admin')
    assert.equal(p.payments.length, 4)
    assert.equal(p.payments[0].invoiceId, 'i-3')
    assert.equal(p.costs.length, 2)
    assert.ok(p.quoteInclusions)
  })

  test('the client sees their quote, variations and payments but not costs', async () => {
    const mine = (await fetchAll(sarah)).projects.find((x) => x.id === 'pr-1')!
    assert.equal(mine.quoteItems.length, 17)
    assert.equal(mine.variations.length, 2)
    assert.equal(mine.payments.length, 4)
    assert.equal(mine.costs.length, 0)
  })

  test("a quote's lines stay hidden from the client until it's issued", async () => {
    await mutate(admin, (d) => {
      d.projects.find((x) => x.id === 'pr-2')!.quoteItems.push({ id: 'qi-pr2', section: 'Deck', description: 'Merbau decking', kind: 'materials', qty: 20, unit: 'm²', rate: 140 })
    })
    const before = (await fetchAll(marcus)).projects.find((x) => x.id === 'pr-2')!
    assert.equal(before.quoteItems.length, 0)
    await mutate(admin, (d) => {
      const p = d.projects.find((x) => x.id === 'pr-2')!
      p.status = 'quoted'
      p.quoteAmount = 3080
    })
    const after = (await fetchAll(marcus)).projects.find((x) => x.id === 'pr-2')!
    assert.equal(after.quoteItems.length, 1)
  })

  test('clients cannot price or add anything', async () => {
    await assert.rejects(
      asUser(uid.sarah, `insert into project_variations (project_id, number, title, amount) values ('pr-1', 9, 'Free upgrade', -5000)`),
      /row-level security/,
    )
    await assert.rejects(asUser(uid.sarah, `insert into project_costs (project_id, date, description, amount) values ('pr-1', current_date, 'x', 1)`), /row-level security/)
    await assert.rejects(
      mutate(sarah, (d) => {
        d.projects.find((x) => x.id === 'pr-1')!.quoteItems[0].rate = 1
      }),
      /permission/,
    )
    await assert.rejects(
      mutate(sarah, (d) => {
        d.projects.find((x) => x.id === 'pr-1')!.payments[2].value = 1
      }),
      /permission/,
    )
  })

  test('the client approves a proposed variation (recorded as them), but cannot change its price or a decided one', async () => {
    await assert.rejects(
      mutate(sarah, (d) => {
        const v = d.projects.find((x) => x.id === 'pr-1')!.variations.find((x) => x.id === 'v-2')!
        v.status = 'approved'
        v.amount = 1
      }),
      /only approve or decline/,
    )
    await assert.rejects(
      mutate(sarah, (d) => {
        d.projects.find((x) => x.id === 'pr-1')!.variations.find((x) => x.id === 'v-1')!.status = 'rejected'
      }),
      /only approve or decline/,
    )
    await mutate(sarah, (d) => {
      d.projects.find((x) => x.id === 'pr-1')!.variations.find((x) => x.id === 'v-2')!.status = 'approved'
    })
    const v = (await fetchAll(admin)).projects.find((x) => x.id === 'pr-1')!.variations.find((x) => x.id === 'v-2')!
    assert.equal(v.status, 'approved')
    assert.equal(v.decidedBy, 'u-client-1')
    assert.ok(v.decidedAt)
  })

  test("the office proposes variations as itself; a decided one can't be changed or removed", async () => {
    await mutate(admin, (d) => {
      d.projects.find((x) => x.id === 'pr-1')!.variations.push({ id: 'v-3', number: 3, title: 'Extra power point', description: '', amount: 180, status: 'approved', createdAt: new Date().toISOString() })
    })
    const v3 = (await fetchAll(admin)).projects.find((x) => x.id === 'pr-1')!.variations.find((x) => x.id === 'v-3')!
    assert.equal(v3.status, 'proposed')
    assert.equal(v3.createdBy, 'u-admin')
    await assert.rejects(
      mutate(admin, (d) => {
        d.projects.find((x) => x.id === 'pr-1')!.variations.find((x) => x.id === 'v-1')!.amount = 10
      }),
      /can’t be changed/,
    )
    const r = await asUser(uid.admin, `delete from project_variations where id = 'v-1'`)
    assert.equal(r.rowCount, 0)
  })

  test("a claimed payment stage keeps its amount and can't be removed; unclaimed ones can change", async () => {
    await assert.rejects(
      mutate(admin, (d) => {
        d.projects.find((x) => x.id === 'pr-1')!.payments.find((s) => s.id === 'ps-1')!.value = 50
      }),
      /has been claimed/,
    )
    const r = await asUser(uid.admin, `delete from project_payments where id = 'ps-1'`)
    assert.equal(r.rowCount, 0)
    await mutate(admin, (d) => {
      const p = d.projects.find((x) => x.id === 'pr-1')!
      p.payments.find((s) => s.id === 'ps-1')!.title = 'Deposit on signing'
      p.payments.find((s) => s.id === 'ps-3')!.value = 35
    })
    const p = (await fetchAll(admin)).projects.find((x) => x.id === 'pr-1')!
    assert.equal(p.payments.find((s) => s.id === 'ps-1')!.title, 'Deposit on signing')
    assert.equal(p.payments.find((s) => s.id === 'ps-3')!.value, 35)
  })
})

describe('website maintenance requests', () => {
  /** A visitor's photo upload, as Supabase Storage does it (the bucket's policies decide). */
  const upload = async (name = `incoming/${crypto.randomUUID()}.jpg`, bucket = 'lead-photos') => {
    await asAnon('insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, name])
    return name
  }
  const send = async (o: { name?: string; email?: string; phone?: string; service?: string; message?: string; photos?: string[]; urgency?: string; ip?: string } = {}) =>
    asAnon<{ r: { number: number } }>(
      `select submit_lead($1, $2, $3, 'Carlton', $4, $5, 'phone', $6, $7::jsonb) as r`,
      [
        o.name ?? 'Jo Visitor',
        o.email ?? 'jo@example.com',
        o.phone ?? '0400 222 333',
        o.service ?? 'Plumbing Services',
        o.urgency ?? 'soon',
        o.message ?? 'Leaking shower',
        JSON.stringify(o.photos ?? [await upload()]),
      ],
      o.ip ?? '203.0.113.9',
    )

  test('with the auto-reply switched on, a visitor who leaves a mobile is texted back straight away', async () => {
    assert.equal((await pool.query(`select 1 from sms_outbox where source = 'lead_autoreply'`)).rowCount, 0, 'off by default')
    await pool.query(`update settings set sms = sms || '{"autoReply": true, "autoReplyMessage": "Hi {first_name}, thanks! We will be in touch."}'`)
    try {
      await send({ name: 'Kim Reply', phone: '0400 555 666', ip: '203.0.113.77' })
      const q = await pool.query<{ to_phone: string; message: string }>(`select to_phone, message from sms_outbox where source = 'lead_autoreply'`)
      assert.deepEqual(q.rows, [{ to_phone: '0400 555 666', message: 'Hi Kim, thanks! We will be in touch.' }])
    } finally {
      await pool.query(`update settings set sms = sms || '{"autoReply": false}'`)
    }
  })

  test('a visitor sends a request with photos; the office is told and sees it, nobody else does', async () => {
    const photos = [await upload(), await upload()]
    const r = await send({ urgency: 'urgent', photos })
    const d = await fetchAll(admin)
    const l = d.leads.find((x) => x.number === r.rows[0].r.number)!
    assert.deepEqual(l.services, ['Plumbing Services'])
    assert.deepEqual([...l.photos].sort(), [...photos].sort())
    assert.equal(l.status, 'new')
    assert.ok(d.inbox.some((m) => m.title === `Urgent request #${l.number}: Jo Visitor` && m.body.includes('2 photos')))
    assert.equal((await fetchAll(sarah)).leads.length, 0)
    assert.equal((await asAnon<{ n: number }>('select count(*)::int as n from leads')).rows[0].n, 0)
  })

  test('only the office can see the photos; visitors can upload only to the request folder', async () => {
    const name = await upload()
    assert.equal((await asAnon<{ n: number }>(`select count(*)::int as n from storage.objects where bucket_id = 'lead-photos'`)).rows[0].n, 0)
    assert.equal((await asUser<{ n: number }>(uid.sarah, `select count(*)::int as n from storage.objects where bucket_id = 'lead-photos'`)).rows[0].n, 0)
    assert.ok((await asUser<{ n: number }>(uid.admin, `select count(*)::int as n from storage.objects where name = $1`, [name])).rows[0].n === 1)
    await assert.rejects(upload('elsewhere/x.jpg'), /row-level security/)
    await assert.rejects(upload(`incoming/${crypto.randomUUID()}.jpg`, 'photos'), /row-level security/)
  })

  test('photo uploads are rate-limited and capped, so visitors cannot fill the storage', async () => {
    const count = async () => Number((await pool.query(`select count(*) from storage.objects where bucket_id = 'lead-photos'`)).rows[0].count)
    const before = await count()
    try {
      // A burst: 300 uploads in the last 10 minutes is the most that is accepted.
      await pool.query(
        `insert into storage.objects (bucket_id, name) select 'lead-photos', 'incoming/' || gen_random_uuid() || '.jpg' from generate_series(1, $1)`,
        [300 - before],
      )
      await assert.rejects(upload(), /row-level security/)
      // Older uploads stop counting towards the burst limit.
      await pool.query(`update storage.objects set created_at = now() - interval '1 hour' where bucket_id = 'lead-photos'`)
      await upload()
    } finally {
      await pool.query(`delete from storage.objects where bucket_id = 'lead-photos'`)
    }
  })

  test('the unused-photo clean-up and quote text claim are in place', async () => {
    assert.equal((await pool.query(`select 1 from pg_proc where proname = 'lead_photo_upload_ok'`)).rowCount, 1)
    assert.equal((await pool.query(`select 1 from information_schema.columns where table_name = 'projects' and column_name = 'quote_sms_notified'`)).rowCount, 1)
  })

  test('visitors cannot add or read requests directly', async () => {
    await assert.rejects(asAnon(`insert into leads (name) values ('x')`), /row-level security/)
    await assert.rejects(asUser(uid.sarah, `insert into leads (name) values ('x')`), /row-level security/)
    await assert.rejects(asAnon('select * from lead_attempts'), /permission denied/)
    // The earlier version without photos is switched off.
    await assert.rejects(asAnon(`select submit_lead('X', 'x@example.com', '', '', '[]'::jsonb, 'soon', 'email', 'hi', '')`), /permission denied/)
  })

  test('requests are checked: one of our services, photos, what needs doing, a name and a way to reply', async () => {
    await assert.rejects(send({ service: '' }), /Choose the service/)
    await assert.rejects(send({ service: 'Pool cleaning' }), /Choose the service/)
    await assert.rejects(send({ photos: [] }), /at least one photo/)
    await assert.rejects(send({ photos: [`incoming/${crypto.randomUUID()}.jpg`] }), /didn’t upload/) // never uploaded
    await assert.rejects(send({ message: ' ' }), /what needs doing/)
    await assert.rejects(send({ name: '' }), /Enter your name/)
    await assert.rejects(send({ email: 'not-an-email' }), /valid email/)
    await assert.rejects(send({ email: '', phone: '' }), /phone number or email/)
    await assert.rejects(send({ phone: '12' }), /valid phone/)
  })

  test("a photo can't be reused on another request", async () => {
    const photo = await upload()
    await send({ name: 'Reuse One', email: 'reuse1@example.com', phone: '0400 555 001', photos: [photo], ip: '192.0.2.1' })
    await assert.rejects(send({ name: 'Reuse Two', email: 'reuse2@example.com', phone: '0400 555 002', photos: [photo], ip: '192.0.2.2' }), /didn’t upload/)
  })

  test('one person can only send a few an hour', async () => {
    for (let i = 0; i < 3; i++) await send({ name: 'Flo', email: 'flood@example.com', phone: '', ip: `198.51.100.${i}` })
    await assert.rejects(send({ name: 'Flo', email: 'flood@example.com', phone: '', ip: '198.51.100.50' }), /already got your request/)
    // Another visitor isn't affected.
    await send({ name: 'Kim', email: 'kim@example.com', phone: '', ip: '198.51.100.60' })
  })

  test('the office updates status, notes and the linked client, but not what was sent', async () => {
    const id = (await fetchAll(admin)).leads.find((l) => l.name === 'Kim')!.id
    await mutate(admin, (d) => {
      const l = d.leads.find((x) => x.id === id)!
      l.status = 'won'
      l.notes = 'Booked in'
      l.clientId = 'u-client-1'
    })
    const l = (await fetchAll(admin)).leads.find((x) => x.id === id)!
    assert.deepEqual([l.status, l.notes, l.clientId], ['won', 'Booked in', 'u-client-1'])
    await assert.rejects(
      mutate(admin, (d) => {
        d.leads.find((x) => x.id === id)!.message = 'changed'
      }),
      /can’t be changed/,
    )
  })
})

describe('text log', () => {
  test('admins record texts opened in Messages; the database says who and when', async () => {
    await mutate(admin, (d) => {
      d.texts.unshift({ id: 'tx-1', to: '0433 555 642', message: 'Work order #1', event: 'Work order #1', openedBy: 'u-client-1', openedAt: '2001-01-01T00:00:00Z' })
    })
    const t = (await fetchAll(admin)).texts.find((x) => x.id === 'tx-1')!
    assert.equal(t.openedBy, 'u-admin')
    assert.ok(new Date(t.openedAt).getFullYear() > 2001)
  })

  test("entries can't be changed or deleted, and only admins see or add them", async () => {
    const upd = await asUser(uid.admin, `update text_log set message = 'changed' where id = 'tx-1'`)
    assert.equal(upd.rowCount, 0)
    const del = await asUser(uid.admin, `delete from text_log where id = 'tx-1'`)
    assert.equal(del.rowCount, 0)
    assert.equal((await fetchAll(admin)).texts.find((x) => x.id === 'tx-1')!.message, 'Work order #1')
    assert.equal((await fetchAll(sarah)).texts.length, 0)
    await assert.rejects(asUser(uid.sarah, `insert into text_log (recipient_phone, message) values ('0400000000', 'x')`), /row-level security/)
  })
})

describe('quotes pipeline', () => {
  test('the database records when a quote is issued and answered; only the office records follow-ups', async () => {
    const before = (await fetchAll(admin)).projects.find((p) => p.id === 'pr-3')!
    assert.ok(before.quoteIssuedAt, 'issued time set when created as an issued quote')
    assert.equal(before.quoteDecidedAt, undefined)
    // The app can't backdate either time.
    await mutate(admin, (d) => {
      const p = d.projects.find((x) => x.id === 'pr-3')!
      p.quoteIssuedAt = '2001-01-01T00:00:00Z'
      p.quoteFollowedUpAt = new Date().toISOString()
    })
    const mid = (await fetchAll(admin)).projects.find((p) => p.id === 'pr-3')!
    assert.equal(mid.quoteIssuedAt, before.quoteIssuedAt)
    assert.ok(mid.quoteFollowedUpAt)
    // A client can't mark it followed up; answering it records when.
    await assert.rejects(asUser(uid.marcus, `update projects set quote_followed_up_at = now() where id = 'pr-3'`), /only accept or decline/)
    await mutate(marcus, (d) => {
      d.projects.find((x) => x.id === 'pr-3')!.status = 'approved'
    })
    const after = (await fetchAll(admin)).projects.find((p) => p.id === 'pr-3')!
    assert.equal(after.quoteDecision, 'approved')
    assert.ok(after.quoteDecidedAt)
    // Issuing it again restarts the clock and clears the answer and follow-up.
    await mutate(admin, (d) => {
      d.projects.find((x) => x.id === 'pr-3')!.status = 'quoted'
    })
    const again = (await fetchAll(admin)).projects.find((p) => p.id === 'pr-3')!
    assert.equal(again.quoteDecidedAt, undefined)
    assert.equal(again.quoteFollowedUpAt, undefined)
    assert.ok(new Date(again.quoteIssuedAt!) >= new Date(after.quoteDecidedAt!))
  })

  test('quote templates are for the office only', async () => {
    await mutate(admin, (d) => {
      d.quoteTemplates.push({ id: 'qt-test', name: 'Deck', items: [{ section: 'Deck', description: 'Decking', kind: 'materials', qty: 20, unit: 'm²', rate: 140 }], inclusions: '', exclusions: '', createdAt: new Date().toISOString() })
    })
    assert.equal((await fetchAll(admin)).quoteTemplates.find((t) => t.id === 'qt-test')!.items.length, 1)
    assert.equal((await fetchAll(sarah)).quoteTemplates.length, 0)
    await assert.rejects(asUser(uid.sarah, `insert into quote_templates (name) values ('x')`), /row-level security/)
  })
})

describe('project workspace: schedule, diary, defects, documents', () => {
  before(async () => {
    uid.tom = await inviteAuthUser('tom@gallagherplumbing.com.au')
    await asUser(uid.tom, 'select activate_my_account()')
  })
  const pr1 = async (db: DbAdapter) => (await fetchAll(db)).projects.find((p) => p.id === 'pr-1')

  test('the office sees and runs everything', async () => {
    const p = (await pr1(admin))!
    assert.equal(p.tasks.length, 9)
    assert.equal(p.diary.length, 2)
    assert.deepEqual(p.defects.map((d) => d.number), [1])
    assert.equal(p.documents.length, 2)
  })

  test("a trade booked for tasks sees the project's whole schedule, the diary, their defects and documents shared with trades", async () => {
    // Tom isn't the project's trade, so he doesn't see the project itself: the app reads these tables directly.
    // He sees every booking on it (who else is on site, and when), on no other project.
    const tasks = await asUser<{ id: string }>(uid.tom, `select id from project_tasks where project_id = 'pr-1' order by id`)
    assert.equal(tasks.rowCount, 9)
    assert.equal((await asUser(uid.tom, `select id from project_tasks where project_id <> 'pr-1'`)).rowCount, 0)
    assert.equal((await asUser(uid.tom, `select id from project_diary where project_id = 'pr-1'`)).rowCount, 2)
    assert.deepEqual((await asUser<{ id: string }>(uid.tom, `select id from project_defects`)).rows.map((r) => r.id), ['df-1'])
    assert.deepEqual((await asUser<{ id: string }>(uid.tom, `select id from project_documents`)).rows.map((r) => r.id), ['doc-1'])
  })

  test('a trade moves their own booking along or to another day (the office is told), but cannot change anything else, or touch others', async () => {
    await asUser(uid.tom, `update project_tasks set status = 'in_progress', notes = 'On my way' where id = 't-7'`)
    await asUser(uid.tom, `update project_tasks set start_date = start_date + 2, end_date = end_date + 2 where id = 't-7'`)
    const told = await pool.query<{ title: string; body: string; project_id: string }>(`select title, body, project_id from inbox where user_id = 'u-admin' and title like 'Booking moved:%'`)
    assert.equal(told.rows[0].title, 'Booking moved: Plumbing fit-off')
    assert.match(told.rows[0].body, /^Tom Gallagher moved it from \d+ \w+ to \d+ \w+\.$/)
    assert.equal(told.rows[0].project_id, 'pr-1')
    await assert.rejects(asUser(uid.tom, `update project_tasks set title = 'Something else' where id = 't-7'`), /Only the office can change the schedule/)
    await assert.rejects(asUser(uid.tom, `update project_tasks set assignee_id = null where id = 't-7'`), /Only the office can change the schedule/)
    assert.equal((await asUser(uid.tom, `update project_tasks set start_date = start_date + 1, end_date = end_date + 1 where id = 't-8'`)).rowCount, 0)
    assert.equal((await asUser(uid.tom, `update project_tasks set status = 'done' where id = 't-1'`)).rowCount, 0)
    await assert.rejects(asUser(uid.tom, `insert into project_tasks (project_id, title, start_date, end_date) values ('pr-1', 'x', current_date, current_date)`), /row-level security/)
  })

  test('a trade adds to the diary as themselves; only the office shares entries with the client', async () => {
    const r = await asUser<{ author_id: string; share_with_client: boolean }>(
      uid.tom,
      `insert into project_diary (project_id, work_done, share_with_client, author_id) values ('pr-1', 'Moved the floor waste', true, 'u-admin') returning author_id, share_with_client`,
    )
    assert.deepEqual(r.rows[0], { author_id: 'u-prov-3', share_with_client: false })
    await assert.rejects(asUser(uid.marcus, `insert into project_diary (project_id, work_done) values ('pr-1', 'x')`), /row-level security/)
  })

  test('a trade marks their defect fixed (recorded as them) but cannot edit or close it; the office closes it', async () => {
    await assert.rejects(asUser(uid.tom, `update project_defects set title = 'Nothing wrong' where id = 'df-1'`), /mark a defect fixed/)
    await assert.rejects(asUser(uid.tom, `update project_defects set status = 'closed' where id = 'df-1'`), /mark a defect fixed/)
    await asUser(uid.tom, `update project_defects set status = 'fixed', fix_notes = 'Moved and retested' where id = 'df-1'`)
    let d = (await pr1(admin))!.defects.find((x) => x.id === 'df-1')!
    assert.deepEqual([d.status, d.fixedBy, d.fixNotes], ['fixed', 'u-prov-3', 'Moved and retested'])
    assert.ok(d.fixedAt)
    await mutate(admin, (x) => {
      x.projects.find((p) => p.id === 'pr-1')!.defects.find((y) => y.id === 'df-1')!.status = 'closed'
    })
    d = (await pr1(admin))!.defects.find((x) => x.id === 'df-1')!
    assert.deepEqual([d.status, d.closedBy, d.fixedBy], ['closed', 'u-admin', 'u-prov-3'])
  })

  test('the client sees their schedule, shared diary entries, all defects and shared documents, and can raise a defect', async () => {
    const p = (await pr1(sarah))!
    assert.equal(p.tasks.length, 9)
    assert.deepEqual(p.diary.map((e) => e.id), ['dy-1'])
    assert.ok(p.defects.some((d) => d.id === 'df-1'))
    assert.deepEqual(p.documents.map((d) => d.id), ['doc-1'])
    await mutate(sarah, (x) => {
      x.projects.find((y) => y.id === 'pr-1')!.defects.push({
        id: 'df-client', number: 99, title: 'Scratch on vanity', location: 'Vanity', description: '', assigneeId: 'u-prov-1', status: 'closed',
        photos: [], fixPhotos: [], fixNotes: '', raisedAt: new Date().toISOString(),
      })
    })
    const d = (await pr1(admin))!.defects.find((x) => x.id === 'df-client')!
    assert.deepEqual([d.number, d.status, d.assigneeId, d.raisedBy], [2, 'open', undefined, 'u-client-1'])
    // Once raised, only the office (or the trade fixing it) changes it.
    assert.equal((await asUser(uid.sarah, `update project_defects set status = 'closed' where id = 'df-client'`)).rowCount, 0)
    await assert.rejects(asUser(uid.sarah, `insert into project_documents (project_id, name, path) values ('pr-1', 'x', 'x')`), /row-level security/)
  })

  test('other clients see none of it', async () => {
    for (const t of ['project_tasks', 'project_diary', 'project_defects', 'project_documents']) {
      assert.equal((await asUser(uid.marcus, `select 1 from ${t} where project_id = 'pr-1'`)).rowCount, 0, t)
    }
  })

  test('document files: only the office uploads; people read only the files of documents shared with them', async () => {
    await asUser(uid.admin, `update project_documents set path = 'pr-1/a/plan.pdf' where id = 'doc-1'`)
    const path1 = (await asUser<{ path: string }>(uid.admin, `select path from project_documents where id = 'doc-1'`)).rows[0].path
    assert.notEqual(path1, 'pr-1/a/plan.pdf', 'path cannot change')
    await asUser(uid.admin, `insert into storage.objects (bucket_id, name) values ('project-docs', $1)`, [path1])
    const path2 = (await asUser<{ path: string }>(uid.admin, `select path from project_documents where id = 'doc-2'`)).rows[0].path
    await asUser(uid.admin, `insert into storage.objects (bucket_id, name) values ('project-docs', $1)`, [path2])
    await assert.rejects(asUser(uid.tom, `insert into storage.objects (bucket_id, name) values ('project-docs', 'pr-1/x/y.pdf')`), /row-level security/)
    const seen = async (u: string) => (await asUser<{ name: string }>(u, `select name from storage.objects where bucket_id = 'project-docs' order by name`)).rows.map((r) => r.name)
    assert.deepEqual(await seen(uid.tom), [path1])
    assert.deepEqual(await seen(uid.sarah), [path1])
    assert.deepEqual(await seen(uid.marcus), [])
    assert.deepEqual((await seen(uid.admin)).sort(), [path1, path2].sort())
  })
})

describe('booking reminders', () => {
  const day = '2031-03-04'
  test('the day before, the trade and the client get one reminder each in their inbox, never twice', async () => {
    await pool.query(`update project_tasks set start_date = $1, end_date = $1, status = 'todo', start_time = '07:30' where id = 't-7'`, [day])
    await pool.query(`update requests set scheduled_date = $1 where id = 'r-5'`, [day])
    const sent = await pool.query<{ n: number }>(`select send_booking_reminders($1) n`, [day])
    // Tom (task and job) and Sarah (task and job); the project's other people aren't booked that day.
    assert.equal(sent.rows[0].n, 4)
    assert.equal((await pool.query<{ n: number }>(`select send_booking_reminders($1) n`, [day])).rows[0].n, 0)
    const tom = await asUser<{ title: string; body: string; project_id: string | null; request_id: string | null }>(
      uid.tom,
      `select title, body, project_id, request_id from inbox where title like 'Booked for%' order by title`,
    )
    assert.deepEqual(tom.rows.map((r) => r.title), ['Booked for Tuesday 4 March: Plumbing fit-off', 'Booked for Tuesday 4 March: Quarterly gutter clean & roof inspection'])
    assert.match(tom.rows[0].body, /^You are booked at .+ from 7:30 am/)
    assert.equal(tom.rows[0].project_id, 'pr-1')
    assert.equal(tom.rows[1].request_id, 'r-5')
    const sarahs = await asUser<{ body: string }>(uid.sarah, `select body from inbox where title like 'Booked for%'`)
    assert.equal(sarahs.rowCount, 2)
    assert.match(sarahs.rows[0].body, /^Our team is booked at your place/)
  })

  test("done tasks, hidden tasks and finished jobs don't get one", async () => {
    const d2 = '2031-03-05'
    await pool.query(`update project_tasks set start_date = $1, end_date = $1, client_visible = false where id = 't-8'`, [d2])
    await pool.query(`update project_tasks set start_date = $1, end_date = $1, status = 'done' where id = 't-9'`, [d2])
    await pool.query(`update requests set scheduled_date = $1, status = 'completed' where id = 'r-5'`, [d2])
    // Only the electrician for t-8 (if they can sign in); never the client.
    await pool.query(`select send_booking_reminders($1)`, [d2])
    const who = await pool.query<{ recipient_id: string; ref_id: string }>(`select recipient_id, ref_id from reminder_log where booking_date = $1`, [d2])
    assert.ok(who.rows.every((r) => r.ref_id === 't-8' && r.recipient_id !== 'u-client-1'))
  })

  test('the trade and the client are also texted, once each per booking, through the SMS outbox', async () => {
    const day = '2031-03-04'
    const q = await pool.query<{ to_phone: string; message: string; event: string; source: string; status: string }>(
      `select to_phone, message, event, source, status from sms_outbox where event like 'Booking reminder · % · ${day} · %' order by event, to_phone`,
    )
    // Tom for the task and the job, Sarah for both: four texts, all waiting to be sent.
    assert.equal(q.rowCount, 4)
    assert.ok(q.rows.every((r) => r.source === 'booking_reminder' && r.status === 'pending'))
    const task = q.rows.find((r) => r.event === `Booking reminder · task t-7 · ${day} · trade`)!
    assert.match(task.message, /^Hi Tom, a reminder from Next Phase Maintenance: you're booked on Tue 4 Mar from 7:30 am for Plumbing fit-off at .+ \(Bathroom renovation/)
    const client = q.rows.find((r) => r.event === `Booking reminder · request r-5 · ${day} · client`)!
    assert.match(client.message, /^Hi Sarah, a reminder from Next Phase Maintenance: our team is booked at .+ on Tue 4 Mar for quarterly gutter clean/)
    // Running again sends nothing new.
    await pool.query(`select send_booking_reminders($1)`, [day])
    assert.equal((await pool.query(`select 1 from sms_outbox where event like 'Booking reminder · % · ${day} · %'`)).rowCount, 4)
  })

  test("trades without a login are texted too; suspended people and those without a mobile aren't; it can be switched off", async () => {
    const d3 = '2031-03-06'
    await pool.query(`insert into profiles (id, name, email, role, phone, status) values ('u-nolog-t', 'Nora Nolog', 'nora@example.com', 'provider', '0400 111 222', 'invited'), ('u-susp-t', 'Sam Susp', 'sam@example.com', 'provider', '0400 333 444', 'suspended')`)
    await pool.query(`update project_tasks set start_date = $1, end_date = $1, status = 'todo', assignee_id = 'u-nolog-t', client_visible = false where id = 't-1'`, [d3])
    await pool.query(`update project_tasks set start_date = $1, end_date = $1, status = 'todo', assignee_id = 'u-susp-t', client_visible = false where id = 't-3'`, [d3])
    await pool.query(`select send_booking_reminders($1)`, [d3])
    const to = (await pool.query<{ event: string }>(`select event from sms_outbox where event like 'Booking reminder · % · ${d3} · %'`)).rows.map((r) => r.event)
    assert.deepEqual(to, [`Booking reminder · task t-1 · ${d3} · trade`])
    // Nora has no login: no inbox reminder, just the text.
    assert.equal((await pool.query(`select 1 from reminder_log where recipient_id = 'u-nolog-t'`)).rowCount, 0)

    const d4 = '2031-03-07'
    await pool.query(`update project_tasks set start_date = $1, end_date = $1 where id = 't-1'`, [d4])
    await pool.query(`update settings set sms = sms || '{"bookingReminderTexts": false}'`)
    await pool.query(`select send_booking_reminders($1)`, [d4])
    assert.equal((await pool.query(`select 1 from sms_outbox where event like 'Booking reminder · % · ${d4} · %'`)).rowCount, 0)
    await pool.query(`update settings set sms = sms || '{"bookingReminderTexts": true}'`)
  })

  test('only the office reads the outbox; admins can queue a text, others cannot', async () => {
    assert.ok(((await asUser(uid.admin, `select id from sms_outbox`)).rowCount ?? 0) >= 5)
    assert.equal((await asUser(uid.tom, `select id from sms_outbox`)).rowCount, 0)
    await assert.rejects(asUser(uid.tom, `insert into sms_outbox (to_phone, message) values ('0400000000', 'hi')`), /row-level security/)
    await assert.rejects(asUser(uid.admin, `select * from claim_sms_outbox(5)`), /permission denied/)
  })

  test('only the office sees the reminder record, and nobody can run it from the app', async () => {
    assert.ok(((await asUser(uid.admin, `select id from reminder_log`)).rowCount ?? 0) >= 4)
    assert.equal((await asUser(uid.tom, `select id from reminder_log`)).rowCount, 0)
    await assert.rejects(asUser(uid.admin, `select send_booking_reminders()`), /permission denied/)
  })
})

describe('booked trades see the projects they work on', () => {
  test("a trade booked for tasks gets the project's name and address, not its money; the app shows their part of it", async () => {
    const tom = adapter(uid.tom)
    const booked = (await tom.call!('my_booked_projects')) as { id: string; title: string; address: string }[]
    assert.deepEqual(booked.map((b) => b.id), ['pr-1'])
    assert.ok(booked[0].address)
    assert.deepEqual(Object.keys(booked[0]).sort(), ['address', 'id', 'number', 'postcode', 'status', 'suburb', 'title'])
    const p = (await fetchAll(tom)).projects.find((x) => x.id === 'pr-1')!
    assert.equal(p.tasks.length, 9)
    assert.equal(p.budget, 0)
    assert.equal(p.quoteAmount, undefined)
    // Still no access to the project itself.
    assert.equal((await asUser(uid.tom, `select id from projects where id = 'pr-1'`)).rowCount, 0)
  })

  test("the project's own trade, its client and other people don't get it from here", async () => {
    assert.deepEqual(await sarah.call!('my_booked_projects'), [])
    assert.deepEqual(await marcus.call!('my_booked_projects'), [])
    const c = await pool.connect()
    try {
      await assert.rejects(c.query(`begin; set local role anon; select public.my_booked_projects()`), /permission denied/)
    } finally {
      await c.query('rollback')
      c.release()
    }
  })
})

describe("trades' calendar", () => {
  test('a trade moves their own maintenance order; the office is told', async () => {
    const r = await pool.query<{ id: string; number: number }>(`select id, number from requests where assigned_provider_id = 'u-prov-3' and status <> 'completed' limit 1`)
    if (!r.rowCount) return
    await asUser(uid.tom, `update requests set scheduled_date = coalesce(scheduled_date, current_date) + 1 where id = $1`, [r.rows[0].id])
    const told = await pool.query<{ title: string; request_id: string }>(`select title, request_id from inbox where user_id = 'u-admin' and title like 'Job moved:%'`)
    assert.equal(told.rows.at(-1)?.request_id, r.rows[0].id)
    assert.match(told.rows.at(-1)!.title, new RegExp(`^Job moved: #${r.rows[0].number} `))
    // Not someone else's.
    const other = await pool.query<{ id: string }>(`select id from requests where assigned_provider_id is distinct from 'u-prov-3' limit 1`)
    assert.equal((await asUser(uid.tom, `update requests set scheduled_date = current_date + 9 where id = $1`, [other.rows[0].id])).rowCount, 0)
  })
})

describe('supplier stock tracking', () => {
  const apply = (status: string, qty: number | null = null, price: number | null = null, note = '') =>
    pool.query<{ r: string }>(`select apply_supplier_stock('sp-1', $1, $2, $3, $4) r`, [status, qty, price, note]).then((x) => x.rows[0].r)
  const product = async () => (await pool.query<{ stock: string }>(`select stock from products where id = 'sp-1'`)).rows[0].stock
  const source = async () =>
    (await pool.query<{ stock_status: string; stock_qty: number | null; supplier_price: string | null; stock_auto: boolean }>(`select stock_status, stock_qty, supplier_price, stock_auto from product_sources where id = 'sp-1'`)).rows[0]
  const told = async (like: string) => (await pool.query(`select 1 from inbox where user_id = 'u-admin' and title like $1`, [like])).rowCount

  test("the app can't write stock readings; a new supplier link starts afresh", async () => {
    await pool.query(`update products set stock = 'in_stock', status = 'published' where id = 'sp-1'`)
    await apply('in_stock', 12, 799)
    await asUser(uid.admin, `update product_sources set stock_status = 'out_of_stock', stock_qty = 0, notes = 'checked' where id = 'sp-1'`)
    assert.deepEqual(await source(), { stock_status: 'in_stock', stock_qty: 12, supplier_price: '799.00', stock_auto: false })
    await asUser(uid.admin, `update product_sources set source_url = 'https://example.com/vanity-900-v2' where id = 'sp-1'`)
    assert.equal((await source()).stock_status, 'unknown')
    await assert.rejects(asUser(uid.admin, `select apply_supplier_stock('sp-1', 'in_stock', 1, 1, '')`), /permission denied/)
  })

  test('out at the supplier: the listing shows out of stock and store managers are told; back in: it switches back', async () => {
    await pool.query(`update product_sources set supplier = 'Bathware Wholesale' where id = 'sp-1'`)
    await apply('in_stock', 5)
    assert.equal(await apply('out_of_stock', 0, null, 'Page says: sold out'), 'changed')
    assert.equal(await product(), 'out_of_stock')
    assert.equal((await source()).stock_auto, true)
    assert.equal(await told('Out of stock at Bathware Wholesale: %'), 1)
    assert.equal(await apply('out_of_stock', 0), 'same', 'no repeat message')
    assert.equal(await told('Out of stock at Bathware Wholesale: %'), 1)
    assert.equal(await apply('in_stock', 8), 'changed')
    assert.equal(await product(), 'in_stock')
    assert.equal(await told('Back in stock at Bathware Wholesale: %'), 1)
  })

  test("a page that can't be read keeps the last reading; low stock is flagged once", async () => {
    assert.equal(await apply('unknown', null, null, 'Page not reachable'), 'unknown')
    assert.equal((await source()).stock_status, 'in_stock')
    await apply('low', 2)
    assert.equal(await told('Running low at Bathware Wholesale: %'), 1)
    assert.equal(await product(), 'in_stock')
  })

  test('"To order" instead, if chosen; a listing the office changed itself is left alone', async () => {
    await asUser(uid.admin, `update product_sources set out_of_stock_as = 'to_order' where id = 'sp-1'`)
    await apply('in_stock', 3)
    await apply('out_of_stock', 0)
    assert.equal(await product(), 'to_order')
    await apply('in_stock', 3)
    assert.equal(await product(), 'in_stock')
    // The office marks it out of stock itself: the tracker doesn't put it back.
    await pool.query(`update products set stock = 'out_of_stock' where id = 'sp-1'`)
    await apply('out_of_stock', 0)
    await apply('in_stock', 4)
    assert.equal(await product(), 'out_of_stock')
    // Tracking off: readings are kept, nothing changes.
    await asUser(uid.admin, `update product_sources set track_stock = false where id = 'sp-1'`)
    await pool.query(`update products set stock = 'in_stock' where id = 'sp-1'`)
    await apply('out_of_stock', 0)
    assert.equal(await product(), 'in_stock')
  })

  test('only store managers see the stock check runs', async () => {
    await pool.query(`insert into stock_check_runs (checked) values (3)`)
    assert.equal((await asUser(uid.admin, `select 1 from stock_check_runs`)).rowCount, 1)
    assert.equal((await asUser(uid.tom, `select 1 from stock_check_runs`)).rowCount, 0)
  })
})

describe('price structure', () => {
  const prices = async (id: string) => {
    const r = await pool.query<{ p: string; c: string | null; t: string | null }>(
      `select p.price p, (select price from product_client_prices where id = p.id) c, (select price from product_trade_prices where id = p.id) t from products p where p.id = $1`,
      [id],
    )
    return [Number(r.rows[0].p), r.rows[0].c === null ? null : Number(r.rows[0].c), r.rows[0].t === null ? null : Number(r.rows[0].t)]
  }
  const history = async (id: string) =>
    (await pool.query<{ reason: string; public_price: string }>(`select reason, public_price from product_price_history where product_id = $1 order by at, id`, [id])).rows

  test('a product with a cost gets its three prices from the margins (30% public, 25% clients, 17% trades), rounded up to the dollar', async () => {
    await asUser(uid.admin, `insert into products (id, title, category, price, status) values ('pp-1', 'Oak vanity 1200', 'Vanities', 1, 'published')`)
    await asUser(uid.admin, `insert into product_sources (id, supplier, cost) values ('pp-1', 'Acme', 1000)`)
    assert.deepEqual(await prices('pp-1'), [1429, 1334, 1205])
    assert.equal((await history('pp-1')).at(-1)!.reason, 'Priced automatically')
  })

  test("with no cost entered, the supplier's price is the cost; when it changes the prices follow and the office is told", async () => {
    await asUser(uid.admin, `insert into products (id, title, category, price, status) values ('pp-2', 'Basin mixer', 'Tapware', 1, 'published')`)
    await asUser(uid.admin, `insert into product_sources (id, supplier, source_url) values ('pp-2', 'TapCo', 'https://example.com/mixer')`)
    assert.deepEqual(await prices('pp-2'), [1, null, null], 'nothing to base it on yet')
    await pool.query(`select apply_supplier_stock('pp-2', 'in_stock', 5, 210, '')`)
    assert.deepEqual(await prices('pp-2'), [300, 280, 254])
    await pool.query(`select apply_supplier_stock('pp-2', 'in_stock', 5, 231, '')`)
    assert.deepEqual(await prices('pp-2'), [330, 308, 279])
    const told = await pool.query<{ body: string }>(`select body from inbox where user_id = 'u-admin' and title = 'Supplier price up: Basin mixer'`)
    assert.equal(told.rowCount, 1)
    assert.match(told.rows[0].body, /^TapCo now charges \$231\.00 \(was \$210\.00\)\. Your prices are now \$330 public, \$308 for clients and \$279 for trades\.$/)
    assert.deepEqual((await history('pp-2')).map((h) => h.reason).slice(-2), ['Supplier price changed', 'Supplier price changed'])
  })

  test("automatic prices can't be overridden from the app; switched off, prices are set by hand and recorded", async () => {
    await asUser(uid.admin, `update products set price = 5 where id = 'pp-1'`)
    await asUser(uid.admin, `update product_trade_prices set price = 5 where id = 'pp-1'`)
    assert.deepEqual(await prices('pp-1'), [1429, 1334, 1205])
    await asUser(uid.admin, `update product_sources set auto_price = false where id = 'pp-1'`)
    await asUser(uid.admin, `update products set price = 1499 where id = 'pp-1'`)
    assert.deepEqual(await prices('pp-1'), [1499, 1334, 1205])
    const h = (await history('pp-1')).at(-1)!
    assert.deepEqual([h.reason, Number(h.public_price)], ['Price set by hand', 1499])
    assert.equal((await pool.query(`select changed_by from product_price_history where product_id = 'pp-1' order by at desc, id desc limit 1`)).rows[0].changed_by, 'u-admin')
    await asUser(uid.admin, `update product_sources set auto_price = true where id = 'pp-1'`)
    assert.deepEqual(await prices('pp-1'), [1429, 1334, 1205])
  })

  test('new margins reprice every automatically priced product', async () => {
    await asUser(uid.admin, `update settings set pricing = '{"public": 35, "client": 25, "trade": 15}'`)
    assert.deepEqual(await prices('pp-1'), [1539, 1334, 1177])
    assert.equal((await history('pp-1')).at(-1)!.reason, 'Margins changed')
    await assert.rejects(asUser(uid.admin, `update settings set pricing = '{"public": 120, "client": 25, "trade": 15}'`), /pricing_margins/)
    await asUser(uid.admin, `update settings set pricing = '{"public": 30, "client": 25, "trade": 17}'`)
  })

  test("clients see the client price of published products, nobody else does; the history is the office's", async () => {
    assert.deepEqual((await asUser<{ id: string }>(uid.sarah, `select id from product_client_prices where id like 'pp-%' order by id`)).rows.map((r) => r.id), ['pp-1', 'pp-2'])
    assert.equal((await asUser(uid.tia, `select 1 from product_client_prices`)).rowCount, 0)
    assert.equal((await asAnon(`select 1 from product_client_prices`)).rowCount, 0)
    assert.equal((await asUser(uid.sarah, `select 1 from product_price_history`)).rowCount, 0)
    assert.ok(((await asUser(uid.admin, `select 1 from product_price_history`)).rowCount ?? 0) > 3)
    await assert.rejects(asUser(uid.admin, `select auto_price_for('pp-1', 'trade')`), /permission denied/)
  })
})

describe('product options', () => {
  const opts = (sizePrice = 0, oakPrice = 0, oakAvailable = true) =>
    JSON.stringify([
      { id: 'o-size', name: 'Size', values: [{ id: 'v-600', label: '600 mm', price: 0, available: true }, { id: 'v-900', label: '900 mm', price: sizePrice, available: true }] },
      { id: 'o-col', name: 'Colour', values: [{ id: 'v-white', label: 'White', price: 0, available: true }, { id: 'v-oak', label: 'Oak', price: oakPrice, available: oakAvailable }] },
    ])
  const addOns = async (id: string) => {
    const r = await pool.query<{ o: { values: { id: string; price: number }[] }[]; c: Record<string, number> | null; t: Record<string, number> | null }>(
      `select p.options o, (select option_prices from product_client_prices where id = p.id) c, (select option_prices from product_trade_prices where id = p.id) t from products p where p.id = $1`,
      [id],
    )
    const pub = Object.fromEntries(r.rows[0].o.flatMap((g) => g.values.map((v) => [v.id, Number(v.price)])))
    return { pub, client: r.rows[0].c, trade: r.rows[0].t }
  }
  const buy = (who: string | null, items: unknown, email = 'opt@example.com') => {
    const q = `select place_order('${JSON.stringify(items)}'::jsonb, 'Jo Buyer', '${email}', '0400 111 222', 'pickup') as r`
    return who ? asUser<{ r: { id: string; total: string } }>(who, q) : asAnon<{ r: { id: string; total: string } }>(q)
  }
  const items = async (orderId: string) =>
    (await pool.query<{ unit_price: string; options: string; qty: number }>(`select unit_price, options, qty from order_items where order_id = $1 order by unit_price`, [orderId])).rows.map(
      (i) => [Number(i.unit_price), i.options, i.qty],
    )

  test('extra costs become add-ons at each tier’s margin; published options are public, costs and other tiers are not', async () => {
    await asUser(uid.admin, `insert into products (id, title, category, price, status, options) values ('po-1', 'Vanity', 'Vanities', 1, 'published', '${opts()}')`)
    await asUser(uid.admin, `insert into product_sources (id, supplier, cost, option_costs) values ('po-1', 'Acme', 1000, '{"v-900": 250, "v-oak": 120}')`)
    const a = await addOns('po-1')
    assert.deepEqual(a.pub, { 'v-600': 0, 'v-900': 358, 'v-white': 0, 'v-oak': 172 })
    assert.deepEqual(a.client, { 'v-600': 0, 'v-900': 334, 'v-white': 0, 'v-oak': 160 })
    assert.deepEqual(a.trade, { 'v-600': 0, 'v-900': 302, 'v-white': 0, 'v-oak': 145 })
    // The app can't set the add-ons of an automatically priced product.
    await asUser(uid.admin, `update products set options = '${opts(1, 1)}' where id = 'po-1'`)
    assert.deepEqual((await addOns('po-1')).pub, { 'v-600': 0, 'v-900': 358, 'v-white': 0, 'v-oak': 172 })
    // New extra costs reprice.
    await asUser(uid.admin, `update product_sources set option_costs = '{"v-900": 350, "v-oak": 120}' where id = 'po-1'`)
    assert.equal((await addOns('po-1')).pub['v-900'], 500)
    assert.equal((await addOns('po-1')).trade!['v-900'], 422)
    assert.equal((await asAnon<{ options: unknown }>(`select options from products where id = 'po-1'`)).rowCount, 1)
    assert.equal((await asUser(uid.sarah, `select 1 from product_sources where id = 'po-1'`)).rowCount, 0)
    assert.equal((await asUser(uid.sarah, `select 1 from product_trade_prices where id = 'po-1'`)).rowCount, 0)
    await assert.rejects(asUser(uid.admin, `update product_sources set option_costs = '{"v-900": -5}' where id = 'po-1'`), /option_costs/)
    await assert.rejects(asUser(uid.admin, `update products set options = '[{"id": "x", "name": "", "values": []}]' where id = 'po-1'`), /product_options/)
  })

  test('each customer pays their tier’s price plus add-ons, the choices are kept on the order, and the same product with other choices is its own line', async () => {
    const choose = (size: string, col: string, qty = 1) => ({ product_id: 'po-1', qty, options: { 'o-size': size, 'o-col': col } })
    const guest = (await buy(null, [choose('v-900', 'v-oak'), choose('v-600', 'v-white', 2), choose('v-900', 'v-oak')])).rows[0].r
    // 1429 + 500 + 172 = 2101 (x2), 1429 (x2)
    assert.deepEqual(await items(guest.id), [[1429, 'Size: 600 mm · Colour: White', 2], [2101, 'Size: 900 mm · Colour: Oak', 2]])
    assert.equal(Number(guest.total), 7060)
    const sarah = (await buy(uid.sarah, [choose('v-900', 'v-white')], 'sarah.w@example.com')).rows[0].r
    assert.deepEqual(await items(sarah.id), [[1334 + 467, 'Size: 900 mm · Colour: White', 1]])
    const tia = (await buy(uid.tia, [choose('v-600', 'v-oak')], 'tia@example.com')).rows[0].r
    assert.deepEqual(await items(tia.id), [[1205 + 145, 'Size: 600 mm · Colour: Oak', 1]])
  })

  test('every option must be chosen, from values that exist and are still available', async () => {
    await assert.rejects(buy(null, [{ product_id: 'po-1', qty: 1, options: { 'o-size': 'v-900' } }], 'o2@example.com'), /Choose the colour for Vanity/)
    await assert.rejects(buy(null, [{ product_id: 'po-1', qty: 1 }], 'o2@example.com'), /Choose the size for Vanity/)
    await assert.rejects(buy(null, [{ product_id: 'po-1', qty: 1, options: { 'o-size': 'v-900', 'o-col': 'v-pink' } }], 'o2@example.com'), /Choose the colour/)
    await assert.rejects(buy(null, [{ product_id: 'po-1', qty: 1, options: { 'o-size': 'v-900', 'o-col': 'v-oak', 'o-x': 'y' } }], 'o2@example.com'), /have changed/)
    await asUser(uid.admin, `update products set options = '${opts(0, 0, false)}' where id = 'po-1'`)
    await assert.rejects(buy(null, [{ product_id: 'po-1', qty: 1, options: { 'o-size': 'v-900', 'o-col': 'v-oak' } }], 'o2@example.com'), /No longer available: Vanity \(Oak\)/)
  })

  test('priced by hand, the extra price applies to everyone', async () => {
    await asUser(uid.admin, `update product_sources set auto_price = false where id = 'po-1'`)
    await asUser(uid.admin, `update products set options = '${opts(400, 90)}' where id = 'po-1'`)
    const a = await addOns('po-1')
    assert.deepEqual(a.pub, { 'v-600': 0, 'v-900': 400, 'v-white': 0, 'v-oak': 90 })
    assert.deepEqual(a.client, a.pub)
    assert.deepEqual(a.trade, a.pub)
    const tia = (await buy(uid.tia, [{ product_id: 'po-1', qty: 1, options: { 'o-size': 'v-900', 'o-col': 'v-oak' } }], 'tia@example.com')).rows[0].r
    assert.deepEqual(await items(tia.id), [[1205 + 490, 'Size: 900 mm · Colour: Oak', 1]])
    await assert.rejects(asUser(uid.admin, `select auto_option_prices('po-1', 'trade', '[]')`), /permission denied/)
  })

  test('the price history keeps every choice’s extra cost and add-ons, and records option changes', async () => {
    type Snap = { option: string; choice: string; cost: number | null; public: number; client: number | null; trade: number | null }
    const last = async () =>
      (await pool.query<{ reason: string; options: Snap[]; changed_by: string | null }>(`select reason, options, changed_by from product_price_history where product_id = 'po-1' order by at desc, id desc limit 1`)).rows[0]
    const count = async () => Number((await pool.query(`select count(*) from product_price_history where product_id = 'po-1'`)).rows[0].count)
    // Priced by hand (from the test before): changing an extra price is recorded once, by who did it.
    const before = await count()
    await asUser(uid.admin, `update products set options = '${opts(450, 90)}' where id = 'po-1'`)
    assert.equal(await count(), before + 1)
    let h = await last()
    assert.equal(h.reason, 'Options changed')
    assert.equal(h.changed_by, 'u-admin')
    assert.deepEqual(h.options.find((o) => o.choice === '900 mm'), { option: 'Size', choice: '900 mm', cost: 350, public: 450, client: 450, trade: 450 })
    // Saving the same options again records nothing.
    await asUser(uid.admin, `update products set options = '${opts(450, 90)}' where id = 'po-1'`)
    assert.equal(await count(), before + 1)
    // Back on automatic pricing, a new extra cost is recorded with each tier's add-on.
    await asUser(uid.admin, `update product_sources set auto_price = true where id = 'po-1'`)
    await asUser(uid.admin, `update product_sources set option_costs = '{"v-900": 210, "v-oak": 120}' where id = 'po-1'`)
    h = await last()
    assert.equal(h.reason, 'Option costs changed')
    assert.deepEqual(h.options.find((o) => o.choice === '900 mm'), { option: 'Size', choice: '900 mm', cost: 210, public: 300, client: 280, trade: 254 })
    assert.equal((await asUser(uid.sarah, `select 1 from product_price_history`)).rowCount, 0)
    await assert.rejects(asUser(uid.admin, `select option_price_snapshot('po-1')`), /permission denied/)
  })
})

describe('quickbooks invoices', () => {
  const order = async (email: string) =>
    (await asAnon<{ r: { id: string } }>(`select place_order('[{"product_id":"po-1","qty":1,"options":{"o-size":"v-600","o-col":"v-white"}}]'::jsonb, 'Quinn Buyer', '${email}', '0400 111 222', 'pickup') as r`)).rows[0].r.id

  test('a new order waits for its invoice; nobody but the server can set invoice details', async () => {
    const id = await order('quinn@example.com')
    const row = async () => (await pool.query(`select invoice_status, qbo_invoice_id, pay_link from orders where id = $1`, [id])).rows[0]
    assert.deepEqual(await row(), { invoice_status: 'pending', qbo_invoice_id: null, pay_link: '' })
    await asUser(uid.admin, `update orders set invoice_status = 'paid', pay_link = 'https://evil.example', status = 'confirmed' where id = '${id}'`)
    assert.deepEqual(await row(), { invoice_status: 'pending', qbo_invoice_id: null, pay_link: '' })
    assert.equal((await pool.query(`select status from orders where id = $1`, [id])).rows[0].status, 'confirmed')
    // The server (service role) records it.
    await pool.query(`update orders set invoice_status = 'sent', qbo_invoice_id = '77', invoice_number = '1043', pay_link = 'https://pay.example/77' where id = $1`, [id])
    assert.deepEqual(await row(), { invoice_status: 'sent', qbo_invoice_id: '77', pay_link: 'https://pay.example/77' })
  })

  test('the customer sees their invoice on the confirmation screen with the order id and their email only', async () => {
    const id = (await pool.query(`select id from orders where email = 'quinn@example.com'`)).rows[0].id
    const r = (await asAnon<{ r: unknown }>(`select order_invoice('${id}', 'Quinn@Example.com') as r`)).rows[0].r
    assert.deepEqual(r, { status: 'sent', number: '1043', pay_link: 'https://pay.example/77' })
    assert.equal((await asAnon<{ r: unknown }>(`select order_invoice('${id}', 'someone@else.com') as r`)).rows[0].r, null)
  })

  test('the connection (tokens) is server-only; the office only sees whether it is connected', async () => {
    await pool.query(`insert into qbo_connection (id, realm_id, company_name, refresh_token, connected_at) values (1, '123', 'Next Phase Pty Ltd', 'secret-token', now())`)
    await assert.rejects(asUser(uid.admin, `select refresh_token from qbo_connection`), /permission denied/)
    await assert.rejects(asAnon(`select * from qbo_connection`), /permission denied/)
    const s = (await asUser<{ s: { connected: boolean; company: string; refresh_token?: string } }>(uid.admin, `select qbo_status() as s`)).rows[0].s
    assert.equal(s.connected, true)
    assert.equal(s.company, 'Next Phase Pty Ltd')
    assert.equal(s.refresh_token, undefined)
    assert.equal((await asUser<{ s: unknown }>(uid.sarah, `select qbo_status() as s`)).rows[0].s, null)
  })

  test('only the server claims invoices to make, once each; the office can retry a failed one', async () => {
    await assert.rejects(asUser(uid.admin, `select * from claim_order_invoices(5)`), /permission denied/)
    const id = await order('rae@example.com')
    const claimed = (await pool.query(`select id from claim_order_invoices(50)`)).rows.map((r) => r.id)
    assert.ok(claimed.includes(id))
    assert.ok(!(await pool.query(`select id from claim_order_invoices(50)`)).rows.some((r) => r.id === id), 'not claimed twice')
    await pool.query(`update orders set invoice_status = 'failed', invoice_attempts = 6, invoice_error = 'QuickBooks said no' where id = $1`, [id])
    await assert.rejects(asUser(uid.sarah, `select retry_order_invoice('${id}')`), /Manage store/)
    await asUser(uid.admin, `select retry_order_invoice('${id}')`)
    assert.deepEqual((await pool.query(`select invoice_status, invoice_attempts, invoice_error from orders where id = $1`, [id])).rows[0], { invoice_status: 'pending', invoice_attempts: 0, invoice_error: '' })
  })

  test('orders past the automatic invoice limits wait for the office to approve them', async () => {
    await assert.rejects(asUser(uid.sarah, `select qbo_set_limits(5, 100)`), /permission/)
    await assert.rejects(asUser(uid.admin, `select qbo_set_limits(-1, 100)`), /between 0 and 1000/)
    // Too large for an automatic invoice: held, and the store managers told.
    await asUser(uid.admin, `select qbo_set_limits(1000, 1)`)
    const s = (await asUser<{ s: { daily_limit: number; max_total: number } }>(uid.admin, `select qbo_status() as s`)).rows[0].s
    assert.deepEqual([s.daily_limit, Number(s.max_total)], [1000, 1])
    const big = await order('big@example.com')
    await pool.query(`select id from claim_order_invoices(50)`)
    const held = (await pool.query(`select invoice_status, invoice_error, number from orders where id = $1`, [big])).rows[0]
    assert.equal(held.invoice_status, 'held')
    assert.equal(held.invoice_error, 'Over the $1.00 limit for automatic invoices: approve it to send the invoice.')
    assert.equal(Number((await pool.query(`select count(*) from inbox where title = $1`, [`Order #${held.number}: approve its invoice`])).rows[0].count) > 0, true)
    // Nobody but the server can approve it by editing the order.
    await asUser(uid.admin, `update orders set invoice_approved = true, invoice_status = 'pending' where id = '${big}'`)
    assert.equal((await pool.query(`select invoice_status || ' ' || invoice_approved as v from orders where id = $1`, [big])).rows[0].v, 'held false')
    // The office approves it: it's invoiced whatever the limits.
    await asUser(uid.admin, `select retry_order_invoice('${big}')`)
    assert.ok((await pool.query(`select id from claim_order_invoices(50)`)).rows.some((r) => r.id === big))
    // The day's number reached: the next one waits too.
    const used = Number((await pool.query(`select count(*) from orders where invoice_auto_at > now() - interval '24 hours'`)).rows[0].count)
    await asUser(uid.admin, `select qbo_set_limits(${used}, 100000)`)
    const next = await order('next@example.com')
    await pool.query(`select id from claim_order_invoices(50)`)
    assert.equal((await pool.query(`select invoice_error from orders where id = $1`, [next])).rows[0].invoice_error, `The day’s ${used} automatic invoices have been sent: approve it to send the invoice.`)
    await asUser(uid.admin, `select qbo_set_limits(${used + 1}, 100000)`)
    const third = await order('third@example.com')
    assert.ok((await pool.query(`select id from claim_order_invoices(50)`)).rows.some((r) => r.id === third), 'under the limit again')
  })

  test('delivery orders wait for the office to confirm the delivery cost and date before they are invoiced', async () => {
    await asUser(uid.admin, `select qbo_set_limits(1000, 100000)`)
    const deliver = (email: string, d: string) =>
      asAnon<{ r: { id: string } }>(`select place_order('[{"product_id":"po-1","qty":1,"options":{"o-size":"v-600","o-col":"v-white"}}]'::jsonb, 'Dee Livery', '${email}', '0400 111 222', '${d}', '9 High St, Kew') as r`).then((x) => x.rows[0].r.id)
    const id = await deliver('dee@example.com', 'same_day')
    // The customer can't set a delivery cost themselves, nor can the app.
    await asUser(uid.admin, `update orders set delivery_fee = 1, delivery_note = 'x' where id = '${id}'`)
    assert.deepEqual((await pool.query(`select delivery_fee, delivery_note from orders where id = $1`, [id])).rows[0], { delivery_fee: null, delivery_note: '' })
    // Held, not invoiced, and the store managers told.
    assert.ok(!(await pool.query(`select id from claim_order_invoices(50)`)).rows.some((r) => r.id === id))
    const held = (await pool.query(`select invoice_status, invoice_error, number from orders where id = $1`, [id])).rows[0]
    assert.equal(held.invoice_status, 'held')
    assert.match(held.invoice_error, /Confirm the delivery cost and date/)
    assert.equal(Number((await pool.query(`select count(*) from inbox where title = $1`, [`Order #${held.number}: confirm its delivery`])).rows[0].count) > 0, true)
    // Approving its invoice the usual way doesn't skip the delivery: it's held again.
    await asUser(uid.admin, `select retry_order_invoice('${id}')`)
    assert.ok(!(await pool.query(`select id from claim_order_invoices(50)`)).rows.some((r) => r.id === id))
    assert.equal((await pool.query(`select invoice_status from orders where id = $1`, [id])).rows[0].invoice_status, 'held')
    // Only store managers confirm it, with a cost and a date.
    await assert.rejects(asUser(uid.sarah, `select confirm_order_delivery('${id}', 40, 'Same day, Tue 12 Nov')`), /Manage store/)
    await assert.rejects(asUser(uid.admin, `select confirm_order_delivery('${id}', -1, 'Same day')`), /delivery cost/)
    await assert.rejects(asUser(uid.admin, `select confirm_order_delivery('${id}', 40, '  ')`), /delivery date/)
    await asUser(uid.admin, `select confirm_order_delivery('${id}', 45.5, 'Earliest: Thu 14 Nov')`)
    assert.deepEqual((await pool.query(`select delivery_fee::text as fee, delivery_note, invoice_status, invoice_approved from orders where id = $1`, [id])).rows[0], { fee: '45.50', delivery_note: 'Earliest: Thu 14 Nov', invoice_status: 'pending', invoice_approved: true })
    assert.ok((await pool.query(`select id from claim_order_invoices(50)`)).rows.some((r) => r.id === id), 'invoiced once confirmed')
    // Once its invoice is being made, the delivery can't be changed here.
    await assert.rejects(asUser(uid.admin, `select confirm_order_delivery('${id}', 50, 'Same day')`), /already been made/)
    // Pickup orders have no delivery to confirm and are invoiced straight away.
    const pickup = await order('pip@example.com')
    await assert.rejects(asUser(uid.admin, `select confirm_order_delivery('${pickup}', 10, 'x')`), /pickup/)
    assert.ok((await pool.query(`select id from claim_order_invoices(50)`)).rows.some((r) => r.id === pickup))
  })
})

describe('two-step sign-in for admins', () => {
  test('an admin with only their password (aal1) has no admin access; a client is unaffected', async () => {
    const full = Number((await asUser<{ n: string }>(uid.admin, `select count(*) as n from profiles`)).rows[0].n)
    assert.ok(full > 1)
    // Only their own profile (to know they're an admin and must do the second step).
    assert.equal(Number((await asUser<{ n: string }>(uid.admin, `select count(*) as n from profiles`, [], 'aal1')).rows[0].n), 1)
    assert.equal((await asUser<{ a: boolean }>(uid.admin, `select is_admin() as a`, [], 'aal1')).rows[0].a, false)
    assert.equal((await asUser<{ a: boolean }>(uid.admin, `select has_perm('canManageStore') as a`, [], 'aal1')).rows[0].a, false)
    assert.equal((await asUser<{ a: string | null }>(uid.admin, `select current_profile_id() as a`, [], 'aal1')).rows[0].a, null)
    assert.equal(Number((await asUser<{ n: string }>(uid.admin, `select count(*) as n from orders`, [], 'aal1')).rows[0].n), 0)
    assert.equal(Number((await asUser<{ n: string }>(uid.admin, `select count(*) as n from inbox`, [], 'aal1')).rows[0].n), 0)
    await assert.rejects(asUser(uid.admin, `select retry_order_invoice('x')`, [], 'aal1'), /Manage store/)
    assert.equal((await asUser<{ s: unknown }>(uid.admin, `select qbo_status() as s`, [], 'aal1')).rows[0].s, null)
    await assert.rejects(asUser(uid.admin, `insert into sms_outbox (to_phone, message) values ('0400000000', 'hi')`, [], 'aal1'), /row-level security/)
    // With the second step, everything is back.
    assert.equal((await asUser<{ a: boolean }>(uid.admin, `select is_admin() as a`)).rows[0].a, true)
    // A client's access doesn't depend on it.
    const id = (await asUser<{ a: string }>(uid.sarah, `select current_profile_id() as a`, [], 'aal1')).rows[0].a
    assert.ok(id)
    assert.equal(id, (await asUser<{ a: string }>(uid.sarah, `select current_profile_id() as a`)).rows[0].a)
  })
})

describe('product details (specs, highlights, barcode, compliance)', () => {
  test('store managers set them, visitors read them on published products, bad shapes are refused', async () => {
    await pool.query(`insert into products (id, title, price, status) values ('pdet-1', 'Detail vanity', 900, 'published')`)
    await asUser(uid.admin, `update products set specs = '[{"label":"Width","value":"900 mm"}]', highlights = '{"Soft-close drawers"}', gtin = '9312345678907', compliance = '{"welsStars":4,"welsWater":"6 L/min","standards":["AS/NZS 3718"],"warranty":"15 years"}' where id = 'pdet-1'`)
    const r = (await asAnon<{ specs: unknown; gtin: string; stars: string }>(`select specs, gtin, compliance->>'welsStars' as stars from products where id = 'pdet-1'`)).rows[0]
    assert.deepEqual(r, { specs: [{ label: 'Width', value: '900 mm' }], gtin: '9312345678907', stars: '4' })
    // Only store managers change them.
    await asUser(uid.sarah, `update products set gtin = '' where id = 'pdet-1'`)
    assert.equal((await pool.query(`select gtin from products where id = 'pdet-1'`)).rows[0].gtin, '9312345678907')
    for (const bad of [`specs = '[{"label":"Width"}]'`, `specs = '["Width 900"]'`, `gtin = '12ab'`, `compliance = '{"welsStars":9}'`, `compliance = '{"warranty":15}'`, `compliance = '[]'`]) {
      await assert.rejects(pool.query(`update products set ${bad} where id = 'pdet-1'`), /violates check constraint/, bad)
    }
  })
})


describe('quote link and deposit', () => {
  const quote = async (title: string, amount: number) => {
    const id = (await asUser<{ id: string }>(uid.admin, `insert into projects (client_id, property_id, title, quote_amount) values ('u-client-1', 'p-1', $1, $2) returning id`, [title, amount])).rows[0].id
    await asUser(uid.admin, `update projects set status = 'quoted' where id = $1`, [id])
    return id
  }
  const row = async (id: string) =>
    (await pool.query(`select status, quote_decision, quote_answered_name, deposit_status, deposit_amount::text as deposit, deposit_error, quote_token from projects where id = $1`, [id])).rows[0]

  test('issuing gives the quote a private link; nobody but the server can set it or the deposit', async () => {
    const id = await quote('Link deck', 8800)
    const r = await row(id)
    assert.match(r.quote_token, /^[0-9a-f]{64}$/)
    await asUser(uid.admin, `update projects set quote_token = 'x', deposit_status = 'paid', deposit_amount = 1 where id = $1`, [id])
    assert.deepEqual([(await row(id)).quote_token, (await row(id)).deposit_status], [r.quote_token, 'none'])
    const seen = (await asAnon<{ q: { title: string; total: string; client: string; status: string } }>(`select quote_by_token($1) as q`, [r.quote_token])).rows[0].q
    assert.deepEqual([seen.title, Number(seen.total), seen.status], ['Link deck', 8800, 'quoted'])
    assert.equal((await asAnon<{ q: unknown }>(`select quote_by_token('nope') as q`)).rows[0].q, null)
  })

  test('accepting from the link records who, tells the office and queues a 10% deposit; it can’t be answered twice', async () => {
    const id = await quote('Link fence', 8800)
    const token = (await row(id)).quote_token
    await assert.rejects(asAnon(`select answer_quote_by_token($1, true, '')`, [token]), /Type your name/)
    await asAnon(`select answer_quote_by_token($1, true, 'Sarah Client')`, [token])
    const r = await row(id)
    assert.deepEqual([r.status, r.quote_decision, r.quote_answered_name, r.deposit_status, r.deposit], ['approved', 'approved', 'Sarah Client', 'pending', '880.00'])
    assert.ok(Number((await pool.query(`select count(*) from inbox where title = (select 'Quote P-' || number || ' accepted' from projects where id = $1)`, [id])).rows[0].count) > 0)
    await assert.rejects(asAnon(`select answer_quote_by_token($1, false, '')`, [token]), /already been answered/)
  })

  test('a first payment stage over the legal deposit is held; fixing it lets the office send it', async () => {
    const id = await quote('Link bathroom', 25000)
    await pool.query(`insert into project_payments (project_id, position, title, basis, value) values ($1, 0, 'Deposit', 'percent', 10)`, [id])
    await asUser(uid.sarah, `update projects set status = 'approved' where id = $1`, [id])
    let r = await row(id)
    assert.equal(r.deposit_status, 'held')
    assert.match(r.deposit_error, /\$2,500\.00\) is more than the deposit allowed for a contract of \$25,000\.00/)
    await assert.rejects(asUser(uid.admin, `select send_quote_deposit($1)`, [id]), /more than the deposit allowed/)
    await pool.query(`update project_payments set value = 5 where project_id = $1`, [id])
    await assert.rejects(asUser(uid.sarah, `select send_quote_deposit($1)`, [id]), /Manage projects/)
    await asUser(uid.admin, `select send_quote_deposit($1)`, [id])
    r = await row(id)
    assert.deepEqual([r.deposit_status, r.deposit], ['pending', '1250.00'])
  })

  test('declining queues nothing; an expired quote can’t be answered; only the server claims deposits', async () => {
    const id = await quote('Link pergola', 5000)
    const token = (await row(id)).quote_token
    await asAnon(`select answer_quote_by_token($1, false, '')`, [token])
    assert.deepEqual([(await row(id)).status, (await row(id)).deposit_status], ['rejected', 'none'])
    const old = await quote('Link shed', 5000)
    await asUser(uid.admin, `update projects set quote_valid_until = '2020-01-01' where id = $1`, [old])
    await assert.rejects(asAnon(`select answer_quote_by_token($1, true, 'Sam')`, [(await row(old)).quote_token]), /expired on 01\/01\/2020/)
    await assert.rejects(asUser(uid.admin, `select * from claim_deposit_invoices(5)`), /permission denied/)
    const claimed = (await pool.query(`select id, deposit_amount::text as amount from claim_deposit_invoices(50)`)).rows
    assert.ok(claimed.some((c) => c.amount === '880.00'))
    assert.equal((await pool.query(`select count(*) from claim_deposit_invoices(50)`)).rows[0].count, '0', 'not claimed twice')
  })
})

describe('automatic quote follow-ups', () => {
  const issued = async (title: string, daysAgo: number, phone = '0400 777 888') => {
    const client = (await pool.query(`insert into profiles (name, email, phone, role, status) values ('Fay Follow', 'fay-${title}@example.com', $1, 'client', 'active') returning id`, [phone])).rows[0].id
    const prop = (await pool.query(`insert into properties (client_id, address) values ($1, '3 Oak St') returning id`, [client])).rows[0].id
    const id = (await pool.query(`insert into projects (client_id, property_id, title, quote_amount, status) values ($1, $2, $3, 4400, 'quoted') returning id`, [client, prop, title])).rows[0].id
    await pool.query(`update projects set quote_issued_at = now() - make_interval(days => $2) where id = $1`, [id, daysAgo])
    return id
  }
  const texts = async (id: string) => (await pool.query(`select message, event from sms_outbox where source = 'quote_followup' and event like 'Quote follow-up · P-' || (select number from projects where id = $1) || ' · %' order by created_at`, [id])).rows
  const on = (patch: object) => pool.query(`update settings set sms = sms || $1::jsonb where id = 1`, [JSON.stringify(patch)])

  test('off until switched on; then due quotes get one text with their link, once', async () => {
    const id = await issued('Fence fu', 3)
    assert.equal((await pool.query(`select send_quote_followups()`)).rows[0].send_quote_followups, 0)
    await on({ quoteFollowUps: true, quoteFollowUpDays: [3, 7] })
    await pool.query(`select send_quote_followups()`)
    const [t] = await texts(id)
    const token = (await pool.query(`select quote_token from projects where id = $1`, [id])).rows[0].quote_token
    assert.equal(t.message, `Hi Fay, it's Daniel from Next Phase Maintenance. Just checking you got our quote for Fence fu: $4,400.00 inc. GST. You can read it and accept it here: https://portal.nextphasemaintenance.com.au/#/quote/${token} Happy to answer any questions.`)
    assert.match(t.event, / · 1$/)
    assert.equal((await pool.query(`select quote_followed_up_at > now() - interval '1 minute' as ok from projects where id = $1`, [id])).rows[0].ok, true)
    await pool.query(`select send_quote_followups()`)
    assert.equal((await texts(id)).length, 1, 'not twice')
  })

  test('the next step goes out later; never when answered, expired, followed up recently or without a mobile', async () => {
    await on({ quoteFollowUps: true, quoteFollowUpDays: [3, 7] })
    const id = await issued('Deck fu', 8)
    await pool.query(`select send_quote_followups()`)
    assert.deepEqual((await texts(id)).map((t) => t.event.slice(-1)), ['2'], 'only the latest due step')
    const answered = await issued('Shed fu', 4)
    await pool.query(`update projects set status = 'approved' where id = $1`, [answered])
    const expired = await issued('Gate fu', 4)
    await pool.query(`update projects set quote_valid_until = current_date - 1 where id = $1`, [expired])
    const recent = await issued('Path fu', 4)
    await pool.query(`update projects set quote_followed_up_at = now() - interval '1 day' where id = $1`, [recent])
    const nophone = await issued('Roof fu', 4, '')
    const early = await issued('Wall fu', 1)
    await pool.query(`select send_quote_followups()`)
    for (const x of [answered, expired, recent, nophone, early]) assert.equal((await texts(x)).length, 0)
    await on({ quoteFollowUps: false })
  })
})

describe('quotes as QuickBooks estimates', () => {
  test('issuing queues its estimate; answering queues the update; only the server records it', async () => {
    const id = (await asUser<{ id: string }>(uid.admin, `insert into projects (client_id, property_id, title, quote_amount) values ('u-client-1', 'p-1', 'Est deck', 5500) returning id`)).rows[0].id
    const est = async () => (await pool.query(`select estimate_status, qbo_estimate_id from projects where id = $1`, [id])).rows[0]
    assert.equal((await est()).estimate_status, 'none')
    await asUser(uid.admin, `update projects set status = 'quoted' where id = $1`, [id])
    assert.equal((await est()).estimate_status, 'pending')
    await asUser(uid.admin, `update projects set qbo_estimate_id = 'x', estimate_status = 'synced' where id = $1`, [id])
    assert.deepEqual(await est(), { estimate_status: 'pending', qbo_estimate_id: null })
    await assert.rejects(asUser(uid.admin, `select * from claim_quote_estimates(5)`), /permission denied/)
    assert.ok((await pool.query(`select id from claim_quote_estimates(50)`)).rows.some((r) => r.id === id))
    await pool.query(`update projects set estimate_status = 'synced', qbo_estimate_id = '77' where id = $1`, [id])
    await asUser(uid.sarah, `update projects set status = 'approved' where id = $1`, [id])
    assert.deepEqual(await est(), { estimate_status: 'pending', qbo_estimate_id: '77' })
    await pool.query(`update projects set estimate_status = 'failed' where id = $1`, [id])
    await assert.rejects(asUser(uid.sarah, `select retry_quote_estimate($1)`, [id]), /Manage projects/)
    await asUser(uid.admin, `select retry_quote_estimate($1)`, [id])
    assert.equal((await est()).estimate_status, 'pending')
  })
})

describe('deleting quotes', () => {
  const quote = async (title: string, status = 'quoted') => {
    const id = (await asUser<{ id: string }>(uid.admin, `insert into projects (client_id, property_id, title, quote_amount) values ('u-client-1', 'p-1', $1, 3300) returning id`, [title])).rows[0].id
    if (status !== 'quote_requested') await pool.query(`update projects set status = $2 where id = $1`, [id, status])
    return id
  }
  const exists = async (id: string) => (await pool.query(`select 1 from projects where id = $1`, [id])).rowCount === 1

  test('only managers delete; its QuickBooks estimate and unpaid invoices are queued against our company', async () => {
    await pool.query(`insert into qbo_connection (id, realm_id, pinned_realm_id) values (1, '4242', '4242') on conflict (id) do update set realm_id = '4242', pinned_realm_id = '4242'`)
    const id = await quote('Del deck')
    await pool.query(`update projects set qbo_estimate_id = '501', estimate_status = 'synced' where id = $1`, [id])
    const inv = (await pool.query(`insert into invoices (project_id, client_id, qb_invoice_number, amount, status, due_date, qbo_invoice_id) values ($1, 'u-client-1', 'DEP-P9', 330, 'sent', current_date, '502') returning id`, [id])).rows[0].id
    await pool.query(`insert into project_documents (project_id, name, path, size_bytes, content_type) values ($1, 'plan.pdf', 'docs/plan.pdf', 10, 'application/pdf')`, [id])
    await assert.rejects(asUser(uid.sarah, `select delete_quote($1)`, [id]), /Manage projects/)
    await assert.rejects(asUser(uid.dan, `select delete_quote($1)`, [id]), /Manage projects/)
    const out = (await asUser<{ r: { estimates: number; invoices: number; documents: string[] } }>(uid.admin, `select delete_quote($1) as r`, [id])).rows[0].r
    assert.deepEqual(out.estimates, 1)
    assert.deepEqual(out.invoices, 1)
    assert.deepEqual(out.documents, ['docs/plan.pdf'])
    assert.equal(await exists(id), false)
    assert.equal((await pool.query(`select 1 from invoices where id = $1`, [inv])).rowCount, 0)
    const queued = (await pool.query(`select kind, qbo_id, realm_id, status from qbo_cleanup where label like '%Del deck%' order by kind`)).rows
    assert.deepEqual(queued, [
      { kind: 'estimate', qbo_id: '501', realm_id: '4242', status: 'pending' },
      { kind: 'invoice', qbo_id: '502', realm_id: '4242', status: 'pending' },
    ])
    await assert.rejects(asUser(uid.admin, `select * from qbo_cleanup`), /permission denied/)
    await assert.rejects(asUser(uid.admin, `select * from claim_qbo_cleanup(5)`), /permission denied/)
  })

  test('never a job under way, anything with money paid, or one QuickBooks is busy with', async () => {
    const job = await quote('Del job', 'in_progress')
    await assert.rejects(asUser(uid.admin, `select delete_quote($1)`, [job]), /under way or finished/)
    const paid = await quote('Del paid', 'approved')
    await pool.query(`insert into invoices (project_id, client_id, qb_invoice_number, amount, status, due_date) values ($1, 'u-client-1', 'DEP-P8', 330, 'paid', current_date)`, [paid])
    await assert.rejects(asUser(uid.admin, `select delete_quote($1)`, [paid]), /Money has been paid/)
    const busy = await quote('Del busy')
    await pool.query(`update projects set estimate_status = 'working' where id = $1`, [busy])
    await assert.rejects(asUser(uid.admin, `select delete_quote($1)`, [busy]), /right now/)
    for (const x of [job, paid, busy]) assert.equal(await exists(x), true)
    // A request not yet priced, never in QuickBooks: just goes.
    const plain = await quote('Del plain', 'quote_requested')
    const r = (await asUser<{ r: { estimates: number; invoices: number } }>(uid.admin, `select delete_quote($1) as r`, [plain])).rows[0].r
    assert.deepEqual([r.estimates, r.invoices], [0, 0])
    assert.equal(await exists(plain), false)
  })

  test('in QuickBooks but QuickBooks not connected or locked: refused, so nothing is left behind there', async () => {
    await pool.query(`update qbo_connection set realm_id = null, pinned_realm_id = null where id = 1`)
    const id = await quote('Del orphan')
    await pool.query(`update projects set qbo_estimate_id = '601', estimate_status = 'synced' where id = $1`, [id])
    await assert.rejects(asUser(uid.admin, `select delete_quote($1)`, [id]), /isn't connected/)
    assert.equal(await exists(id), true)
  })
})
