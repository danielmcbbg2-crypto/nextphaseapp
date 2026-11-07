import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { CalendarDays, FolderKanban, Home, Inbox as InboxIcon, Receipt, ShoppingBag, Wrench, Check, Plus } from 'lucide-react'
import { GridTile, PortalShell, type NavItem } from '../../components/PortalShell'
import { Calendar, type CalEvent } from '../../components/Calendar'
import { Empty, Field, Modal, PageHeader, PhotoInput, Sep, Status, Tabs } from '../../components/ui'
import { ProjectStatusText } from '../../components/status'
import { ProjectProgress, RequestDetail, RequestRow } from '../../components/works'
import { doneBy, useLookup, useStore } from '../../lib/store'
import { PortalStore } from '../store/Shop'
import { SiteHeader, SiteView, fmtTime } from '../../components/ProjectSite'
import { useHashRoute } from '../../lib/router'
import { REQUEST_STATUS_LABEL, type Expense, type RequestStatus } from '../../lib/types'
import { cx, fmtDate, fmtDateTime, money, todayISO, toISODate, uid } from '../../lib/utils'

export function ProviderPortal({ section }: { section: string }) {
  const { data, user } = useStore()
  const unread = data.inbox.filter((m) => m.userId === user?.id && (!m.read || (m.requiresAck && !m.acknowledged))).length
  const nav: NavItem[] = [
    { key: 'home', label: 'Overview', icon: Home },
    { key: 'inbox', label: 'Inbox', icon: InboxIcon, badge: unread },
    { key: 'hub', label: 'Maintenance Hub', icon: Wrench },
    { key: 'projects', label: 'Projects', icon: FolderKanban },
    { key: 'calendar', label: 'Calendar', icon: CalendarDays },
    { key: 'budget', label: 'Budget & expenses', icon: Receipt },
    { key: 'store', label: 'Store', icon: ShoppingBag },
  ]
  return (
    <PortalShell role="provider" label="Service provider portal" nav={nav} active={section}>
      {section === 'inbox' ? (
        <Inbox />
      ) : section === 'hub' ? (
        <Hub />
      ) : section === 'projects' ? (
        <Projects />
      ) : section === 'calendar' ? (
        <ProviderCalendar />
      ) : section === 'budget' ? (
        <Budget />
      ) : section === 'store' ? (
        <PortalStore />
      ) : (
        <Overview unread={unread} />
      )}
    </PortalShell>
  )
}

function useAssigned() {
  const { data, user } = useStore()
  return useMemo(
    () => ({
      requests: data.requests.filter((r) => r.assignedProviderId === user?.id),
      projects: data.projects.filter((p) => p.assignedProviderId === user?.id),
      // Every project they work on: as its trade, booked for some of its tasks, or given a defect.
      worksOn: data.projects.filter(
        (p) => p.assignedProviderId === user?.id || p.tasks.some((t) => t.assigneeId === user?.id) || p.defects.some((d) => d.assigneeId === user?.id),
      ),
      // Their bookings still to do, soonest first, with the project they're on.
      bookings: data.projects
        .filter((p) => p.status === 'approved' || p.status === 'in_progress')
        .flatMap((p) => p.tasks.filter((t) => t.assigneeId === user?.id && t.status !== 'done').map((t) => ({ p, t })))
        .sort((a, b) => a.t.startDate.localeCompare(b.t.startDate) || (a.t.startTime ?? '').localeCompare(b.t.startTime ?? '')),
      inbox: data.inbox.filter((m) => m.userId === user?.id),
    }),
    [data, user],
  )
}

function Overview({ unread }: { unread: number }) {
  const { user } = useStore()
  const a = useAssigned()
  const live = a.requests.filter((r) => r.status !== 'completed')
  const today = todayISO()
  const todays = live.filter((r) => r.scheduledDate === today).length
  const liveProjects = a.worksOn.filter((p) => p.status === 'in_progress' || p.status === 'approved')
  const lk = useLookup()
  const pendingExp = a.projects.flatMap((p) => p.expenses).filter((e) => e.providerId === user?.id && e.status === 'submitted').length
  return (
    <>
      <PageHeader title={`G'day, ${user?.name.split(' ')[0]}`} subtitle={user?.company} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <GridTile href="#/provider/inbox" icon={InboxIcon} emphasis={unread > 0} title="Inbox" description="Work orders to acknowledge and messages from the office." meta={<><span className="num">{unread}</span> need attention</>} />
        <GridTile href="#/provider/hub" icon={Wrench} title="Maintenance Hub" description="Your live work orders: update status and upload completion photos." meta={<><span className="num">{live.length}</span> live<Sep /><span className="num">{todays}</span> today</>} />
        <GridTile href="#/provider/projects" icon={FolderKanban} title="Live projects" description="Your bookings, the site diary, defects to fix and the job's documents." meta={<><span className="num">{liveProjects.length}</span> active<Sep /><span className="num">{a.bookings.length}</span> bookings</>} />
        <GridTile href="#/provider/calendar" icon={CalendarDays} title="Calendar" description="Your maintenance visits and project bookings, and who else is booked on your projects. Move your own." />
        <GridTile href="#/provider/budget" icon={Receipt} title="Budget & expenses" description="Submit materials, labour and hire costs against project budgets." meta={<><span className="num">{pendingExp}</span> awaiting approval</>} />
      </div>
      {a.bookings.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-bold">Your project bookings</h2>
          <ul className="card divide-y divide-slate-100">
            {a.bookings.slice(0, 6).map(({ p, t }) => {
              const prop = lk.property(p.propertyId)
              return (
                <li key={t.id}>
                  <a href={`#/provider/projects/${p.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-slate-50">
                    <span className={cx('num w-40 shrink-0 font-semibold', t.startDate <= today ? 'text-accent-ink' : 'text-slate-700')}>
                      {t.startDate === today ? 'Today' : fmtDate(t.startDate)}
                      {t.startTime ? `, ${fmtTime(t.startTime)}` : ''}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-slate-900">{t.title}</span>
                      <span className="block truncate text-xs text-slate-500">P-{p.number} {p.title}{prop ? ` · ${prop.address}, ${prop.suburb}` : ''}</span>
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </>
  )
}

function Inbox() {
  const { update, user, actor } = useStore()
  const a = useAssigned()
  const lk = useLookup()
  const [openReq, setOpenReq] = useState<string | null>(null)
  const mark = (id: string, patch: { read?: boolean; acknowledged?: boolean }) =>
    update((d) => {
      const m = d.inbox.find((x) => x.id === id)
      if (!m) return
      if (patch.acknowledged && !m.acknowledged) m.acknowledgedBy = actor?.id
      Object.assign(m, patch)
    })
  return (
    <>
      <PageHeader title="Inbox" subtitle="Messages and work orders from Next Phase Maintenance." />
      {a.inbox.length === 0 ? (
        <Empty title="Inbox is clear" />
      ) : (
        <div className="card divide-y divide-slate-100">
          {a.inbox.map((m) => {
            const pending = m.requiresAck && !m.acknowledged
            return (
              // `!` is needed: the parent's divide-slate-100 colours every side of rows 2+ with a more specific selector.
              <div
                key={m.id}
                className={cx('flex flex-col gap-3 border-l-[3px] px-5 py-4 sm:flex-row sm:items-start', m.read ? '!border-l-transparent' : '!border-l-accent')}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {!m.read && <span className="h-2 w-2 rounded-full bg-accent" aria-label="Unread" />}
                    <p className="font-semibold">{m.title}</p>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-600">{m.body}</p>
                  <p className="num mt-1 text-xs text-slate-500">{fmtDateTime(m.createdAt)}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {m.requestId && lk.request(m.requestId)?.assignedProviderId === user?.id && (
                    <button className="btn-ghost" onClick={() => { setOpenReq(m.requestId!); mark(m.id, { read: true }) }}>View job</button>
                  )}
                  {pending ? (
                    <button className="btn-accent" onClick={() => mark(m.id, { acknowledged: true, read: true })}>
                      <Check size={16} /> Acknowledge
                    </button>
                  ) : m.requiresAck ? (
                    <Status tone="green">
                      {m.acknowledgedBy && m.acknowledgedBy !== m.userId ? `Acknowledged by ${lk.byName(m.acknowledgedBy)}` : 'Acknowledged'}
                    </Status>
                  ) : (
                    !m.read && <button className="btn-ghost" onClick={() => mark(m.id, { read: true })}>Mark read</button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      <RequestDetail r={lk.request(openReq ?? undefined)} open={!!openReq} onClose={() => setOpenReq(null)} />
    </>
  )
}

function Hub() {
  const { update, pushAdminInbox, user, actor, canAct } = useStore()
  const lk = useLookup()
  const a = useAssigned()
  // An admin in this trade's dashboard updates jobs with their own dispatch permission, and leaves a
  // note of what they changed so the job's history doesn't read as the trade's own work.
  const canWork = canAct('canDispatchJobs')
  const acting = !!actor && actor.id !== user?.id
  const noteLine = (text: string) => `${fmtDate(todayISO())} — ${doneBy(actor, user)}: ${text}`
  const [tab, setTab] = useState<'live' | 'completed'>('live')
  const [openId, setOpenId] = useState<string | null>(null)
  const [photos, setPhotos] = useState<string[]>([])
  const [note, setNote] = useState('')
  const live = a.requests.filter((r) => r.status !== 'completed')
  const completed = a.requests.filter((r) => r.status === 'completed')
  const open = lk.request(openId ?? undefined)

  const setStatus = (id: string, status: RequestStatus) => {
    if (!canWork) return
    const r = lk.request(id)
    update((d) => {
      const x = d.requests.find((y) => y.id === id)
      if (!x) return
      x.status = status
      if (status === 'completed') x.completedAt = new Date().toISOString()
      if (acting) x.notes = [x.notes, noteLine(`marked ${REQUEST_STATUS_LABEL[status]}`)].filter(Boolean).join('\n')
    })
    if (status === 'completed' && r) {
      void pushAdminInbox(`Work order #${r.number} completed`, `${doneBy(actor, user)} marked “${r.title}” complete. Ready to invoice.`, { requestId: r.id })
    }
  }

  const saveUpdate = () => {
    if (!open || !canWork) return
    const said = [note.trim(), acting && photos.length ? `added ${photos.length} completion photo${photos.length > 1 ? 's' : ''}` : '']
    update((d) => {
      const x = d.requests.find((y) => y.id === open.id)
      if (!x) return
      x.completionPhotos.push(...photos)
      if (said.some(Boolean)) x.notes = [x.notes, noteLine(said.filter(Boolean).join('; '))].filter(Boolean).join('\n')
    })
    setPhotos([])
    setNote('')
  }

  const list = tab === 'live' ? live : completed
  return (
    <>
      <PageHeader title="Maintenance Hub" subtitle="Your assigned work orders." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'live', label: 'Live work orders', count: live.length }, { value: 'completed', label: 'Completed', count: completed.length }]} />
      {list.length === 0 ? (
        <Empty title={tab === 'live' ? 'No live work orders' : 'Nothing completed yet'} />
      ) : (
        <div className="card divide-y divide-slate-100">
          {list.map((r) => (
            <RequestRow
              key={r.id}
              r={r}
              onOpen={() => setOpenId(r.id)}
              right={
                r.status !== 'completed' &&
                canWork && (
                  <select className="input w-auto py-1.5" value={r.status} onChange={(e) => setStatus(r.id, e.target.value as RequestStatus)} aria-label="Update status">
                    {(['assigned', 'in_progress', 'awaiting_parts', 'completed'] as RequestStatus[]).map((s) => (
                      <option key={s} value={s}>{REQUEST_STATUS_LABEL[s]}</option>
                    ))}
                  </select>
                )
              }
            />
          ))}
        </div>
      )}
      <RequestDetail r={open} open={!!open} onClose={() => { setOpenId(null); setPhotos([]); setNote('') }}>
        {!canWork ? (
          <p className="text-sm text-slate-500">Your admin account needs “Dispatch & assign jobs” to update jobs here.</p>
        ) : (
          <div className="space-y-4">
            <div>
              <span className="label">Add completion photos</span>
              <PhotoInput value={photos} onChange={setPhotos} />
            </div>
            <Field label="Site note">
              <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Work done, parts used, follow-ups…" />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              {open && open.status !== 'completed' && (
                <button className="btn-ghost" onClick={() => { saveUpdate(); setStatus(open.id, 'completed') }}>Save & mark complete</button>
              )}
              <button className="btn-primary" onClick={saveUpdate} disabled={!photos.length && !note.trim()}>Save update</button>
            </div>
          </div>
        )}
      </RequestDetail>
    </>
  )
}

function Projects() {
  const [, , id] = useHashRoute()
  const a = useAssigned()
  const site = id ? a.worksOn.find((p) => p.id === id) : undefined
  if (id)
    return site ? (
      <>
        <SiteHeader p={site} as="trade" back="#/provider/projects" />
        <SiteView p={site} as="trade" />
      </>
    ) : (
      <Empty title="This project isn't one of yours">
        <a className="font-semibold underline" href="#/provider/projects">Back to your projects</a>
      </Empty>
    )
  return <ProjectList />
}

function ProjectList() {
  const { user, update, canAct } = useStore()
  const lk = useLookup()
  const a = useAssigned()
  const bookedOnly = a.worksOn.filter((p) => p.assignedProviderId !== user?.id)
  // An admin in this trade's dashboard ticks milestones with their own project permission.
  const canTick = canAct('canManageProjects')
  const toggle = (pid: string, mid: string) => {
    if (!canTick) return
    update((d) => {
      const m = d.projects.find((p) => p.id === pid)?.milestones.find((x) => x.id === mid)
      if (m) m.done = !m.done
    })
  }
  return (
    <>
      <PageHeader title="Live projects" subtitle="Open a project for your bookings, the site diary, defects and documents." />
      {a.worksOn.length === 0 ? (
        <Empty title="No projects assigned" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {a.projects.map((p) => {
            const prop = lk.property(p.propertyId)
            return (
              <div key={p.id} className="card p-5">
                <div className="flex flex-wrap items-center gap-x-3">
                  <span className="num text-xs text-slate-500">P-{p.number}</span>
                  <ProjectStatusText s={p.status} />
                </div>
                <h2 className="mt-1 text-lg font-bold">
                  <a href={`#/provider/projects/${p.id}`} className="hover:underline">{p.title}</a>
                </h2>
                <p className="text-sm text-slate-500">
                  {prop?.address}, {prop?.suburb}
                  {prop?.accessCode && (<><Sep />{prop.accessCode}</>)}
                </p>
                <a href={`#/provider/projects/${p.id}`} className="btn-ghost mt-3 px-3 py-1 text-xs">Open project</a>
                {p.scopeOfWorks && <p className="mt-2 text-sm text-slate-600">{p.scopeOfWorks}</p>}
                <div className="mt-4"><ProjectProgress p={p} /></div>
                <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
                  {p.milestones.map((m) => (
                    <li key={m.id}>
                      <label className="flex cursor-pointer items-center gap-3 py-2 text-sm">
                        <input type="checkbox" className="h-4 w-4 accent-slate-900" checked={m.done} disabled={!canTick} onChange={() => toggle(p.id, m.id)} />
                        <span className={cx('flex-1', m.done && 'text-slate-500 line-through')}>{m.title}</span>
                        <span className="num text-xs text-slate-500">{fmtDate(m.date)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
          {bookedOnly.map((p) => {
            const prop = lk.property(p.propertyId)
            const mine = p.tasks.filter((t) => t.assigneeId === user?.id && t.status !== 'done')
            const defects = p.defects.filter((d) => d.assigneeId === user?.id && d.status === 'open').length
            return (
              <div key={p.id} className="card p-5">
                <div className="flex flex-wrap items-center gap-x-3">
                  <span className="num text-xs text-slate-500">P-{p.number}</span>
                  <ProjectStatusText s={p.status} />
                </div>
                <h2 className="mt-1 text-lg font-bold">
                  <a href={`#/provider/projects/${p.id}`} className="hover:underline">{p.title}</a>
                </h2>
                <p className="text-sm text-slate-500">{[prop?.address, prop?.suburb].filter(Boolean).join(', ')}</p>
                <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 text-sm">
                  {mine.length === 0 ? (
                    <li className="py-2 text-slate-500">All your bookings here are done.</li>
                  ) : (
                    mine.map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                        <span>{t.title}</span>
                        <span className="num text-xs text-slate-500">
                          {fmtDate(t.startDate)}
                          {t.startTime ? `, ${fmtTime(t.startTime)}` : ''}
                        </span>
                      </li>
                    ))
                  )}
                </ul>
                {defects > 0 && <p className="mt-2 text-sm font-semibold text-red-700">{defects} defect{defects === 1 ? '' : 's'} to fix</p>}
                <a href={`#/provider/projects/${p.id}`} className="btn-ghost mt-3 px-3 py-1 text-xs">Open project</a>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

const DAY_MS = 86_400_000
// By calendar days, not 24-hour steps: the days the clocks change are 23 or 25 hours long.
const shiftDate = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return toISODate(d)
}
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / DAY_MS)

/**
 * The trade's own maintenance orders and project bookings, which they can move (drag, or click and
 * pick a day), plus other trades' bookings on the same projects so they know who else is on site.
 * Nothing from other jobs, and nothing else can be moved. The office is told when they move one.
 */
function ProviderCalendar() {
  const { user, update, canAct } = useStore()
  const a = useAssigned()
  const lk = useLookup()
  // The trade can always move their own; an admin in their dashboard needs the office permission.
  const canMove = (ev: CalEvent) => !ev.locked && canAct(ev.kind === 'request' ? 'canDispatchJobs' : 'canManageProjects')
  const anyMovable = canAct('canDispatchJobs') || canAct('canManageProjects')
  const [openId, setOpenId] = useState<string | null>(null)
  const [picked, setPicked] = useState<CalEvent | null>(null)
  const [moveTo, setMoveTo] = useState('')
  const live = (status: string) => status === 'approved' || status === 'in_progress'
  const events = useMemo<CalEvent[]>(() => {
    const evs: CalEvent[] = []
    for (const r of a.requests) {
      if (!r.scheduledDate) continue
      const prop = lk.property(r.propertyId)
      evs.push({ id: `r:${r.id}`, date: r.scheduledDate, title: `#${r.number} ${r.title}`, kind: 'request', urgent: r.urgency === 'urgent', done: r.status === 'completed', subtitle: prop ? `${prop.address}, ${prop.suburb}` : undefined })
    }
    for (const p of a.worksOn) {
      if (!live(p.status)) continue
      for (const t of p.tasks) {
        const mine = t.assigneeId === user?.id
        // Only bookings: tasks with no trade yet aren't anyone's.
        if (!t.assigneeId) continue
        const days = daysBetween(t.startDate, t.endDate) + 1
        const who = mine ? '' : `${lk.user(t.assigneeId)?.name ?? 'Another trade'}: `
        evs.push({
          id: `t:${p.id}:${t.id}`,
          date: t.startDate,
          title: `${who}${t.title}${days > 1 ? ` (${days} days)` : ''}`,
          kind: 'booking',
          locked: !mine,
          done: t.status === 'done',
          subtitle: `P-${p.number} ${p.title}`,
        })
      }
    }
    return evs
  }, [a, lk, user])

  const move = (ev: CalEvent, date: string) => {
    if (!canMove(ev) || !date) return
    update((d) => {
      const [kind, x, y] = ev.id.split(':')
      if (kind === 'r') {
        const r = d.requests.find((q) => q.id === x && q.assignedProviderId === user?.id)
        if (r) r.scheduledDate = date
      } else if (kind === 't') {
        const t = d.projects.find((p) => p.id === x)?.tasks.find((q) => q.id === y && q.assigneeId === user?.id)
        if (t) {
          // The booking keeps its length.
          const by = daysBetween(t.startDate, date)
          t.startDate = date
          t.endDate = shiftDate(t.endDate, by)
        }
      }
    })
  }
  const projectOf = (ev: CalEvent) => (ev.kind === 'booking' ? ev.id.split(':')[1] : undefined)

  return (
    <>
      <PageHeader title="Calendar" subtitle="Your maintenance visits and project bookings, and who else is booked on your projects. Move your own by dragging, or click one to pick a new day." />
      <Calendar
        events={events}
        onMove={anyMovable ? move : undefined}
        onOpen={(ev) => {
          setPicked(ev)
          setMoveTo(ev.date)
        }}
      />
      <Modal open={!!picked} onClose={() => setPicked(null)} title={picked?.title ?? ''}>
        {picked && (
          <div className="space-y-4">
            {picked.subtitle && <p className="text-sm text-slate-600">{picked.subtitle}</p>}
            {picked.locked ? (
              <p className="text-sm text-slate-600">
                Another trade's booking on your project, on <span className="num font-semibold">{fmtDate(picked.date)}</span>. Only they or the office can move it.
              </p>
            ) : !canMove(picked) ? (
              <p className="text-sm text-slate-600">
                On <span className="num font-semibold">{fmtDate(picked.date)}</span>. Your admin account needs “{picked.kind === 'request' ? 'Dispatch & assign jobs' : 'Manage projects & quotes'}” to move it here.
              </p>
            ) : (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (moveTo !== picked.date) move(picked, moveTo)
                  setPicked(null)
                }}
              >
                <Field label={picked.kind === 'request' ? 'Visit day' : 'Start day'}>
                  <input type="date" className="input num" required value={moveTo} onChange={(e) => setMoveTo(e.target.value)} />
                </Field>
                <button className="btn-primary" disabled={!moveTo || moveTo === picked.date}>Move</button>
                <p className="w-full text-xs text-slate-500">The office is told when you move a booking.</p>
              </form>
            )}
            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              {picked.kind === 'request' ? (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setOpenId(picked.id.slice(2))
                    setPicked(null)
                  }}
                >
                  Open job
                </button>
              ) : (
                <a className="btn-ghost" href={`#/provider/projects/${projectOf(picked)}`}>Open project</a>
              )}
            </div>
          </div>
        )}
      </Modal>
      <RequestDetail r={lk.request(openId ?? undefined)} open={!!openId} onClose={() => setOpenId(null)} />
    </>
  )
}

const OPEN_FOR_EXPENSES = ['approved', 'in_progress']

function Budget() {
  const { user, actor, update, can } = useStore()
  const a = useAssigned()
  const [adding, setAdding] = useState<string | null>(null)
  const [form, setForm] = useState({ date: todayISO(), description: '', category: 'Materials' as Expense['category'], amount: '' })
  const canSubmit = (status: string) => can('canSubmitExpenses') && OPEN_FOR_EXPENSES.includes(status)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const project = a.projects.find((p) => p.id === adding)
    if (!project || !user || !canSubmit(project.status)) return
    update((d) => {
      d.projects.find((p) => p.id === adding)?.expenses.push({
        id: uid('e'),
        providerId: user.id,
        createdBy: actor?.id,
        date: form.date,
        description: form.description,
        category: form.category,
        amount: Math.round(Number(form.amount) * 100) / 100,
        status: 'submitted',
      })
    })
    setAdding(null)
    setForm({ date: todayISO(), description: '', category: 'Materials', amount: '' })
  }

  return (
    <>
      <PageHeader title="Budget & expenses" subtitle="Costs are reviewed by the office before approval." />
      {a.projects.length === 0 ? (
        <Empty title="No projects assigned" />
      ) : (
        <div className="space-y-6">
          {a.projects.map((p) => {
            const approved = p.expenses.filter((e) => e.status === 'approved').reduce((s, e) => s + e.amount, 0)
            const submitted = p.expenses.filter((e) => e.status === 'submitted').reduce((s, e) => s + e.amount, 0)
            const pct = p.budget ? Math.min(100, ((approved + submitted) / p.budget) * 100) : 0
            return (
              <section key={p.id} className="card overflow-hidden">
                <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="num text-xs text-slate-500">P-{p.number}</p>
                    <h2 className="font-bold">{p.title}</h2>
                  </div>
                  {canSubmit(p.status) ? (
                    <button className="btn-primary" onClick={() => setAdding(p.id)}><Plus size={16} /> Submit expense</button>
                  ) : (
                    <span className="text-xs text-slate-500">
                      {can('canSubmitExpenses')
                        ? 'Project closed for new expenses'
                        : actor?.id !== user?.id
                          ? 'Your admin account needs “Manage projects & quotes” to add expenses here'
                          : 'Expense submission not enabled for your account'}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 divide-x divide-slate-100 border-b border-slate-100 text-sm">
                  <div className="px-5 py-3"><p className="text-xs text-slate-500">Budget</p><p className="num">{money(p.budget)}</p></div>
                  <div className="px-5 py-3"><p className="text-xs text-slate-500">Approved</p><p className="num">{money(approved)}</p></div>
                  <div className="px-5 py-3"><p className="text-xs text-slate-500">Pending</p><p className="num">{money(submitted)}</p></div>
                </div>
                <div className="px-5 pt-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className={cx('h-full', pct > 90 ? 'bg-accent' : 'bg-slate-900')} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="num mt-1 text-xs text-slate-500">{pct.toFixed(0)}% of budget committed</p>
                </div>
                <ExpenseTable expenses={p.expenses} />
              </section>
            )
          })}
        </div>
      )}
      <Modal open={!!adding} onClose={() => setAdding(null)} title="Submit expense">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <Field label="Date"><input type="date" className="input num" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label="Category">
            <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as Expense['category'] })}>
              {['Materials', 'Labour', 'Equipment hire', 'Subcontractor', 'Other'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Description" className="sm:col-span-2"><input className="input" required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Amount (AUD, inc. GST)"><input type="number" min="0.01" step="0.01" className="input num" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
          <div className="flex items-end justify-end"><button className="btn-primary">Submit</button></div>
        </form>
      </Modal>
    </>
  )
}

export function ExpenseTable({ expenses, actions }: { expenses: Expense[]; actions?: (e: Expense) => ReactNode }) {
  const lk = useLookup()
  if (expenses.length === 0) return <p className="px-5 py-4 text-sm text-slate-500">No expenses recorded.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px]">
        <thead className="border-b border-slate-100">
          <tr>
            <th className="th">Date</th>
            <th className="th">Description</th>
            <th className="th">Category</th>
            <th className="th text-right">Amount</th>
            <th className="th">Status</th>
            {actions && <th className="th" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {expenses.map((e) => {
            // Shown when an admin added it from the trade's dashboard.
            const addedBy = e.createdBy && e.createdBy !== e.providerId ? `Added by ${lk.byName(e.createdBy)}` : ''
            const meta = [actions ? lk.user(e.providerId)?.name : '', addedBy].filter(Boolean).join(' · ')
            return (
              <tr key={e.id}>
                <td className="td num whitespace-nowrap text-slate-600">{fmtDate(e.date)}</td>
                <td className="td">
                  {e.description}
                  {meta && <span className="block text-xs text-slate-500">{meta}</span>}
                </td>
                <td className="td text-slate-600">{e.category}</td>
                <td className="td num text-right">{money(e.amount)}</td>
                <td className="td">
                  <Status tone={e.status === 'approved' ? 'green' : e.status === 'rejected' ? 'red' : 'orange'}>
                    {e.status === 'submitted' ? 'Awaiting approval' : e.status === 'approved' ? 'Approved' : 'Rejected'}
                  </Status>
                </td>
                {actions && <td className="td text-right">{actions(e)}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
