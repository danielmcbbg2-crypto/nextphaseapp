import { useMemo, useState, type FormEvent } from 'react'
import { Building2, ClipboardPlus, FolderKanban, Home, Wrench, CheckCircle2, Plus, Pencil, ShoppingBag } from 'lucide-react'
import { GridTile, PortalShell, type NavItem } from '../../components/PortalShell'
import { Calendar } from '../../components/Calendar'
import { Empty, Field, Modal, PageHeader, PhotoInput, Sep, Tabs } from '../../components/ui'
import { ProjectStatusText } from '../../components/status'
import { PaymentSchedule, QuoteBreakdown } from '../../components/quote'
import { ProjectBy, ProjectProgress, RequestDetail, RequestRow, useLinkedCalendar } from '../../components/works'
import { stampQuoteDecision, useLookup, useStore } from '../../lib/store'
import { contractTotal, quoteTotal, withGst } from '../../lib/quote'
import { navigate, useHashRoute } from '../../lib/router'
import { SiteHeader, SiteView } from '../../components/ProjectSite'
import { PortalStore } from '../store/Shop'
import { TRADES, type Property, type Trade } from '../../lib/types'
import { fmtDate, melbourneToday, money, uid } from '../../lib/utils'

const NAV: NavItem[] = [
  { key: 'home', label: 'Overview', icon: Home },
  { key: 'request', label: 'New request', icon: ClipboardPlus },
  { key: 'hub', label: 'Maintenance Hub', icon: Wrench },
  { key: 'projects', label: 'Projects & quotes', icon: FolderKanban },
  { key: 'properties', label: 'Properties', icon: Building2 },
  { key: 'store', label: 'Store', icon: ShoppingBag },
]

export function ClientPortal({ section }: { section: string }) {
  return (
    <PortalShell role="client" label="Client portal" nav={NAV} active={section}>
      {section === 'request' ? (
        <RequestForm />
      ) : section === 'hub' ? (
        <Hub />
      ) : section === 'projects' ? (
        <Projects />
      ) : section === 'properties' ? (
        <Properties />
      ) : section === 'store' ? (
        <PortalStore />
      ) : (
        <Overview />
      )}
    </PortalShell>
  )
}

function useMine() {
  const { data, user } = useStore()
  return useMemo(
    () => ({
      properties: data.properties.filter((p) => p.clientId === user?.id),
      requests: data.requests.filter((r) => r.clientId === user?.id),
      projects: data.projects.filter((p) => p.clientId === user?.id),
      invoices: data.invoices.filter((i) => i.clientId === user?.id),
    }),
    [data, user],
  )
}

function Overview() {
  const { user } = useStore()
  const mine = useMine()
  const live = mine.requests.filter((r) => r.status !== 'completed')
  const next = live.filter((r) => r.scheduledDate).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!))[0]
  const activeProjects = mine.projects.filter((p) => p.status === 'in_progress' || p.status === 'approved')
  const owing = mine.invoices.filter((i) => i.status === 'sent').reduce((s, i) => s + i.amount, 0)
  return (
    <>
      <PageHeader title={`Welcome back, ${user?.name.split(' ')[0]}`} subtitle="Everything across your properties, in one place." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <GridTile
          href="#/client/request"
          icon={ClipboardPlus}
          emphasis
          title="Maintenance request"
          description="Lodge a new job with photos. Urgent jobs alert our team by SMS."
          meta="Takes about a minute"
        />
        <GridTile
          href="#/client/hub"
          icon={Wrench}
          title="Maintenance Hub"
          description="Live and completed works, plus your maintenance schedule."
          meta={
            <>
              <span className="num">{live.length}</span> live
              {next && (
                <>
                  <Sep />
                  next <span className="num">{fmtDate(next.scheduledDate)}</span>
                </>
              )}
            </>
          }
        />
        <GridTile
          href="#/client/projects"
          icon={FolderKanban}
          title="Projects & quotes"
          description="Request renovation quotes and follow project milestones."
          meta={
            <>
              <span className="num">{activeProjects.length}</span> active
              {owing > 0 && (
                <>
                  <Sep />
                  <span className="num">{money(owing)}</span> invoiced
                </>
              )}
            </>
          }
        />
        <GridTile
          href="#/client/properties"
          icon={Building2}
          title="Property registry"
          description="Paint colours, skirting profiles, cladding and access details."
          meta={
            <>
              <span className="num">{mine.properties.length}</span> {mine.properties.length === 1 ? 'property' : 'properties'}
            </>
          }
        />
      </div>
    </>
  )
}

function RequestForm() {
  const { user, actor, submitRequest, can } = useStore()
  const mine = useMine()
  const [propertyId, setPropertyId] = useState(mine.properties[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [urgency, setUrgency] = useState<'urgent' | 'standard'>('standard')
  const [category, setCategory] = useState<Trade>('Handyman')
  const [description, setDescription] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!can('canSubmitRequests'))
    return actor?.id !== user?.id ? (
      <Empty title="Your admin account needs “Dispatch & assign jobs” to lodge requests here" />
    ) : (
      <Empty title="Request submission is disabled for your account">Contact Next Phase Maintenance.</Empty>
    )
  if (mine.properties.length === 0)
    return (
      <Empty title="Add a property first">
        <button className="btn-primary mt-3" onClick={() => navigate('/client/properties')}>Go to properties</button>
      </Empty>
    )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!user) return
    setBusy(true)
    setError(null)
    let r
    try {
      r = await submitRequest({ clientId: user.id, propertyId: propertyId || mine.properties[0].id, title, description, category, urgency, photos })
    } catch (err) {
      setError((err as Error).message)
      return
    } finally {
      setBusy(false)
    }
    setDone(r.number)
    setTitle('')
    setDescription('')
    setPhotos([])
    setUrgency('standard')
  }

  if (done !== null)
    return (
      <div className="card mx-auto max-w-lg px-6 py-10 text-center">
        <CheckCircle2 size={36} className="mx-auto text-emerald-600" />
        <h2 className="mt-3 text-xl font-bold">Request #{done} lodged</h2>
        <p className="mt-1 text-sm text-slate-600">Our team has been notified and will assign a trade shortly. You can follow progress in the Maintenance Hub.</p>
        <div className="mt-6 flex justify-center gap-2">
          <button className="btn-ghost" onClick={() => setDone(null)}>Lodge another</button>
          <button className="btn-primary" onClick={() => navigate('/client/hub')}>Open Maintenance Hub</button>
        </div>
      </div>
    )

  return (
    <>
      <PageHeader title="New maintenance request" subtitle="Tell us what needs fixing. Photos help us send the right trade with the right parts." />
      <form onSubmit={submit} className="card grid gap-5 p-6 md:grid-cols-2">
        <Field label="Property">
          <select className="input" value={propertyId} onChange={(e) => setPropertyId(e.target.value)} required>
            {mine.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.address}, {p.suburb}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Trade category">
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Trade)}>
            {TRADES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Job title" className="md:col-span-2">
          <input className="input" required maxLength={120} placeholder="e.g. Leaking tap in ensuite" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="md:col-span-2">
          <span className="label">Priority</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['standard', 'Standard', 'Scheduled at the next available slot.'],
                ['urgent', 'Urgent', 'Safety, water or security risk. Our team is alerted immediately.'],
              ] as const
            ).map(([v, label, hint]) => (
              <label
                key={v}
                className={`flex cursor-pointer gap-3 rounded-md border p-3 ${urgency === v ? (v === 'urgent' ? 'border-accent bg-accent-soft' : 'border-slate-900 bg-slate-50') : 'border-slate-200'}`}
              >
                <input type="radio" name="urgency" className="mt-1 accent-slate-900" checked={urgency === v} onChange={() => setUrgency(v)} />
                <span>
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="block text-xs text-slate-500">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <Field label="Issue details" className="md:col-span-2">
          <textarea
            className="input min-h-[120px]"
            required
            placeholder="What's happening, where in the property, and since when?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="md:col-span-2">
          <span className="label">Photos (up to 6)</span>
          <PhotoInput value={photos} onChange={setPhotos} />
        </div>
        {error && <p className="text-sm text-red-600 md:col-span-2">{error}</p>}
        <div className="flex justify-end md:col-span-2">
          <button className={urgency === 'urgent' ? 'btn-accent' : 'btn-primary'} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </form>
    </>
  )
}

function Hub() {
  const mine = useMine()
  const [tab, setTab] = useState<'live' | 'completed' | 'schedule'>('live')
  const [openId, setOpenId] = useState<string | null>(null)
  const live = mine.requests.filter((r) => r.status !== 'completed')
  const completed = mine.requests.filter((r) => r.status === 'completed')
  const cal = useLinkedCalendar(mine.requests, mine.projects)
  const list = tab === 'live' ? live : completed
  return (
    <>
      <PageHeader
        title="Maintenance Hub"
        subtitle="Live works, completed works and your schedule."
        actions={<button className="btn-primary" onClick={() => navigate('/client/request')}><Plus size={16} /> New request</button>}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'live', label: 'Live works', count: live.length },
          { value: 'completed', label: 'Completed works', count: completed.length },
          { value: 'schedule', label: 'Schedule' },
        ]}
      />
      {tab === 'schedule' ? (
        <Calendar events={cal.events} onOpen={(ev) => ev.kind === 'request' && setOpenId(ev.id.slice(2))} />
      ) : list.length === 0 ? (
        <Empty title={tab === 'live' ? 'No live works' : 'No completed works yet'} />
      ) : (
        <div className="card divide-y divide-slate-100">
          {list.map((r) => (
            <RequestRow key={r.id} r={r} onOpen={() => setOpenId(r.id)} />
          ))}
        </div>
      )}
      <RequestDetail r={mine.requests.find((r) => r.id === openId)} open={!!openId} onClose={() => setOpenId(null)} />
    </>
  )
}

/** Projects under way or finished have a site: the schedule, progress updates, defects and documents. */
const hasSite = (status: string) => status === 'approved' || status === 'in_progress' || status === 'completed'

function Projects() {
  const [, , id] = useHashRoute()
  const mine = useMine()
  const site = id ? mine.projects.find((p) => p.id === id && hasSite(p.status)) : undefined
  if (id)
    return site ? (
      <>
        <SiteHeader p={site} as="client" back="#/client/projects" />
        <SiteView p={site} as="client" />
      </>
    ) : (
      <Empty title="Project not found">
        <a className="font-semibold underline" href="#/client/projects">Back to your projects</a>
      </Empty>
    )
  return <ProjectList />
}

function ProjectList() {
  const { user, actor, update, requestQuote, canAct, pushAdminInbox } = useStore()
  const lk = useLookup()
  const mine = useMine()
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ propertyId: mine.properties[0]?.id ?? '', title: '', description: '', budget: '' })

  const submitQuote = async (e: FormEvent) => {
    e.preventDefault()
    if (!user) return
    setBusy(true)
    setError(null)
    try {
      await requestQuote({ clientId: user.id, propertyId: form.propertyId || mine.properties[0]?.id, title: form.title, description: form.description, budget: Number(form.budget) || 0 })
      setQuoteOpen(false)
      setForm({ ...form, title: '', description: '', budget: '' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const respond = (id: string, approve: boolean) => {
    const title = mine.projects.find((x) => x.id === id)?.title ?? 'this quote'
    // One tap on a phone shouldn't commit to (or turn down) a job: ask first.
    if (!window.confirm(approve ? `Accept the quote for “${title}”? We'll send the deposit invoice next.` : `Decline the quote for “${title}”?`)) return
    update((d) => {
      const p = d.projects.find((x) => x.id === id)
      if (!p) return
      const before = p.status
      p.status = approve ? 'approved' : 'rejected'
      stampQuoteDecision(p, before, actor?.id)
    })
  }
  const decideVariation = (pid: string, vid: string, approve: boolean) => {
    const p = mine.projects.find((x) => x.id === pid)
    const v = p?.variations.find((x) => x.id === vid)
    if (!p || !v || v.status !== 'proposed') return
    update((d) => {
      const x = d.projects.find((y) => y.id === pid)?.variations.find((y) => y.id === vid)
      if (x) {
        x.status = approve ? 'approved' : 'rejected'
        x.decidedAt = new Date().toISOString()
      }
    })
    void pushAdminInbox(`Variation V${v.number} ${approve ? 'approved' : 'declined'}: P-${p.number}`, `${v.title}: ${money(withGst(v.amount))} inc GST`, { projectId: pid })
  }
  // An admin in this client's dashboard asks for and answers quotes with their own project permission.
  const canQuote = canAct('canManageProjects')

  return (
    <>
      <PageHeader
        title="Projects & quotes"
        subtitle="Renovation quotes and active project progress."
        actions={
          <button
            className="btn-primary"
            onClick={() => setQuoteOpen(true)}
            disabled={mine.properties.length === 0 || !canQuote}
            title={canQuote ? undefined : 'Your admin account needs “Manage projects & quotes” to do this here'}
          >
            <Plus size={16} /> Request a quote
          </button>
        }
      />
      {mine.projects.length === 0 ? (
        <Empty title="No projects yet">Request a renovation quote to get started.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {mine.projects.map((p) => {
            const prop = lk.property(p.propertyId)
            const approvedVariations = p.variations.filter((v) => v.status === 'approved').length
            return (
              <div key={p.id} className="card p-5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="num text-xs text-slate-500">P-{p.number}</span>
                  <ProjectStatusText s={p.status} />
                </div>
                <h2 className="mt-1 text-lg font-bold">{p.title}</h2>
                <p className="text-sm text-slate-500">{prop ? `${prop.address}, ${prop.suburb}` : ''}</p>
                {hasSite(p.status) && (
                  <a href={`#/client/projects/${p.id}`} className="btn-primary mt-3 px-3 py-1.5 text-sm">
                    Open project: schedule, updates, defects & documents
                  </a>
                )}
                <p className="mt-2 text-sm text-slate-600">{p.description}</p>
                <ProjectBy p={p} className="mt-1" />
                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm">
                  <div>
                    <dt className="text-xs text-slate-500">Your budget</dt>
                    <dd className="num">{p.budget ? money(p.budget) : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">{approvedVariations ? 'Contract total' : 'Quoted'}</dt>
                    <dd className="num">{p.quoteAmount || p.quoteItems.length ? money(contractTotal(p)) : 'Pending'}</dd>
                    {approvedVariations > 0 && <dd className="num text-xs text-slate-500">quote {money(quoteTotal(p))} + {approvedVariations} variation{approvedVariations > 1 ? 's' : ''}</dd>}
                  </div>
                </dl>
                {(p.quoteItems.length > 0 || p.quoteInclusions || p.quoteExclusions) && (
                  <details className="mt-3 border-t border-slate-100 pt-3" open={p.status === 'quoted'}>
                    <summary className="cursor-pointer text-sm font-semibold">Quote breakdown</summary>
                    <div className="mt-3"><QuoteBreakdown p={p} /></div>
                  </details>
                )}
                {p.variations.length > 0 && (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <p className="text-sm font-semibold">Variations</p>
                    <ul className="mt-2 space-y-2">
                      {p.variations.map((v) => (
                        <li key={v.id} className={`rounded-md border p-3 text-sm ${v.status === 'proposed' ? 'border-accent' : 'border-slate-200'}`}>
                          <div className="flex justify-between gap-3">
                            <p className="font-medium"><span className="num text-slate-500">V{v.number}</span> · {v.title}</p>
                            <p className={`num whitespace-nowrap font-semibold ${v.status === 'rejected' ? 'text-slate-400 line-through' : ''}`}>
                              {v.amount < 0 ? '−' : ''}{money(Math.abs(withGst(v.amount)))}
                            </p>
                          </div>
                          {v.description && <p className="mt-1 whitespace-pre-wrap text-slate-600">{v.description}</p>}
                          <p className="mt-1 text-xs text-slate-500">
                            {v.amount < 0 ? 'Credit, inc GST' : 'Inc GST'} · {v.status === 'proposed' ? 'Awaiting your approval' : v.status === 'approved' ? 'Approved' : 'Declined'}
                            {v.decidedAt ? ` ${fmtDate(v.decidedAt)}` : ''}
                          </p>
                          {v.status === 'proposed' && canQuote && (
                            <div className="mt-2 flex gap-2">
                              <button className="btn-primary px-3 py-1.5" onClick={() => decideVariation(p.id, v.id, true)}>Approve</button>
                              <button className="btn-ghost px-3 py-1.5" onClick={() => decideVariation(p.id, v.id, false)}>Decline</button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {p.payments.length > 0 && (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <p className="mb-2 text-sm font-semibold">Payment schedule</p>
                    <PaymentSchedule p={p} invoices={mine.invoices} />
                  </div>
                )}
                {p.scopeOfWorks && (
                  <div className="mt-3">
                    <p className="text-xs text-slate-500">Scope of works</p>
                    <p className="text-sm text-slate-700">{p.scopeOfWorks}</p>
                  </div>
                )}
                {p.milestones.length > 0 && (
                  <div className="mt-4">
                    <ProjectProgress p={p} />
                    <ol className="mt-3 space-y-1.5">
                      {p.milestones.map((m) => (
                        <li key={m.id} className="flex items-center justify-between text-sm">
                          <span className={m.done ? 'text-slate-500 line-through' : 'text-slate-800'}>{m.title}</span>
                          <span className="num text-xs text-slate-500">{fmtDate(m.date)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {(() => {
                  const inv = p.deposit?.status === 'sent' && p.deposit.invoiceId ? mine.invoices.find((i) => i.id === p.deposit!.invoiceId) : undefined
                  return inv?.payLink ? (
                    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4 text-sm">
                      <span>
                        Deposit invoice {inv.qbInvoiceNumber}: <span className="num font-semibold">{money(inv.amount)}</span> inc. GST, emailed to you.
                      </span>
                      <a className="btn-primary" href={inv.payLink} target="_blank" rel="noreferrer">Pay deposit</a>
                    </div>
                  ) : null
                })()}
                {p.status === 'quoted' && quoteTotal(p) > 0 && canQuote && (
                  // Same rule as the quote link (and the database): a quote past its date can't be accepted.
                  !!p.quoteValidUntil && p.quoteValidUntil < melbourneToday() ? (
                    <p className="mt-4 border-t border-slate-100 pt-4 text-sm text-slate-600">
                      This quote expired on {fmtDate(p.quoteValidUntil)}. Contact us for an updated quote.
                    </p>
                  ) : (
                    <div className="mt-4 flex gap-2 border-t border-slate-100 pt-4">
                      <button className="btn-primary" onClick={() => respond(p.id, true)}>Accept quote</button>
                      <button className="btn-ghost" onClick={() => respond(p.id, false)}>Decline</button>
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>
      )}
      <Modal open={quoteOpen} onClose={() => setQuoteOpen(false)} title="Request a renovation quote">
        <form onSubmit={submitQuote} className="space-y-4">
          <Field label="Property">
            <select className="input" value={form.propertyId} onChange={(e) => setForm({ ...form, propertyId: e.target.value })}>
              {mine.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.address}, {p.suburb}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Project title">
            <input className="input" required placeholder="e.g. Kitchen renovation" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="What would you like done?">
            <textarea className="input min-h-[110px]" required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Indicative budget (AUD, optional)">
            <input className="input num" type="number" min="0" step="any" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end">
            <button className="btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send quote request'}</button>
          </div>
        </form>
      </Modal>
    </>
  )
}

const EMPTY_PROPERTY = (clientId: string): Property => ({
  id: '',
  clientId,
  address: '',
  suburb: '',
  postcode: '',
  paintColors: { walls: '', trim: '', ceiling: '' },
  skirtProfile: '',
  claddingType: '',
  accessCode: '',
  notes: '',
})

type EditorProps = { value: Property | null; onSave: (p: Property) => void; onClose: () => void }

export function PropertyEditor(props: EditorProps) {
  if (!props.value) return null
  return <PropertyEditorForm key={props.value.id || 'new'} {...props} value={props.value} />
}

function PropertyEditorForm({ value, onSave, onClose }: EditorProps & { value: Property }) {
  const [p, setP] = useState<Property>(value)
  const set = (patch: Partial<Property>) => setP({ ...p, ...patch })
  const setPaint = (k: keyof Property['paintColors'], v: string) => setP({ ...p, paintColors: { ...p.paintColors, [k]: v } })
  return (
    <Modal open onClose={onClose} title={p.id ? 'Edit property' : 'Add property'} width="max-w-2xl">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSave(p)
        }}
        className="grid gap-4 sm:grid-cols-6"
      >
        <Field label="Street address" className="sm:col-span-6">
          <input className="input" required value={p.address} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <Field label="Suburb" className="sm:col-span-4">
          <input className="input" required value={p.suburb} onChange={(e) => set({ suburb: e.target.value })} />
        </Field>
        <Field label="Postcode" className="sm:col-span-2">
          <input className="input num" inputMode="numeric" maxLength={4} value={p.postcode} onChange={(e) => set({ postcode: e.target.value })} />
        </Field>
        <Field label="Wall paint" className="sm:col-span-2">
          <input className="input" placeholder="Brand, colour & code" value={p.paintColors.walls} onChange={(e) => setPaint('walls', e.target.value)} />
        </Field>
        <Field label="Trim paint" className="sm:col-span-2">
          <input className="input" value={p.paintColors.trim} onChange={(e) => setPaint('trim', e.target.value)} />
        </Field>
        <Field label="Ceiling paint" className="sm:col-span-2">
          <input className="input" value={p.paintColors.ceiling} onChange={(e) => setPaint('ceiling', e.target.value)} />
        </Field>
        <Field label="Skirting profile" className="sm:col-span-3">
          <input className="input" placeholder="e.g. Colonial 92 × 18 mm" value={p.skirtProfile} onChange={(e) => set({ skirtProfile: e.target.value })} />
        </Field>
        <Field label="Cladding type" className="sm:col-span-3">
          <input className="input" placeholder="e.g. Brick veneer" value={p.claddingType} onChange={(e) => set({ claddingType: e.target.value })} />
        </Field>
        <Field label="Access code / instructions" className="sm:col-span-6">
          <input className="input" value={p.accessCode} onChange={(e) => set({ accessCode: e.target.value })} />
        </Field>
        <Field label="Notes" className="sm:col-span-6">
          <textarea className="input" value={p.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <div className="sm:col-span-6">
          <span className="label">Floor plan (image)</span>
          <PhotoInput max={1} value={p.floorPlan ? [p.floorPlan] : []} onChange={(v) => set({ floorPlan: v[0] })} />
        </div>
        <div className="flex justify-end sm:col-span-6">
          <button className="btn-primary">Save property</button>
        </div>
      </form>
    </Modal>
  )
}

export function PropertyCard({ p, onEdit, owner }: { p: Property; onEdit?: () => void; owner?: string }) {
  const spec: [string, string][] = [
    ['Walls', p.paintColors.walls],
    ['Trim', p.paintColors.trim],
    ['Ceiling', p.paintColors.ceiling],
    ['Skirting', p.skirtProfile],
    ['Cladding', p.claddingType],
    ['Access', p.accessCode],
  ]
  return (
    <div className="card flex flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-5">
        <div>
          <h2 className="font-bold">{p.address}</h2>
          <p className="text-sm text-slate-500">
            {p.suburb} <span className="num">{p.postcode}</span>
            {owner && (
              <>
                <Sep />
                {owner}
              </>
            )}
          </p>
        </div>
        {onEdit && (
          <button className="btn-ghost px-2.5 py-1.5" onClick={onEdit} aria-label="Edit property">
            <Pencil size={14} />
          </button>
        )}
      </div>
      <dl className="flex-1 divide-y divide-slate-100 text-sm">
        {spec.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 px-5 py-2">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-right font-medium text-slate-800">{v || '—'}</dd>
          </div>
        ))}
      </dl>
      {(p.notes || p.floorPlan) && (
        <div className="space-y-2 border-t border-slate-100 p-5 text-sm text-slate-600">
          {p.notes && <p>{p.notes}</p>}
          {p.floorPlan && (
            <a href={p.floorPlan} target="_blank" rel="noreferrer" className="block">
              <img src={p.floorPlan} alt="Floor plan" className="max-h-40 rounded border border-slate-200" />
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function Properties() {
  const { user, update } = useStore()
  const mine = useMine()
  const [editing, setEditing] = useState<Property | null>(null)
  if (!user) return null
  return (
    <>
      <PageHeader
        title="Property registry"
        subtitle="The finishes and specifications our trades match to on every job."
        actions={<button className="btn-primary" onClick={() => setEditing(EMPTY_PROPERTY(user.id))}><Plus size={16} /> Add property</button>}
      />
      {mine.properties.length === 0 ? (
        <Empty title="No properties yet" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {mine.properties.map((p) => (
            <PropertyCard key={p.id} p={p} onEdit={() => setEditing(p)} />
          ))}
        </div>
      )}
      <PropertyEditor
        value={editing}
        onClose={() => setEditing(null)}
        onSave={(p) => {
          update((d) => {
            if (p.id) d.properties = d.properties.map((x) => (x.id === p.id ? p : x))
            else d.properties.push({ ...p, id: uid('p') })
          })
          setEditing(null)
        }}
      />
    </>
  )
}
