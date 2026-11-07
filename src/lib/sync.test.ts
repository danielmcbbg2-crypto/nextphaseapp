import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assemble, diff, fetchRaw, TABLES, tablesToRefresh, type DbAdapter, type RawData, type Row, type TableName } from './db'
import { paymentAmounts } from './quote'
import { createSeed } from './seed'
import type { Project } from './types'

const emptyRaw = (): RawData => ({ tables: Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as RawData['tables'], booked: [] })

test('a change event reads only its table (and the tables that follow it)', () => {
  assert.deepEqual(tablesToRefresh(['leads']), ['leads'])
  assert.deepEqual(tablesToRefresh(['leads', 'inbox', 'leads']), ['inbox', 'leads'])
  const projects = tablesToRefresh(['projects'])
  assert.ok(projects !== 'all')
  for (const t of ['projects', 'properties', 'invoices', 'project_tasks', 'project_documents'] as TableName[]) assert.ok(projects.includes(t), t)
  assert.ok(!projects.includes('leads'))
  assert.equal(tablesToRefresh(['profiles']), 'all')
  // Tables the app doesn't load are ignored.
  assert.deepEqual(tablesToRefresh(['sms_outbox', 'qbo_tokens']), [])
})

test('assemble builds the same data twice without changing the rows it was given', () => {
  const raw = emptyRaw()
  raw.tables.projects = [{ id: 'p1', number: 1, title: 'Own', status: 'quoted', client_id: 'c', property_id: 'h', created_at: '2026-01-01' }]
  raw.tables.properties = [{ id: 'h', client_id: 'c', address: 'B St' }]
  raw.tables.project_tasks = [{ id: 't1', project_id: 'p2', position: 0, title: 'Tile', start_date: '2026-02-01', end_date: '2026-02-01', status: 'planned' }]
  raw.booked = [{ id: 'p2', number: 2, title: 'Booked', status: 'in_progress', address: 'A St', suburb: 'X', postcode: '3000' }]
  const before = JSON.stringify(raw)
  const a = assemble(raw)
  const b = assemble(raw)
  assert.equal(JSON.stringify(raw), before)
  assert.deepEqual(a, b)
  assert.equal(a.projects.length, 2)
  assert.equal(a.properties.length, 2)
  assert.equal(a.projects.find((p) => p.id === 'p2')!.tasks.length, 1)
})

test('fetchRaw reads every table and the booked projects', async () => {
  const read: string[] = []
  const db: DbAdapter = {
    select: async (t) => {
      read.push(t)
      return t === 'leads' ? [{ id: 'l1' } as Row] : []
    },
    insert: async () => {},
    update: async () => {},
    remove: async () => {},
    call: async () => [{ id: 'b1' }],
  }
  const raw = await fetchRaw(db)
  assert.deepEqual([...read].sort(), [...TABLES].sort())
  assert.equal(raw.tables.leads.length, 1)
  assert.equal(raw.booked.length, 1)
})

test('diff finds a changed field, an insert and a delete, and nothing for an unchanged copy', () => {
  const prev = createSeed()
  assert.deepEqual(diff(prev, structuredClone(prev)), [])
  const next = structuredClone(prev)
  next.requests[0].title = 'Changed'
  const gone = next.leads.shift()
  next.inbox.unshift({ id: 'n-new', userId: next.users[0].id, title: 'Hi', body: '', createdAt: '2026-01-01', read: false, requiresAck: false, acknowledged: false })
  const ops = diff(prev, next)
  assert.deepEqual(
    ops.find((o) => o.kind === 'update'),
    { kind: 'update', table: 'requests', id: prev.requests[0].id, patch: { title: 'Changed' } },
  )
  assert.equal(ops.filter((o) => o.kind === 'update').length, 1)
  assert.ok(ops.some((o) => o.kind === 'insert' && o.table === 'inbox' && o.rows[0].id === 'n-new'))
  if (gone) assert.ok(ops.some((o) => o.kind === 'delete' && o.table === 'leads' && o.id === gone.id))
  // The next edit diffs from this copy (its rows cached as "next" above).
  const third = structuredClone(next)
  third.requests[0].title = 'Again'
  assert.deepEqual(diff(next, third), [{ kind: 'update', table: 'requests', id: prev.requests[0].id, patch: { title: 'Again' } }])
})

test('two balance stages share the remainder, the last taking the rounding', () => {
  const p = {
    id: 'p',
    quoteItems: [],
    quoteAmount: 1000,
    variations: [],
    payments: [
      { id: 'd', title: 'Deposit', basis: 'percent', value: 10 },
      { id: 'b1', title: 'Progress', basis: 'balance', value: 0 },
      { id: 'b2', title: 'Final', basis: 'balance', value: 0 },
    ],
  } as unknown as Project
  const out = paymentAmounts(p, [])
  assert.equal(out.get('d'), 100)
  assert.equal(out.get('b1'), 450)
  assert.equal(out.get('b2'), 450)
  p.quoteAmount = 1000.01
  p.payments[0] = { id: 'd', title: 'Deposit', basis: 'amount', value: 0 }
  p.payments.push({ id: 'b3', title: 'Retention', basis: 'balance', value: 0 })
  const three = paymentAmounts(p, [])
  assert.equal(three.get('b1'), 333.34)
  assert.equal(three.get('b2'), 333.34)
  assert.equal(three.get('b3'), 333.33)
  assert.equal(Math.round((three.get('b1')! + three.get('b2')! + three.get('b3')!) * 100) / 100, 1000.01)
})
