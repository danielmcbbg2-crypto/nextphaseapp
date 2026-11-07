import { useMemo, useState } from 'react'
import { CheckCircle2, Clock, FileText, MapPin } from 'lucide-react'
import { Field, PhotoInput, Tabs } from './ui'
import { Photos, Timeline, size, useOpenDocument } from '../pages/admin/ProjectWorkspace'
import { useLookup, useStore } from '../lib/store'
import { DEFECT_STATUS_LABEL, DOCUMENT_CATEGORIES, TASK_STATUS_LABEL, type Defect, type DefectStatus, type Project, type ProjectTask } from '../lib/types'
import { cx, fmtDate, fmtDateTime, todayISO, uid } from '../lib/utils'

type Viewer = 'client' | 'trade'
type Tab = 'schedule' | 'diary' | 'defects' | 'documents'

/** "7:30 am" from "07:30". */
export const fmtTime = (t?: string) => {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}
const dates = (t: Pick<ProjectTask, 'startDate' | 'endDate'>) => (t.startDate === t.endDate ? fmtDate(t.startDate) : `${fmtDate(t.startDate)} – ${fmtDate(t.endDate)}`)
const DEFECT_TONE: Record<DefectStatus, string> = { open: 'bg-red-600', fixed: 'bg-amber-500', closed: 'bg-emerald-600' }

/**
 * What a client or a trade sees of a project's site: the same rules as the database, so demo mode
 * (which holds everything) shows each person only their part.
 *   client  tasks shown to them, diary entries shared with them, every defect (and raise one),
 *           documents shared with them
 *   trade   the project's own trade sees every task and defect; a trade booked for some tasks sees
 *           those and the defects given to them. Both see the diary (and add to it) and documents
 *           shared with trades.
 */
export function useSiteView(p: Project, as: Viewer) {
  const { user } = useStore()
  return useMemo(() => {
    const me = user?.id
    const projectTrade = as === 'trade' && p.assignedProviderId === me
    const booked = as === 'trade' && p.tasks.some((t) => t.assigneeId === me)
    const sortTasks = (ts: ProjectTask[]) => [...ts].sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.startTime ?? '').localeCompare(b.startTime ?? ''))
    return {
      me,
      projectTrade,
      tasks: sortTasks(as === 'client' ? p.tasks.filter((t) => t.clientVisible) : projectTrade ? p.tasks : p.tasks.filter((t) => t.assigneeId === me)),
      diary: as === 'client' ? p.diary.filter((e) => e.shareWithClient) : projectTrade || booked ? p.diary : [],
      canWriteDiary: as === 'trade' && (projectTrade || booked),
      defects: as === 'client' || projectTrade ? p.defects : p.defects.filter((d) => d.assigneeId === me),
      documents: p.documents.filter((d) => (as === 'client' ? d.share === 'client' || d.share === 'everyone' : (projectTrade || booked) && (d.share === 'trades' || d.share === 'everyone'))),
    }
  }, [p, as, user])
}

/** The tabs of a project's site for its client or a trade working on it. */
export function SiteView({ p, as }: { p: Project; as: Viewer }) {
  const v = useSiteView(p, as)
  const open = v.defects.filter((d) => d.status !== 'closed').length
  const [tab, setTab] = useState<Tab>('schedule')
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'schedule', label: as === 'trade' && !v.projectTrade ? 'My bookings' : 'Schedule', count: v.tasks.filter((t) => t.status !== 'done').length },
          { value: 'diary', label: 'Site diary', count: v.diary.length },
          { value: 'defects', label: 'Defects', count: open },
          { value: 'documents', label: 'Documents', count: v.documents.length },
        ]}
      />
      {tab === 'schedule' ? <Schedule p={p} as={as} /> : tab === 'diary' ? <Diary p={p} as={as} /> : tab === 'defects' ? <Defects p={p} as={as} /> : <Documents p={p} as={as} />}
    </>
  )
}

function useChange(projectId: string) {
  const { update } = useStore()
  return (fn: (p: Project) => void) =>
    update((d) => {
      const p = d.projects.find((x) => x.id === projectId)
      if (p) fn(p)
    })
}

function Schedule({ p, as }: { p: Project; as: Viewer }) {
  const v = useSiteView(p, as)
  const lk = useLookup()
  const change = useChange(p.id)
  const today = todayISO()
  const setTask = (id: string, patch: Partial<Pick<ProjectTask, 'status' | 'notes'>>) =>
    change((x) => {
      const t = x.tasks.find((y) => y.id === id)
      if (t) Object.assign(t, patch)
    })
  if (v.tasks.length === 0) return <p className="text-sm text-slate-500">{as === 'client' ? 'The schedule will show here once the office has planned the work.' : 'Nothing booked for you on this job.'}</p>
  const tradeName = (t: ProjectTask) => (t.assigneeId ? lk.user(t.assigneeId)?.name : undefined)
  return (
    <div className="space-y-4">
      {v.tasks.length > 1 && <Timeline tasks={v.tasks} onPick={(id) => document.getElementById(`site-task-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })} labelFor={(t) => [t.stage, as === 'trade' ? tradeName(t) : ''].filter(Boolean).join(' · ')} />}
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {v.tasks.map((t) => {
          const mine = as === 'trade' && t.assigneeId === v.me
          const late = t.status !== 'done' && t.endDate < today
          return (
            <li key={t.id} id={`site-task-${t.id}`} className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <p className={cx('font-medium', t.status === 'done' && 'text-slate-500 line-through')}>
                  {t.stage && <span className="font-normal text-slate-500">{t.stage} · </span>}
                  {t.title}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
                  <span className="num">{dates(t)}</span>
                  {t.startTime && <span className="num inline-flex items-center gap-1"><Clock size={12} aria-hidden="true" /> from {fmtTime(t.startTime)}</span>}
                  {as === 'trade' && !mine && <span>{tradeName(t) ?? 'No trade yet'}</span>}
                  {late && <span className="font-semibold text-red-600">Running late</span>}
                </p>
                {mine ? (
                  <input
                    className="input mt-2 py-1 text-xs"
                    aria-label={`Notes for ${t.title}`}
                    placeholder="Notes for the office (running late, materials needed…)"
                    defaultValue={t.notes}
                    onBlur={(e) => e.target.value !== t.notes && setTask(t.id, { notes: e.target.value.slice(0, 2000) })}
                  />
                ) : (
                  t.notes && as === 'trade' && <p className="mt-1 text-xs text-slate-600">{t.notes}</p>
                )}
              </div>
              <div className="flex items-start gap-2 sm:justify-end">
                {mine && t.status === 'todo' && <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => setTask(t.id, { status: 'in_progress' })}>Start</button>}
                {mine && t.status !== 'done' && <button type="button" className="btn-primary px-3 py-1 text-xs" onClick={() => setTask(t.id, { status: 'done' })}><CheckCircle2 size={13} /> Done</button>}
                {mine && t.status === 'done' && <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => setTask(t.id, { status: 'in_progress' })}>Not finished</button>}
                {!mine && <span className="text-xs font-semibold text-slate-600">{TASK_STATUS_LABEL[t.status]}</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Diary({ p, as }: { p: Project; as: Viewer }) {
  const v = useSiteView(p, as)
  const { user } = useStore()
  const lk = useLookup()
  const change = useChange(p.id)
  const blank = () => ({ date: todayISO(), weather: '', onSite: '', workDone: '', issues: '', photos: [] as string[] })
  const [f, setF] = useState(blank)
  const add = () => {
    change((x) => {
      x.diary.unshift({ id: uid('dy'), ...f, workDone: f.workDone.trim(), issues: f.issues.trim(), shareWithClient: false, authorId: user?.id, createdAt: new Date().toISOString() })
      x.diary.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    })
    setF(blank())
  }
  return (
    <div className="space-y-5">
      {v.canWriteDiary && (
        <fieldset className="grid gap-3 rounded-md border border-slate-200 p-4 sm:grid-cols-4">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Today on site</legend>
          <Field label="Date"><input type="date" className="input num" value={f.date} max={todayISO()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Weather"><input className="input" value={f.weather} onChange={(e) => setF({ ...f, weather: e.target.value })} placeholder="Fine, 21°" /></Field>
          <Field label="On site" className="sm:col-span-2"><input className="input" value={f.onSite} onChange={(e) => setF({ ...f, onSite: e.target.value })} placeholder="Who was there" /></Field>
          <Field label="Work done" className="sm:col-span-4"><textarea className="input min-h-[70px]" value={f.workDone} onChange={(e) => setF({ ...f, workDone: e.target.value })} /></Field>
          <Field label="Issues or delays" className="sm:col-span-4"><input className="input" value={f.issues} onChange={(e) => setF({ ...f, issues: e.target.value })} /></Field>
          <div className="sm:col-span-3">
            <span className="label">Photos</span>
            <PhotoInput value={f.photos} onChange={(photos) => setF({ ...f, photos })} max={12} />
          </div>
          <div className="flex items-end justify-end">
            <button type="button" className="btn-primary" disabled={!f.workDone.trim() || !f.date} onClick={add}>Add entry</button>
          </div>
          <p className="text-xs text-slate-500 sm:col-span-4">The office sees every entry and decides which ones the client sees.</p>
        </fieldset>
      )}
      {v.diary.length === 0 ? (
        <p className="text-sm text-slate-500">{as === 'client' ? 'Progress updates from site will show here.' : 'No diary entries yet.'}</p>
      ) : (
        <ol className="space-y-3">
          {v.diary.map((e) => (
            <li key={e.id} className="rounded-md border border-slate-200 p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">
                  {fmtDate(e.date)}
                  {e.weather && <span className="font-normal text-slate-500"> · {e.weather}</span>}
                  {as === 'trade' && e.onSite && <span className="font-normal text-slate-500"> · {e.onSite}</span>}
                </p>
                <span className="text-xs text-slate-500">{lk.byName(e.authorId)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-slate-800">{e.workDone}</p>
              {e.issues && <p className="mt-1 text-amber-700">{as === 'client' ? 'Note' : 'Issue'}: {e.issues}</p>}
              <Photos urls={e.photos} label="Diary photo" />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Defects({ p, as }: { p: Project; as: Viewer }) {
  const v = useSiteView(p, as)
  const { user } = useStore()
  const lk = useLookup()
  const change = useChange(p.id)
  const blank = () => ({ title: '', location: '', description: '', photos: [] as string[] })
  const [f, setF] = useState(blank)
  const [fixing, setFixing] = useState<{ id: string; notes: string; photos: string[] } | null>(null)
  const raise = () => {
    change((x) => {
      x.defects.push({
        id: uid('df'),
        number: Math.max(0, ...x.defects.map((d) => d.number)) + 1,
        title: f.title.trim(),
        location: f.location.trim(),
        description: f.description.trim(),
        status: 'open',
        photos: f.photos,
        fixPhotos: [],
        fixNotes: '',
        raisedBy: user?.id,
        raisedAt: new Date().toISOString(),
      })
    })
    setF(blank())
  }
  const markFixed = () => {
    if (!fixing) return
    change((x) => {
      const d = x.defects.find((y) => y.id === fixing.id)
      if (d) Object.assign(d, { status: 'fixed', fixNotes: fixing.notes.trim(), fixPhotos: fixing.photos, fixedBy: user?.id, fixedAt: new Date().toISOString() } satisfies Partial<Defect>)
    })
    setFixing(null)
  }
  const list = [...v.defects].sort((a, b) => (a.status === 'closed' ? 1 : 0) - (b.status === 'closed' ? 1 : 0) || a.number - b.number)
  return (
    <div className="space-y-5">
      {as === 'client' && (
        <fieldset className="grid gap-3 rounded-md border border-slate-200 p-4 sm:grid-cols-4">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Something not right?</legend>
          <Field label="What's wrong" className="sm:col-span-2"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Cupboard door doesn't close" /></Field>
          <Field label="Where" className="sm:col-span-2"><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Kitchen" /></Field>
          <Field label="Details" className="sm:col-span-4"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="sm:col-span-3">
            <span className="label">Photos</span>
            <PhotoInput value={f.photos} onChange={(photos) => setF({ ...f, photos })} max={8} />
          </div>
          <div className="flex items-end justify-end">
            <button type="button" className="btn-primary" disabled={!f.title.trim()} onClick={raise}>Report it</button>
          </div>
        </fieldset>
      )}
      {list.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-slate-500"><CheckCircle2 size={16} className="text-emerald-600" /> {as === 'client' ? 'No defects reported.' : 'No defects for you.'}</p>
      ) : (
        <ul className="space-y-3">
          {list.map((d) => {
            const canFix = as === 'trade' && d.status === 'open' && (d.assigneeId === v.me || v.projectTrade)
            return (
              <li key={d.id} className="rounded-md border border-slate-200 p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      <span className="num text-slate-500">#{d.number}</span> {d.title}
                      {d.location && <span className="font-normal text-slate-500"> · {d.location}</span>}
                    </p>
                    {d.description && <p className="text-slate-700">{d.description}</p>}
                    <p className="mt-0.5 text-xs text-slate-500">
                      Reported {fmtDateTime(d.raisedAt)}
                      {as === 'trade' && d.dueDate && <span className={d.status === 'open' && d.dueDate < todayISO() ? 'font-semibold text-red-600' : ''}> · fix by {fmtDate(d.dueDate)}</span>}
                    </p>
                  </div>
                  <span className={`px-1.5 py-0.5 text-[11px] font-semibold uppercase text-white ${DEFECT_TONE[d.status]}`}>{as === 'client' && d.status === 'fixed' ? 'Fixed' : DEFECT_STATUS_LABEL[d.status]}</span>
                </div>
                <Photos urls={d.photos} label={`Defect ${d.number} photo`} />
                {(d.fixNotes || d.fixPhotos.length > 0) && (
                  <div className="mt-2 rounded bg-slate-50 p-2">
                    <p className="text-xs text-slate-600">
                      Fixed by {lk.byName(d.fixedBy)}
                      {d.fixedAt && ` ${fmtDateTime(d.fixedAt)}`}
                      {d.fixNotes && `: ${d.fixNotes}`}
                    </p>
                    <Photos urls={d.fixPhotos} label={`Defect ${d.number} fix photo`} />
                  </div>
                )}
                {canFix &&
                  (fixing?.id === d.id ? (
                    <div className="mt-3 space-y-2 rounded-md border border-slate-200 p-3">
                      <Field label="What you did"><input className="input" value={fixing.notes} onChange={(e) => setFixing({ ...fixing, notes: e.target.value })} /></Field>
                      <div>
                        <span className="label">Photos of the fix</span>
                        <PhotoInput value={fixing.photos} onChange={(photos) => setFixing({ ...fixing, photos })} max={8} />
                      </div>
                      <div className="flex justify-end gap-2">
                        <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => setFixing(null)}>Cancel</button>
                        <button type="button" className="btn-primary px-3 py-1 text-xs" onClick={markFixed}><CheckCircle2 size={13} /> Mark fixed</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="btn-ghost mt-3 px-3 py-1 text-xs" onClick={() => setFixing({ id: d.id, notes: '', photos: [] })}>I've fixed this</button>
                  ))}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Documents({ p, as }: { p: Project; as: Viewer }) {
  const v = useSiteView(p, as)
  const [error, setError] = useState<string | null>(null)
  const open = useOpenDocument(setError)
  const groups = DOCUMENT_CATEGORIES.map((c) => ({ c, docs: v.documents.filter((d) => d.category === c) })).filter((g) => g.docs.length)
  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {groups.length === 0 ? (
        <p className="text-sm text-slate-500">No documents shared yet.</p>
      ) : (
        groups.map((g) => (
          <section key={g.c}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.c}</h3>
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
              {g.docs.map((d) => (
                <li key={d.id}>
                  <button type="button" className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50" onClick={() => void open(d)}>
                    <FileText size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                    <span className="num text-xs text-slate-500">{size(d.sizeBytes)} · {fmtDate(d.uploadedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <p className="text-xs text-slate-500">Files open in a new tab. Links are private and last a few minutes.</p>
    </div>
  )
}

/** The page header for a project site: number, title, address and how far along it is. */
export function SiteHeader({ p, as, back }: { p: Project; as: Viewer; back: string }) {
  const lk = useLookup()
  const v = useSiteView(p, as)
  const prop = lk.property(p.propertyId)
  const next = v.tasks.find((t) => t.status !== 'done' && (as === 'client' || t.assigneeId === v.me))
  return (
    <div className="mb-6">
      <a href={back} className="text-sm font-semibold text-slate-600 hover:text-slate-900">← All projects</a>
      <p className="mt-3 num text-xs text-slate-500">P-{p.number}</p>
      <h1 className="text-2xl font-bold">{p.title}</h1>
      {prop && (
        <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-600">
          <MapPin size={14} aria-hidden="true" /> {[prop.address, prop.suburb].filter(Boolean).join(', ')}
          {v.projectTrade && prop.accessCode && <span className="text-slate-500"> · Access: {prop.accessCode}</span>}
        </p>
      )}
      {next && (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-sm text-amber-900">
          <Clock size={14} aria-hidden="true" /> {as === 'client' ? 'Next' : 'Your next booking'}: {next.title}, <span className="num">{dates(next)}{next.startTime ? `, ${fmtTime(next.startTime)}` : ''}</span>
        </p>
      )}
    </div>
  )
}
