import { useState, type FormEvent } from 'react'
import { ArrowLeft, Mail, Plus, Trash2 } from 'lucide-react'
import { Empty, Field, Modal, PageHeader, Sep, Stat, Tabs } from '../../components/ui'
import { ProjectBy, ProjectProgress } from '../../components/works'
import { ProjectStatusText } from '../../components/status'
import { ExpenseTable } from '../provider/ProviderPortal'
import { hasNoLogin, stampQuoteDecision, useLookup, useStore, type NewProject } from '../../lib/store'
import { DEFAULT_PERMISSIONS, PROJECT_STATUS_LABEL, type PaymentStage, type Project, type ProjectStatus, type Property, type StoreOrder, type UserAccount } from '../../lib/types'
import { contractTotal, nextInvoiceNumber, paymentAmounts, projectFinancials, quoteTotal, withGst } from '../../lib/quote'
import { fmtDate, money, toISODate, todayISO, uid } from '../../lib/utils'
import { navigate } from '../../lib/router'
import { openOnArrival } from '../../lib/openOnArrival'
import { TextButton } from '../../components/TextMessage'
import { CostsPanel, PaymentsPanel, QuoteBuilder, VariationsPanel } from './ProjectCommercials'
import { DefectsPanel, DiaryPanel, DocumentsPanel, Fact, ScheduleSummary, SchedulePanel } from './ProjectWorkspace'
import { useHashRoute } from '../../lib/router'
import { BookingReminders } from './BookingReminders'
import { DeleteQuote, DepositPanel, EstimateLine, SendQuoteLink } from './QuoteLinkPanels'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** A list of rows merged three ways: the editor's own changes win, everyone else's are kept. */
function mergeRows<T extends { id: string }>(draft: T[], base: T[], live: T[]): T[] {
  const baseById = new Map(base.map((r) => [r.id, r]))
  const liveById = new Map(live.map((r) => [r.id, r]))
  const draftIds = new Set(draft.map((r) => r.id))
  const out: T[] = []
  for (const r of draft) {
    const b = baseById.get(r.id)
    const l = liveById.get(r.id)
    // Untouched in the editor: take what's stored now (or leave it out if someone removed it).
    if (b && same(r, b)) {
      if (l) out.push(l)
    } else out.push(r)
  }
  // Added by someone else (a trade's expense, a client's variation) while the editor was open.
  for (const l of live) if (!draftIds.has(l.id) && !baseById.has(l.id)) out.push(l)
  return out
}

/**
 * A project draft, saved over what's stored now. The diary, defects and documents are saved as
 * they're added (by the office, trades and the client), so they always come from the stored project.
 * Given the project as it was when the editor opened (`base`), only what the editor changed is
 * applied: a trade's expense or a client's variation decision made meanwhile isn't wiped out.
 */
function keepLiveParts(next: Project, current: Project | undefined, base?: Project): Project {
  if (!current) return next
  if (base) {
    const merged = next as unknown as Record<string, unknown>
    const b = base as unknown as Record<string, unknown>
    const c = current as unknown as Record<string, unknown>
    for (const k of Object.keys(merged)) {
      const d = merged[k]
      if (Array.isArray(d) && Array.isArray(b[k]) && Array.isArray(c[k]) && d.every((r) => r && typeof r === 'object' && 'id' in r)) {
        merged[k] = mergeRows(d as { id: string }[], b[k] as { id: string }[], c[k] as { id: string }[])
      } else if (same(d, b[k]) && k in c) merged[k] = c[k]
    }
  }
  next.diary = current.diary
  next.defects = current.defects
  next.documents = current.documents
  return next
}
const draftKey = (p: Project) => JSON.stringify({ ...p, diary: null, defects: null, documents: null })

/** Saves a project edited in the office, telling the trade, the client and so on what changed for them. */
export function useSaveProject() {
  const { data, user, update, pushInbox } = useStore()
  return (p: Project, base?: Project) => {
    const before = data.projects.find((x) => x.id === p.id)
    update((d) => {
      const next = keepLiveParts(structuredClone(p), d.projects.find((x) => x.id === p.id), base)
      if (before) stampQuoteDecision(next, before.status, user?.id)
      d.projects = d.projects.map((x) => (x.id === p.id ? next : x))
    })
    if (before && p.assignedProviderId && p.assignedProviderId !== before.assignedProviderId) {
      pushInbox({ userId: p.assignedProviderId, title: `Assigned to project P-${p.number}`, body: p.title, requiresAck: true, projectId: p.id })
    }
    if (before && p.status === 'quoted' && before.status !== 'quoted') {
      pushInbox({ userId: p.clientId, title: `Quote ready: ${p.title}`, body: `Quoted at ${money(p.quoteAmount ?? 0)}. Review it under Projects.`, requiresAck: false, projectId: p.id })
    }
    const added = p.variations.filter((v) => v.status === 'proposed' && !before?.variations.some((x) => x.id === v.id))
    if (before && added.length) {
      pushInbox({
        userId: p.clientId,
        title: added.length === 1 ? `Variation V${added[0].number} for approval: ${p.title}` : `${added.length} variations for approval: ${p.title}`,
        body: added.map((v) => `V${v.number} ${v.title}: ${money(withGst(v.amount))} inc GST`).join('\n') + '\nApprove or decline under Projects.',
        requiresAck: false,
        projectId: p.id,
      })
    }
  }
}

/** Payment stages ready to claim: their milestone is done (or, for a first stage without one, the job is underway) and no invoice yet. */
export function claimsReady(p: Project) {
  return p.payments.filter((s, i) => {
    if (s.invoiceId) return false
    const m = p.milestones.find((x) => x.id === s.milestoneId)
    return m ? m.done : i === 0 && (p.status === 'approved' || p.status === 'in_progress')
  })
}

/** The next milestone not yet done. */
const nextMilestone = (p: Project) => [...p.milestones].filter((m) => !m.done).sort((a, b) => a.date.localeCompare(b.date))[0]

/** Admin → Projects: work that's been won, from approval to completion. */
export function AdminProjects() {
  const { data, update } = useStore()
  const lk = useLookup()
  const save = useSaveProject()
  const route = useHashRoute()
  const [tab, setTab] = useState<'active' | 'closed'>('active')
  const [creating, setCreating] = useState(false)

  const active = data.projects.filter((p) => p.status === 'approved' || p.status === 'in_progress')
  // Declined quotes and cancelled jobs stay here too, so an old one can be reopened.
  const closed = data.projects.filter((p) => p.status === 'completed' || p.status === 'rejected')
  const list = tab === 'active' ? active : closed
  const pendingExpenses = data.projects.flatMap((p) => p.expenses.filter((e) => e.status === 'submitted').map((e) => ({ e, p })))
  const ready = active.flatMap((p) => {
    const amounts = paymentAmounts(p, data.invoices)
    return claimsReady(p).map((s) => ({ p, s, amount: amounts.get(s.id) ?? 0 }))
  })
  const today = todayISO()
  const overdue = active.filter((p) => p.milestones.some((m) => !m.done && m.date < today))

  const setExpense = (pid: string, eid: string, status: 'approved' | 'rejected') =>
    update((d) => {
      const e = d.projects.find((p) => p.id === pid)?.expenses.find((x) => x.id === eid)
      if (e) e.status = status
    })

  // #/admin/projects/<id>[/<tab>] opens the project's workspace.
  const [, , openId, openTab] = route
  const opened = openId ? data.projects.find((p) => p.id === openId) : undefined
  if (opened) {
    return (
      <ProjectEditor
        key={opened.id}
        project={opened}
        asPage
        initialTab={(openTab as EditorTab | undefined) ?? 'overview'}
        onClose={() => navigate('/admin/projects')}
        onSave={save}
      />
    )
  }

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Work you've won, from go-ahead to handover."
        actions={<button className="btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New project</button>}
      />
      <div className="card mb-6 grid divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
        <Stat label="Active projects" value={active.length} hint={`${active.filter((p) => p.status === 'in_progress').length} under way`} />
        <Stat label="Contract value" value={money(active.reduce((s, p) => s + contractTotal(p), 0))} hint="active, inc GST" />
        <Stat label="Ready to claim" value={money(ready.reduce((s, x) => s + x.amount, 0))} hint={`${ready.length} payment stage${ready.length === 1 ? '' : 's'}`} />
        <Stat label="Behind schedule" value={overdue.length} hint="with an overdue milestone" />
      </div>
      <div className="mb-6">
        <BookingReminders />
      </div>
      {pendingExpenses.length > 0 && (
        <section className="card mb-6 overflow-hidden">
          <h2 className="border-b border-slate-200 px-5 py-3 font-bold">Expenses awaiting approval</h2>
          <ExpenseTable
            expenses={pendingExpenses.map((x) => x.e)}
            actions={(e) => {
              const pid = pendingExpenses.find((x) => x.e.id === e.id)!.p.id
              return (
                <div className="flex justify-end gap-1.5">
                  <button className="btn-primary px-2.5 py-1 text-xs" onClick={() => setExpense(pid, e.id, 'approved')}>Approve</button>
                  <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setExpense(pid, e.id, 'rejected')}>Reject</button>
                </div>
              )
            }}
          />
        </section>
      )}
      {ready.length > 0 && (
        <section className="card mb-6 overflow-hidden">
          <h2 className="border-b border-slate-200 px-5 py-3 font-bold">Ready to claim</h2>
          <ul className="divide-y divide-slate-100">
            {ready.map(({ p, s, amount }) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <span>
                  <span className="num text-xs text-slate-500">P-{p.number}</span> <span className="font-semibold">{p.title}</span> · {s.title}
                </span>
                <span className="flex items-center gap-3">
                  <span className="num font-semibold">{money(amount)}</span>
                  <button className="btn-ghost px-3 py-1" onClick={() => navigate(`/admin/projects/${p.id}/payments`)}>Open payments</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'active', label: 'Active projects', count: active.length },
          { value: 'closed', label: 'Closed', count: closed.length },
        ]}
      />
      {list.length === 0 ? (
        <Empty title={tab === 'active' ? 'No active projects' : 'Nothing closed yet'}>
          {tab === 'active' ? 'Accepted quotes show up here.' : undefined}
        </Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Project</th>
                <th className="th">Client</th>
                <th className="th">Status</th>
                <th className="th">Progress</th>
                <th className="th text-right">Contract</th>
                <th className="th text-right">Margin</th>
                <th className="th text-right">Paid</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((p) => {
                const prop = lk.property(p.propertyId)
                const fin = projectFinancials(p, data.invoices)
                const next = nextMilestone(p)
                const late = next && next.date < today
                return (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="td">
                      <span className="num text-xs text-slate-500">P-{p.number}</span>
                      <p className="font-semibold">{p.title}</p>
                      <p className="text-xs text-slate-500">{prop?.address}, {prop?.suburb}</p>
                      <ProjectBy p={p} />
                    </td>
                    <td className="td">
                      {lk.user(p.clientId)?.name}
                      {p.assignedProviderId && <p className="text-xs text-slate-500">Trade: {lk.user(p.assignedProviderId)?.name}</p>}
                    </td>
                    <td className="td"><ProjectStatusText s={p.status} /></td>
                    <td className="td">
                      <ProjectProgress p={p} />
                      {next && (
                        <p className={`mt-1 text-xs ${late ? 'font-semibold text-red-600' : 'text-slate-500'}`}>
                          {late ? 'Overdue: ' : 'Next: '}{next.title} · {fmtDate(next.date)}
                        </p>
                      )}
                    </td>
                    <td className="td num text-right">
                      {p.quoteAmount || p.quoteItems.length ? money(contractTotal(p)) : '—'}
                      {p.variations.some((v) => v.status === 'proposed') && <p className="text-xs text-amber-700">variation pending</p>}
                    </td>
                    <td className={`td num text-right ${fin.margin < 0 ? 'text-red-600' : ''}`}>{fin.contract ? `${fin.marginPct}%` : '—'}</td>
                    <td className="td num text-right">{money(fin.paid)}</td>
                    <td className="td text-right"><button className="btn-ghost px-3 py-1.5" onClick={() => navigate(`/admin/projects/${p.id}`)}>Manage</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewProjectForm
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false)
            if (p.status === 'completed' || p.status === 'rejected') setTab('closed')
            else if (p.status === 'quote_requested' || p.status === 'quoted') navigate('/admin/quotes')
            else navigate(`/admin/projects/${p.id}`)
          }}
        />
      )}
    </>
  )
}

const NEW = '__new'
const NEW_PROJECT_STATUSES: ProjectStatus[] = ['quote_requested', 'quoted', 'approved', 'in_progress']

/**
 * An admin sets up a project for any client, including one added here without a login: the client
 * sees it (with its property) once they're invited and sign in.
 */
export function NewProjectForm({ onClose, onCreated, quote = false }: { onClose: () => void; onCreated: (p: Project) => void; quote?: boolean }) {
  const { data, can, createProject } = useStore()
  const lk = useLookup()
  // Ids are made once, so saving again after an error doesn't add the client or property twice.
  const [ids, setIds] = useState(() => ({ client: uid('u'), property: uid('p') }))
  const canAddClient = can('canEditPermissions')
  const clients = [...lk.clients].sort((a, b) => a.name.localeCompare(b.name))
  const [clientId, setClientId] = useState(canAddClient && clients.length === 0 ? NEW : '')
  const [client, setClient] = useState({ name: '', email: '', phone: '', company: '' })
  const [propertyId, setPropertyId] = useState('')
  const [property, setProperty] = useState({ address: '', suburb: '', postcode: '' })
  const [p, setP] = useState({
    title: '',
    description: '',
    type: 'renovation' as Project['type'],
    status: (quote ? 'quote_requested' : 'approved') as ProjectStatus,
    budget: '',
    quoteAmount: '',
    scopeOfWorks: '',
    assignedProviderId: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A client added here (or saved by an earlier attempt) has no properties yet, so it needs a new one.
  const newClient = clientId === NEW && !data.users.some((u) => u.id === ids.client)
  const effectiveClientId = clientId === NEW ? ids.client : clientId
  const properties = data.properties.filter((x) => x.clientId === effectiveClientId)
  // After an attempt that saved the new property but not the project, carry on with that property.
  const savedProperty = data.properties.find((x) => x.id === ids.property)
  const reuseSaved = !!savedProperty && savedProperty.clientId === effectiveClientId && (!propertyId || propertyId === NEW)
  const newProperty = !reuseSaved && (propertyId === NEW || (!!effectiveClientId && properties.length === 0))
  const chosenProperty = reuseSaved ? ids.property : propertyId === NEW ? '' : propertyId
  // A new property for another client (or a second one) can't reuse the saved property's id.
  const freshPropertyId = () => savedProperty && setIds((i) => ({ ...i, property: uid('p') }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!effectiveClientId) return setError('Choose the client.')
    if (!newProperty && !chosenProperty) return setError('Choose the property.')
    const email = client.email.trim()
    if (newClient && email && data.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
      return setError('Another account already uses this email. Choose that client instead.')
    }
    if (p.status === 'quoted' && !(Number(p.quoteAmount) > 0)) return setError('Enter the quote amount to create it as an issued quote.')
    const input: NewProject = {
      newClient: newClient
        ? ({
            id: ids.client,
            name: client.name.trim(),
            email,
            phone: client.phone.trim(),
            company: client.company.trim() || undefined,
            role: 'client',
            permissions: DEFAULT_PERMISSIONS.client,
            status: 'invited',
            createdAt: new Date().toISOString(),
            passwordHash: '',
            hasLogin: false,
          } satisfies UserAccount)
        : undefined,
      newProperty: newProperty
        ? ({
            id: ids.property,
            clientId: effectiveClientId,
            address: property.address.trim(),
            suburb: property.suburb.trim(),
            postcode: property.postcode.trim(),
            paintColors: { walls: '', trim: '', ceiling: '' },
            skirtProfile: '',
            claddingType: '',
            accessCode: '',
            notes: '',
          } satisfies Property)
        : undefined,
      project: {
        clientId: effectiveClientId,
        propertyId: newProperty ? ids.property : chosenProperty,
        title: p.title.trim(),
        description: p.description.trim(),
        type: p.type,
        status: p.status,
        budget: Number(p.budget) || 0,
        quoteAmount: p.quoteAmount ? Number(p.quoteAmount) : undefined,
        scopeOfWorks: p.scopeOfWorks.trim(),
        assignedProviderId: p.assignedProviderId || undefined,
      },
    }
    setBusy(true)
    setError(null)
    try {
      onCreated(await createProject(input))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={quote ? 'New quote' : 'New project'} width="max-w-3xl">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        <Field label="Client" className="sm:col-span-2">
          <select
            className="input"
            required
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value)
              setPropertyId('')
              freshPropertyId()
            }}
          >
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.company ? ` — ${c.company}` : ''}
                {hasNoLogin(c) ? ' (no login)' : ''}
              </option>
            ))}
            {canAddClient && <option value={NEW}>+ New client (no login yet)</option>}
          </select>
        </Field>
        {newClient && (
          <fieldset className="grid gap-4 rounded-md border border-slate-200 p-4 sm:col-span-2 sm:grid-cols-2">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">New client</legend>
            <p className="text-xs text-slate-500 sm:col-span-2">
              Added without a login and sent nothing. Invite them from Accounts whenever you like; they'll see this project when they sign in.
            </p>
            <Field label="Full name"><input className="input" required value={client.name} onChange={(e) => setClient({ ...client, name: e.target.value })} /></Field>
            <Field label="Email (needed to invite them)">
              <input className="input" type="email" value={client.email} onChange={(e) => setClient({ ...client, email: e.target.value })} />
            </Field>
            <Field label="Mobile"><input className="input num" type="tel" value={client.phone} onChange={(e) => setClient({ ...client, phone: e.target.value })} /></Field>
            <Field label="Company"><input className="input" value={client.company} onChange={(e) => setClient({ ...client, company: e.target.value })} /></Field>
          </fieldset>
        )}
        {effectiveClientId && properties.length > 0 && (
          <Field label="Property" className="sm:col-span-2">
            <select
              className="input"
              required
              value={newProperty ? NEW : chosenProperty}
              onChange={(e) => {
                setPropertyId(e.target.value)
                if (e.target.value === NEW) freshPropertyId()
              }}
            >
              <option value="">Choose a property…</option>
              {properties.map((x) => (
                <option key={x.id} value={x.id}>{x.address}, {x.suburb}</option>
              ))}
              <option value={NEW}>+ New property</option>
            </select>
          </Field>
        )}
        {newProperty && (
          <fieldset className="grid gap-4 rounded-md border border-slate-200 p-4 sm:col-span-2 sm:grid-cols-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">New property</legend>
            <Field label="Street address" className="sm:col-span-3">
              <input className="input" required value={property.address} onChange={(e) => setProperty({ ...property, address: e.target.value })} />
            </Field>
            <Field label="Suburb" className="sm:col-span-2">
              <input className="input" value={property.suburb} onChange={(e) => setProperty({ ...property, suburb: e.target.value })} />
            </Field>
            <Field label="Postcode">
              <input className="input num" inputMode="numeric" value={property.postcode} onChange={(e) => setProperty({ ...property, postcode: e.target.value })} />
            </Field>
          </fieldset>
        )}
        <Field label="Project title" className="sm:col-span-2">
          <input className="input" required value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} placeholder="e.g. Kitchen renovation" />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <textarea className="input min-h-[80px]" value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
        </Field>
        <Field label="Type">
          <select className="input" value={p.type} onChange={(e) => setP({ ...p, type: e.target.value as Project['type'] })}>
            <option value="renovation">Renovation</option>
            <option value="maintenance_contract">Maintenance contract</option>
          </select>
        </Field>
        <Field label="Status">
          <select className="input" value={p.status} onChange={(e) => setP({ ...p, status: e.target.value as ProjectStatus })}>
            {NEW_PROJECT_STATUSES.map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field label="Budget (AUD)">
          <input type="number" min="0" step="any" className="input num" value={p.budget} onChange={(e) => setP({ ...p, budget: e.target.value })} />
        </Field>
        <Field label="Quote amount (AUD, inc. GST)">
          <input type="number" min="0" step="0.01" className="input num" value={p.quoteAmount} onChange={(e) => setP({ ...p, quoteAmount: e.target.value })} />
        </Field>
        <Field label="Assigned trade" className="sm:col-span-2">
          <select className="input" value={p.assignedProviderId} onChange={(e) => setP({ ...p, assignedProviderId: e.target.value })}>
            <option value="">Unassigned</option>
            {lk.providers.map((u) => <option key={u.id} value={u.id}>{u.name}{u.trade ? ` (${u.trade})` : ''}{hasNoLogin(u) ? ' (no login)' : u.status === 'invited' ? ' (invite pending)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Scope of works" className="sm:col-span-2">
          <textarea className="input min-h-[80px]" value={p.scopeOfWorks} onChange={(e) => setP({ ...p, scopeOfWorks: e.target.value })} />
        </Field>
        {error && <p className="text-sm text-red-600 sm:col-span-2">{error}</p>}
        <div className="flex justify-end sm:col-span-2">
          <button className="btn-primary" disabled={busy}>{busy ? 'Creating…' : quote ? 'Create quote' : 'Create project'}</button>
        </div>
      </form>
    </Modal>
  )
}

export type EditorTab = 'overview' | 'schedule' | 'diary' | 'defects' | 'documents' | 'quote' | 'variations' | 'payments' | 'costs'

/**
 * An issued installation quote for a store order: one tap to email or text the price to the person
 * who ordered (their order's details, as a visitor may have no account email).
 */
function SendInstallPrice({ p, order }: { p: Project; order: StoreOrder }) {
  const { update } = useStore()
  const first = order.name.split(' ')[0] || 'there'
  const amount = money(p.quoteItems.length ? quoteTotal(p) : (p.quoteAmount ?? 0))
  const message = `Hi ${first}, it's Next Phase Maintenance. The installation for your store order #${order.number} comes to ${amount} inc. GST${
    p.quoteValidUntil ? `, valid until ${fmtDate(p.quoteValidUntil)}` : ''
  }. Reply to this message to accept or with any questions, and we'll book it in.`
  const sent = () =>
    update((d) => {
      const x = d.projects.find((y) => y.id === p.id)
      if (x) x.quoteFollowedUpAt = new Date().toISOString()
    })
  return (
    <span className="mr-auto flex flex-wrap items-center gap-2 text-sm">
      <span className="text-slate-600">Send the price to {order.name}:</span>
      {order.email && (
        <a
          className="btn-ghost px-3 py-1.5"
          href={`mailto:${order.email}?subject=${encodeURIComponent(`Installation quote for order #${order.number}`)}&body=${encodeURIComponent(message)}`}
          onClick={sent}
        >
          <Mail size={15} aria-hidden="true" /> Email
        </a>
      )}
      {order.phone && <TextButton phone={order.phone} message={message} event={`Install quote P-${p.number}`} label="Text" className="btn-ghost px-3 py-1.5" onOpen={sent} />}
    </span>
  )
}

export function ProjectEditor({
  project,
  onClose,
  onSave,
  initialTab = 'overview',
  asPage = false,
}: {
  project: Project
  onClose: () => void
  /** `base` is the project as it was when this draft started, so others' changes since are kept. */
  onSave: (p: Project, base: Project) => void
  initialTab?: EditorTab
  /** The full project workspace (with schedule, diary, defects and documents) instead of a pop-up. */
  asPage?: boolean
}) {
  const { data, can, update } = useStore()
  const lk = useLookup()
  const [p, setP] = useState<Project>(project)
  // What's stored now: a claim raised here saves straight away.
  const [saved, setSaved] = useState<Project>(project)
  const [tab, setTab] = useState<EditorTab>(initialTab)
  const [ms, setMs] = useState({ title: '', date: todayISO() })
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<Project>) => setP((cur) => ({ ...cur, ...patch }))
  const prop = lk.property(p.propertyId)
  const dirty = draftKey(p) !== draftKey(saved)
  // Saved as they're added, so shown from the stored project rather than this draft.
  const live = data.projects.find((x) => x.id === p.id) ?? p
  const itemised = p.quoteItems.length > 0

  const trySave = (draft: Project) => {
    // An itemised quote's amount is its total with GST.
    const next = itemised ? { ...draft, quoteAmount: quoteTotal(draft) } : draft
    if (next.quoteItems.some((i) => !i.description.trim())) {
      setTab('quote')
      return setError('Every quote line needs a description.')
    }
    if (next.tasks.some((t) => !t.title.trim())) {
      setTab('schedule')
      return setError('Every task needs a name.')
    }
    if (next.payments.some((s) => !s.title.trim())) {
      setTab('payments')
      return setError('Every payment stage needs a name.')
    }
    if (next.status === 'quoted' && !((next.quoteAmount ?? 0) > 0)) return setError('Price the quote before issuing it.')
    setError(null)
    onSave(next, saved)
    // The workspace page stays open: what's saved is now the starting point.
    setP(next)
    setSaved(next)
  }

  const claim = (stage: PaymentStage, amount: number) => {
    const due = new Date()
    due.setDate(due.getDate() + 14)
    const invoiceId = uid('i')
    const next = { ...p, payments: p.payments.map((s) => (s.id === stage.id ? { ...s, invoiceId } : s)) }
    update((d) => {
      d.invoices.unshift({
        id: invoiceId,
        projectId: p.id,
        clientId: p.clientId,
        qbInvoiceNumber: nextInvoiceNumber(d.invoices),
        amount,
        status: 'draft',
        bankTransferRef: '',
        dueDate: toISODate(due),
        createdAt: new Date().toISOString(),
      })
      d.projects = d.projects.map((x) => (x.id === p.id ? keepLiveParts(structuredClone(next), x, saved) : x))
    })
    setP(next)
    setSaved(next)
  }

  const pendingVariations = p.variations.filter((v) => v.status === 'proposed').length
  const today = todayISO()
  const openDefects = live.defects.filter((d) => d.status !== 'closed').length
  const lateTasks = p.tasks.filter((t) => t.status !== 'done' && t.endDate < today).length
  const tabs: { value: EditorTab; label: string; count?: number }[] = [
    { value: 'overview', label: 'Overview' },
    ...(asPage
      ? ([
          { value: 'schedule', label: 'Schedule', count: lateTasks || p.tasks.length || undefined },
          { value: 'diary', label: 'Site diary', count: live.diary.length || undefined },
          { value: 'defects', label: 'Defects', count: openDefects || undefined },
          { value: 'documents', label: 'Documents', count: live.documents.length || undefined },
        ] as const)
      : []),
    { value: 'quote', label: 'Quote', count: p.quoteItems.length || undefined },
    { value: 'variations', label: 'Variations', count: pendingVariations || undefined },
    { value: 'payments', label: 'Payments', count: p.payments.length || undefined },
    { value: 'costs', label: 'Costs & margin' },
  ]
  // Saved as you go: no draft, so no Save button needed on these tabs.
  const immediate = tab === 'diary' || tab === 'defects' || tab === 'documents'
  const fin = projectFinancials(p, data.invoices)
  const order = p.orderId ? data.orders.find((o) => o.id === p.orderId) : undefined
  const header = (
    <>
      <p className="text-sm text-slate-600">
        {lk.user(p.clientId)?.name}
        <Sep />
        {prop?.address}, {prop?.suburb}
        <Sep />
        <ProjectStatusText s={p.status} />
        {p.orderId && data.orders.some((o) => o.id === p.orderId) && (
          <>
            <Sep />
            <button
              type="button"
              className="font-semibold text-accent-ink underline-offset-2 hover:underline"
              onClick={() => {
                openOnArrival('order', p.orderId!)
                navigate('/admin/store')
              }}
            >
              Store order #{data.orders.find((o) => o.id === p.orderId)?.number}
            </button>
          </>
        )}
        {p.assignedProviderId && (
          <>
            <Sep />
            Trade: {lk.user(p.assignedProviderId)?.name}
          </>
        )}
      </p>
      {asPage ? (
        <dl className="card mb-5 mt-4 grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Progress"><ProjectProgress p={p} /></Fact>
          <Fact label="Tasks done">{p.tasks.filter((t) => t.status === 'done').length} / {p.tasks.length}{lateTasks > 0 && <span className="ml-1 text-red-600">({lateTasks} late)</span>}</Fact>
          <Fact label="Open defects">{openDefects}</Fact>
          <Fact label="Contract">{money(contractTotal(p))}</Fact>
          <Fact label="Margin">{fin.contract ? `${fin.marginPct}%` : '—'}</Fact>
          <Fact label="Paid">{money(fin.paid)}</Fact>
        </dl>
      ) : (
        <p className="mb-4 mt-2 rounded-md bg-slate-50 p-3 text-sm text-slate-700">{p.description}</p>
      )}
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
    </>
  )
  // Payment claims fall due at milestones: on the project page they're kept with the payments.
  const milestonesEditor = (
    <div className="sm:col-span-2">
      <span className="label">Milestones</span>
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {p.milestones.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-slate-900" checked={m.done} onChange={() => set({ milestones: p.milestones.map((x) => (x.id === m.id ? { ...x, done: !x.done } : x)) })} />
            <span className="flex-1">{m.title}</span>
            <input type="date" className="input num w-auto py-1" value={m.date} onChange={(e) => set({ milestones: p.milestones.map((x) => (x.id === m.id ? { ...x, date: e.target.value } : x)) })} />
            <button type="button" className="text-slate-500 hover:text-red-600" onClick={() => set({ milestones: p.milestones.filter((x) => x.id !== m.id) })} aria-label="Remove milestone">
              <Trash2 size={15} />
            </button>
          </li>
        ))}
        <li className="flex flex-wrap items-center gap-2 px-3 py-2">
          <input className="input flex-1 py-1" placeholder="New milestone" value={ms.title} onChange={(e) => setMs({ ...ms, title: e.target.value })} />
          <input type="date" className="input num w-auto py-1" value={ms.date} onChange={(e) => setMs({ ...ms, date: e.target.value })} />
          <button
            type="button"
            className="btn-ghost px-2.5 py-1"
            disabled={!ms.title.trim()}
            onClick={() => {
              set({ milestones: [...p.milestones, { id: uid('m'), title: ms.title.trim(), date: ms.date, done: false }].sort((a, b) => a.date.localeCompare(b.date)) })
              setMs({ title: '', date: ms.date })
            }}
          >
            <Plus size={15} /> Add
          </button>
        </li>
      </ul>
    </div>
  )
  const body = (
    <>
      {tab === 'diary' && <DiaryPanel projectId={p.id} />}
      {tab === 'defects' && <DefectsPanel projectId={p.id} />}
      {tab === 'documents' && <DocumentsPanel projectId={p.id} />}
      {!immediate && (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          trySave(p)
        }}
      >
        {tab === 'overview' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Status">
              <select className="input" value={p.status} onChange={(e) => set({ status: e.target.value as ProjectStatus })}>
                {(Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[]).map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABEL[s]}</option>)}
              </select>
            </Field>
            <Field label="Assigned trade">
              <select className="input" value={p.assignedProviderId ?? ''} onChange={(e) => set({ assignedProviderId: e.target.value || undefined })}>
                <option value="">Unassigned</option>
                {lk.providers.map((u) => <option key={u.id} value={u.id}>{u.name}{u.trade ? ` (${u.trade})` : ''}{hasNoLogin(u) ? ' (no login)' : u.status === 'invited' ? ' (invite pending)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Budget (AUD)">
              <input type="number" min="0" step="any" className="input num" value={p.budget || ''} onChange={(e) => set({ budget: Number(e.target.value) || 0 })} />
            </Field>
            {itemised ? (
              <div>
                <span className="label">Quote (inc. GST)</span>
                <p className="num py-2 font-semibold">
                  {money(quoteTotal(p))}
                  <button type="button" className="ml-2 text-xs font-normal text-slate-500 underline" onClick={() => setTab('quote')}>{p.quoteItems.length} lines</button>
                </p>
              </div>
            ) : (
              <Field label="Quote amount (AUD, inc. GST)">
                <input type="number" min="0" step="0.01" className="input num" value={p.quoteAmount ?? ''} onChange={(e) => set({ quoteAmount: e.target.value ? Number(e.target.value) : undefined })} />
              </Field>
            )}
            <Field label="Scope of works" className="sm:col-span-2">
              <textarea className="input min-h-[100px]" value={p.scopeOfWorks} onChange={(e) => set({ scopeOfWorks: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              {asPage ? <ScheduleSummary p={p} onEdit={() => setTab('schedule')} /> : milestonesEditor}
            </div>
          </div>
        )}
        {tab === 'schedule' && <SchedulePanel p={p} set={set} />}
        {tab === 'quote' && <QuoteBuilder p={p} set={set} />}
        {tab === 'variations' && <VariationsPanel p={p} set={set} original={saved} />}
        {tab === 'payments' && asPage && <div className="mb-5">{milestonesEditor}</div>}
        {tab === 'payments' && <DepositPanel p={saved} />}
        {tab === 'payments' && <PaymentsPanel p={p} set={set} invoices={data.invoices} dirty={dirty} canInvoice={can('canManageInvoices')} onClaim={claim} />}
        {tab === 'costs' && <CostsPanel p={p} set={set} invoices={data.invoices} />}
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
          {dirty && <span className="mr-auto text-xs text-slate-500">Unsaved changes</span>}
          {p.status === 'quote_requested' && (
            <button type="button" className="btn-accent" disabled={!(itemised ? quoteTotal(p) > 0 : p.quoteAmount)} onClick={() => trySave({ ...p, status: 'quoted' })}>
              Issue quote to client
            </button>
          )}
          {saved.status === 'quoted' && order && <SendInstallPrice p={saved} order={order} />}
          {saved.status === 'quoted' && !order && !dirty && <SendQuoteLink p={saved} />}
          {!dirty && <EstimateLine p={saved} />}
          <DeleteQuote p={saved} onDeleted={onClose} />
          <button className="btn-primary">Save project</button>
        </div>
      </form>
      )}
    </>
  )
  if (asPage) {
    return (
      <>
        <button type="button" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden="true" /> Projects
        </button>
        <PageHeader title={`P-${p.number} · ${p.title}`} subtitle={p.description} />
        {header}
        {dirty && immediate && (
          <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
            You have unsaved changes on other tabs.{' '}
            <button type="button" className="font-semibold underline" onClick={() => trySave(p)}>Save them now</button>
          </p>
        )}
        <div className="card p-5">{body}</div>
      </>
    )
  }
  return (
    <Modal open onClose={onClose} title={`P-${p.number} · ${p.title}`} width="max-w-5xl">
      {header}
      {body}
    </Modal>
  )
}
