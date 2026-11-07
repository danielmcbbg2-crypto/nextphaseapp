import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Download, FileText, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Field, PhotoInput } from '../../components/ui'
import { useLookup, useStore } from '../../lib/store'
import {
  DEFECT_STATUS_LABEL,
  DOCUMENT_CATEGORIES,
  DOCUMENT_SHARE_LABEL,
  TASK_STATUS_LABEL,
  type Defect,
  type DefectStatus,
  type DocumentShare,
  type Project,
  type ProjectDocument,
  type ProjectTask,
  type TaskStatus,
} from '../../lib/types'
import { fmtDate, fmtDateTime, todayISO, uid } from '../../lib/utils'

const DAY = 86_400_000
const toTime = (iso: string) => new Date(`${iso}T00:00:00`).getTime()
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const overlaps = (a: Pick<ProjectTask, 'startDate' | 'endDate'>, b: Pick<ProjectTask, 'startDate' | 'endDate'>) => a.startDate <= b.endDate && b.startDate <= a.endDate
const isLate = (t: ProjectTask, today: string) => t.status !== 'done' && t.endDate < today

/** Other bookings of the same trade that overlap this task, on any project. */
export function clashes(t: ProjectTask, projects: Project[]) {
  if (!t.assigneeId || t.status === 'done') return []
  return projects.flatMap((p) =>
    p.tasks
      .filter((o) => o.id !== t.id && o.assigneeId === t.assigneeId && o.status !== 'done' && overlaps(t, o))
      .map((o) => ({ p, t: o })),
  )
}

const BAR: Record<TaskStatus | 'late', string> = {
  done: 'bg-slate-400',
  in_progress: 'bg-accent',
  todo: 'bg-slate-800',
  late: 'bg-red-600',
}

/** A Gantt-style view of the schedule: one bar per task across the days it runs, with today marked. */
export function Timeline({ tasks, onPick, labelFor }: { tasks: ProjectTask[]; onPick: (id: string) => void; labelFor: (t: ProjectTask) => string }) {
  const today = todayISO()
  if (tasks.length === 0) return null
  const first = tasks.reduce((m, t) => (t.startDate < m ? t.startDate : m), tasks[0].startDate)
  const last = tasks.reduce((m, t) => (t.endDate > m ? t.endDate : m), tasks[0].endDate)
  const start = addDays(first, -1)
  const end = addDays(last, 1)
  const span = Math.max(1, Math.round((toTime(end) - toTime(start)) / DAY) + 1)
  const pct = (iso: string) => ((toTime(iso) - toTime(start)) / DAY / span) * 100
  // Week marks (Mondays) for orientation.
  const marks: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) if (new Date(`${d}T00:00:00`).getDay() === 1) marks.push(d)
  const todayIn = today >= start && today <= end
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <div className="min-w-[720px]">
        <div className="relative ml-56 h-7 border-b border-slate-200 text-[11px] text-slate-500">
          {marks.map((m) => (
            <span key={m} className="absolute top-1.5 -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct(m)}%` }}>
              {fmtDate(m).replace(/ \d{4}$/, '')}
            </span>
          ))}
        </div>
        <ul className="relative">
          {todayIn && (
            <li aria-hidden="true" className="pointer-events-none absolute bottom-0 top-0 z-10 ml-56 w-[calc(100%-14rem)]">
              <span className="absolute bottom-0 top-0 w-px bg-accent" style={{ left: `${pct(today)}%` }} />
            </li>
          )}
          {tasks.map((t) => {
            const late = isLate(t, today)
            return (
              <li key={t.id} className="flex h-9 items-center border-b border-slate-100 last:border-b-0">
                <button type="button" className="w-56 shrink-0 truncate px-3 text-left text-xs hover:underline" onClick={() => onPick(t.id)} title={t.title}>
                  <span className={t.status === 'done' ? 'text-slate-400 line-through' : ''}>{t.title}</span>
                  <span className="block truncate text-[11px] text-slate-500">{labelFor(t)}</span>
                </button>
                <div className="relative h-full flex-1">
                  {marks.map((m) => (
                    <span key={m} aria-hidden="true" className="absolute bottom-0 top-0 w-px bg-slate-100" style={{ left: `${pct(m)}%` }} />
                  ))}
                  <button
                    type="button"
                    onClick={() => onPick(t.id)}
                    className={`absolute top-2 h-5 rounded-sm ${BAR[late ? 'late' : t.status]} hover:opacity-90`}
                    style={{ left: `${pct(t.startDate)}%`, width: `max(${(((toTime(t.endDate) - toTime(t.startDate)) / DAY + 1) / span) * 100}%, 6px)` }}
                    aria-label={`${t.title}: ${fmtDate(t.startDate)} to ${fmtDate(t.endDate)}, ${late ? 'overdue' : TASK_STATUS_LABEL[t.status]}`}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </div>
      <p className="flex flex-wrap gap-4 border-t border-slate-200 px-3 py-2 text-[11px] text-slate-500">
        {(['todo', 'in_progress', 'done', 'late'] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-4 rounded-sm ${BAR[k]}`} /> {k === 'late' ? 'Overdue' : TASK_STATUS_LABEL[k]}
          </span>
        ))}
        {todayIn && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-px bg-accent" /> Today
          </span>
        )}
      </p>
    </div>
  )
}

/** Office: the schedule (stages and tasks booked with trades), part of the project's saved draft. */
/** The schedule at a glance (for the project's overview): the timeline and each task, read-only. */
export function ScheduleSummary({ p, onEdit }: { p: Project; onEdit: () => void }) {
  const lk = useLookup()
  const today = todayISO()
  const tasks = [...p.tasks].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate))
  const done = tasks.filter((t) => t.status === 'done').length
  const late = tasks.filter((t) => isLate(t, today)).length
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="label mb-0">Schedule</span>
        <span className="text-xs text-slate-500">
          {tasks.length ? `${done} of ${tasks.length} tasks done` : 'No tasks yet'}
          {late > 0 && <span className="ml-1 font-semibold text-red-600">· {late} overdue</span>}
        </span>
        <button type="button" className="btn-ghost ml-auto px-2.5 py-1 text-xs" onClick={onEdit}>
          {tasks.length ? 'Edit schedule' : <><Plus size={14} /> Plan the schedule</>}
        </button>
      </div>
      {tasks.length > 0 && (
        <>
          <Timeline tasks={tasks} onPick={onEdit} labelFor={(t) => [t.stage, t.assigneeId ? lk.user(t.assigneeId)?.name : 'No trade yet'].filter(Boolean).join(' · ')} />
          <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200" aria-label="Schedule">
            {tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className={t.status === 'done' ? 'flex-1 text-slate-500 line-through' : 'flex-1 text-slate-800'}>
                  {t.stage && <span className="text-slate-500">{t.stage} · </span>}
                  {t.title || 'Untitled task'}
                </span>
                <span className="text-xs text-slate-500">{t.assigneeId ? lk.user(t.assigneeId)?.name : 'No trade yet'}</span>
                <span className="num text-xs text-slate-500">{t.startDate === t.endDate ? fmtDate(t.startDate) : `${fmtDate(t.startDate)} – ${fmtDate(t.endDate)}`}</span>
                <span className={isLate(t, today) ? 'text-xs font-semibold text-red-600' : 'text-xs text-slate-600'}>{isLate(t, today) ? 'Late' : TASK_STATUS_LABEL[t.status]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export function SchedulePanel({ p, set }: { p: Project; set: (patch: Partial<Project>) => void }) {
  const { data } = useStore()
  const lk = useLookup()
  const today = todayISO()
  const [focus, setFocus] = useState<string | null>(null)
  const [push, setPush] = useState(1)
  const tasks = useMemo(() => [...p.tasks].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate)), [p.tasks])
  // Clashes are checked against this draft for this project and the saved schedules of the others.
  const others = data.projects.map((x) => (x.id === p.id ? p : x))
  const setTask = (id: string, patch: Partial<ProjectTask>) => set({ tasks: p.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
  const addTask = () => {
    const after = tasks.at(-1)
    const startDate = after ? addDays(after.endDate, 1) : today
    const id = uid('t')
    set({ tasks: [...p.tasks, { id, stage: after?.stage ?? '', title: '', startDate, endDate: startDate, startTime: '07:30', status: 'todo', notes: '', clientVisible: true }] })
    setFocus(id)
  }
  const done = p.tasks.filter((t) => t.status === 'done').length
  const late = p.tasks.filter((t) => isLate(t, today)).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-slate-600">
          {p.tasks.length ? `${done} of ${p.tasks.length} tasks done` : 'No tasks yet'}
          {late > 0 && <span className="ml-2 font-semibold text-red-600">· {late} overdue</span>}
        </span>
        {p.tasks.some((t) => t.status !== 'done') && (
          <span className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-slate-600">
              Push unfinished tasks back
              <input type="number" min="1" max="60" className="input num w-16 py-1" aria-label="Days to push back" value={push} onChange={(e) => setPush(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} />
              day{push === 1 ? '' : 's'}
            </label>
            <button
              type="button"
              className="btn-ghost px-3 py-1"
              onClick={() =>
                set({ tasks: p.tasks.map((t) => (t.status === 'done' ? t : { ...t, startDate: t.status === 'in_progress' ? t.startDate : addDays(t.startDate, push), endDate: addDays(t.endDate, push) })) })
              }
            >
              Push back
            </button>
          </span>
        )}
        <button type="button" className={`btn-ghost ${p.tasks.some((t) => t.status !== 'done') ? '' : 'ml-auto'}`} onClick={addTask}>
          <Plus size={15} /> Add task
        </button>
      </div>
      {p.tasks.length === 0 ? (
        <p className="rounded-md bg-slate-50 p-4 text-sm text-slate-600">
          Plan the job as tasks: what, when, and which trade. Each one shows on the timeline, on the trade's schedule and (if you like) the client's,
          and drives reminders before each booking.
        </p>
      ) : (
        <Timeline tasks={tasks} onPick={setFocus} labelFor={(t) => [t.stage, t.assigneeId ? lk.user(t.assigneeId)?.name : 'No trade yet'].filter(Boolean).join(' · ')} />
      )}
      {tasks.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-2 py-2 font-semibold">Stage</th>
                <th className="px-2 py-2 font-semibold">Task</th>
                <th className="px-2 py-2 font-semibold">Trade</th>
                <th className="px-2 py-2 font-semibold">From</th>
                <th className="px-2 py-2 font-semibold">To</th>
                <th className="px-2 py-2 font-semibold">Arrive</th>
                <th className="px-2 py-2 font-semibold">Status</th>
                <th className="px-2 py-2 font-semibold" title="Shown on the client's schedule">Client</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tasks.map((t) => {
                const clash = clashes(t, others)
                const lateNow = isLate(t, today)
                return (
                  <tr key={t.id} className={focus === t.id ? 'bg-amber-50' : undefined} id={`task-${t.id}`}>
                    <td className="px-2 py-1 align-top">
                      <input className="input w-28 py-1" aria-label="Stage" value={t.stage} onChange={(e) => setTask(t.id, { stage: e.target.value })} placeholder="e.g. Rough-in" />
                    </td>
                    <td className="px-2 py-1 align-top">
                      <input className="input py-1" aria-label="Task" autoFocus={focus === t.id && !t.title} value={t.title} onChange={(e) => setTask(t.id, { title: e.target.value })} />
                      <input className="input mt-1 py-0.5 text-xs" aria-label="Notes" value={t.notes} onChange={(e) => setTask(t.id, { notes: e.target.value })} placeholder="Notes (access, materials…)" />
                      {clash.map((c) => (
                        <p key={c.t.id} className="mt-1 flex items-center gap-1 text-xs text-amber-700">
                          <AlertTriangle size={12} aria-hidden="true" /> Also booked: P-{c.p.number} {c.t.title}, {fmtDate(c.t.startDate)}
                          {c.t.endDate !== c.t.startDate ? `–${fmtDate(c.t.endDate)}` : ''}
                        </p>
                      ))}
                      {lateNow && <p className="mt-1 text-xs font-semibold text-red-600">Overdue: due {fmtDate(t.endDate)}</p>}
                    </td>
                    <td className="px-2 py-1 align-top">
                      <select className="input w-40 py-1" aria-label="Trade" value={t.assigneeId ?? ''} onChange={(e) => setTask(t.id, { assigneeId: e.target.value || undefined })}>
                        <option value="">No trade yet</option>
                        {lk.providers.map((u) => <option key={u.id} value={u.id}>{u.name}{u.trade ? ` (${u.trade})` : ''}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1 align-top">
                      <input
                        type="date"
                        className="input num w-36 py-1"
                        aria-label="From"
                        value={t.startDate}
                        onChange={(e) => e.target.value && setTask(t.id, { startDate: e.target.value, endDate: t.endDate < e.target.value ? e.target.value : t.endDate })}
                      />
                    </td>
                    <td className="px-2 py-1 align-top">
                      <input type="date" className="input num w-36 py-1" aria-label="To" min={t.startDate} value={t.endDate} onChange={(e) => e.target.value && setTask(t.id, { endDate: e.target.value < t.startDate ? t.startDate : e.target.value })} />
                    </td>
                    <td className="px-2 py-1 align-top">
                      <input type="time" className="input num w-28 py-1" aria-label="Arrive" value={t.startTime ?? ''} onChange={(e) => setTask(t.id, { startTime: e.target.value || undefined })} />
                    </td>
                    <td className="px-2 py-1 align-top">
                      <select className="input w-32 py-1" aria-label="Status" value={t.status} onChange={(e) => setTask(t.id, { status: e.target.value as TaskStatus })}>
                        {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1 text-center align-top">
                      <input type="checkbox" className="mt-2 h-4 w-4 accent-slate-900" aria-label="Shown to the client" checked={t.clientVisible} onChange={(e) => setTask(t.id, { clientVisible: e.target.checked })} />
                    </td>
                    <td className="px-2 py-1 text-right align-top">
                      <button type="button" className="mt-1.5 text-slate-500 hover:text-red-600" aria-label={`Remove ${t.title || 'task'}`} onClick={() => set({ tasks: p.tasks.filter((x) => x.id !== t.id) })}>
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Changes a saved project straight away (diary, defects and documents aren't part of the draft). */
function useProjectUpdate(projectId: string) {
  const { update } = useStore()
  return (fn: (p: Project) => void) =>
    update((d) => {
      const p = d.projects.find((x) => x.id === projectId)
      if (p) fn(p)
    })
}

export function Photos({ urls, label }: { urls: string[]; label: string }) {
  if (!urls.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {urls.map((u, i) => (
        <a key={u} href={u} target="_blank" rel="noreferrer" className="block h-16 w-16 overflow-hidden border border-slate-200">
          <img src={u} alt={`${label} ${i + 1}`} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        </a>
      ))}
    </div>
  )
}

/** Office: the site diary, saved as you go. */
export function DiaryPanel({ projectId }: { projectId: string }) {
  const { data, user } = useStore()
  const lk = useLookup()
  const change = useProjectUpdate(projectId)
  const p = data.projects.find((x) => x.id === projectId)
  const blank = () => ({ date: todayISO(), weather: '', onSite: '', workDone: '', issues: '', photos: [] as string[], shareWithClient: false })
  const [f, setF] = useState(blank)
  if (!p) return null
  const add = () => {
    change((x) => {
      x.diary.unshift({ id: uid('dy'), ...f, workDone: f.workDone.trim(), issues: f.issues.trim(), authorId: user?.id, createdAt: new Date().toISOString() })
      x.diary.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    })
    setF(blank())
  }
  return (
    <div className="space-y-5">
      <fieldset className="grid gap-3 rounded-md border border-slate-200 p-4 sm:grid-cols-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">New entry</legend>
        <Field label="Date"><input type="date" className="input num" value={f.date} max={todayISO()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Weather"><input className="input" value={f.weather} onChange={(e) => setF({ ...f, weather: e.target.value })} placeholder="Fine, 21°" /></Field>
        <Field label="On site" className="sm:col-span-2"><input className="input" value={f.onSite} onChange={(e) => setF({ ...f, onSite: e.target.value })} placeholder="Who was there" /></Field>
        <Field label="Work done" className="sm:col-span-4">
          <textarea className="input min-h-[70px]" value={f.workDone} onChange={(e) => setF({ ...f, workDone: e.target.value })} />
        </Field>
        <Field label="Issues or delays" className="sm:col-span-4">
          <input className="input" value={f.issues} onChange={(e) => setF({ ...f, issues: e.target.value })} />
        </Field>
        <div className="sm:col-span-4">
          <span className="label">Photos</span>
          <PhotoInput value={f.photos} onChange={(photos) => setF({ ...f, photos })} max={12} />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-3">
          <input type="checkbox" className="h-4 w-4 accent-slate-900" checked={f.shareWithClient} onChange={(e) => setF({ ...f, shareWithClient: e.target.checked })} />
          Share with the client
        </label>
        <div className="flex justify-end">
          <button type="button" className="btn-primary" disabled={!f.workDone.trim() || !f.date} onClick={add}>Add entry</button>
        </div>
      </fieldset>
      {p.diary.length === 0 ? (
        <p className="text-sm text-slate-500">No diary entries yet. Trades can add them from their portal too.</p>
      ) : (
        <ol className="space-y-3">
          {p.diary.map((e) => (
            <li key={e.id} className="rounded-md border border-slate-200 p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">
                  {fmtDate(e.date)}
                  {e.weather && <span className="font-normal text-slate-500"> · {e.weather}</span>}
                  {e.onSite && <span className="font-normal text-slate-500"> · {e.onSite}</span>}
                </p>
                <span className="text-xs text-slate-500">{lk.user(e.authorId ?? '')?.name ?? 'Unknown'}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-slate-800">{e.workDone}</p>
              {e.issues && <p className="mt-1 text-amber-700">Issue: {e.issues}</p>}
              <Photos urls={e.photos} label="Diary photo" />
              <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                <label className="flex items-center gap-1.5 text-slate-600">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-slate-900"
                    checked={e.shareWithClient}
                    onChange={(ev) =>
                      change((x) => {
                        const y = x.diary.find((z) => z.id === e.id)
                        if (y) y.shareWithClient = ev.target.checked
                      })
                    }
                  />
                  Shared with the client
                </label>
                <button
                  type="button"
                  className="text-slate-500 hover:text-red-600"
                  aria-label="Delete entry"
                  onClick={() =>
                    change((x) => {
                      x.diary = x.diary.filter((z) => z.id !== e.id)
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

const DEFECT_TONE: Record<DefectStatus, string> = { open: 'bg-red-600', fixed: 'bg-amber-500', closed: 'bg-emerald-600' }

/** Office: the punch list, saved as you go. Trades mark items fixed; the office checks and closes them. */
export function DefectsPanel({ projectId }: { projectId: string }) {
  const { data, user } = useStore()
  const lk = useLookup()
  const change = useProjectUpdate(projectId)
  const p = data.projects.find((x) => x.id === projectId)
  const blank = () => ({ title: '', location: '', description: '', assigneeId: '', dueDate: '', photos: [] as string[] })
  const [f, setF] = useState(blank)
  const [show, setShow] = useState<'outstanding' | 'all'>('outstanding')
  if (!p) return null
  const counts = { open: 0, fixed: 0, closed: 0 }
  for (const d of p.defects) counts[d.status]++
  const list = p.defects.filter((d) => show === 'all' || d.status !== 'closed')
  const setDefect = (id: string, patch: Partial<Defect>) =>
    change((x) => {
      const d = x.defects.find((y) => y.id === id)
      if (!d) return
      Object.assign(d, patch)
      const now = new Date().toISOString()
      if (patch.status === 'fixed') Object.assign(d, { fixedBy: user?.id, fixedAt: now })
      if (patch.status === 'closed') Object.assign(d, { closedBy: user?.id, closedAt: now })
      if (patch.status === 'open') Object.assign(d, { fixedBy: undefined, fixedAt: undefined, closedBy: undefined, closedAt: undefined })
    })
  const add = () => {
    change((x) => {
      x.defects.push({
        id: uid('df'),
        number: Math.max(0, ...x.defects.map((d) => d.number)) + 1,
        title: f.title.trim(),
        location: f.location.trim(),
        description: f.description.trim(),
        assigneeId: f.assigneeId || undefined,
        dueDate: f.dueDate || undefined,
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
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {(['open', 'fixed', 'closed'] as DefectStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 ${DEFECT_TONE[s]}`} /> <span className="num font-semibold">{counts[s]}</span> {DEFECT_STATUS_LABEL[s].toLowerCase()}
          </span>
        ))}
        <select className="input ml-auto w-auto py-1" aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
          <option value="outstanding">Outstanding</option>
          <option value="all">All, including closed</option>
        </select>
      </div>
      <fieldset className="grid gap-3 rounded-md border border-slate-200 p-4 sm:grid-cols-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Add a defect</legend>
        <Field label="What's wrong" className="sm:col-span-2"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Grout cracked at shower base" /></Field>
        <Field label="Where"><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Shower" /></Field>
        <Field label="Fix by"><input type="date" className="input num" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        <Field label="Details" className="sm:col-span-2"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Trade to fix it" className="sm:col-span-2">
          <select className="input" value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
            <option value="">Not assigned</option>
            {lk.providers.map((u) => <option key={u.id} value={u.id}>{u.name}{u.trade ? ` (${u.trade})` : ''}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-3">
          <span className="label">Photos</span>
          <PhotoInput value={f.photos} onChange={(photos) => setF({ ...f, photos })} max={8} />
        </div>
        <div className="flex items-end justify-end">
          <button type="button" className="btn-primary" disabled={!f.title.trim()} onClick={add}>Add defect</button>
        </div>
      </fieldset>
      {list.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-slate-500"><CheckCircle2 size={16} className="text-emerald-600" /> Nothing outstanding.</p>
      ) : (
        <ul className="space-y-3">
          {list.map((d) => {
            const overdue = d.status === 'open' && d.dueDate && d.dueDate < todayISO()
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
                      Raised by {lk.user(d.raisedBy ?? '')?.name ?? 'someone'} {fmtDateTime(d.raisedAt)}
                      {d.dueDate && <span className={overdue ? 'font-semibold text-red-600' : ''}> · fix by {fmtDate(d.dueDate)}</span>}
                    </p>
                  </div>
                  <span className={`px-1.5 py-0.5 text-[11px] font-semibold uppercase text-white ${DEFECT_TONE[d.status]}`}>{DEFECT_STATUS_LABEL[d.status]}</span>
                </div>
                <Photos urls={d.photos} label={`Defect ${d.number} photo`} />
                {(d.fixNotes || d.fixPhotos.length > 0 || d.fixedAt) && (
                  <div className="mt-2 rounded bg-slate-50 p-2">
                    <p className="text-xs text-slate-600">
                      Fixed by {lk.user(d.fixedBy ?? '')?.name ?? 'the trade'}
                      {d.fixedAt && ` ${fmtDateTime(d.fixedAt)}`}
                      {d.fixNotes && `: ${d.fixNotes}`}
                    </p>
                    <Photos urls={d.fixPhotos} label={`Defect ${d.number} fix photo`} />
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select className="input w-auto py-1 text-xs" aria-label="Trade to fix it" value={d.assigneeId ?? ''} disabled={d.status === 'closed'} onChange={(e) => setDefect(d.id, { assigneeId: e.target.value || undefined })}>
                    <option value="">Not assigned</option>
                    {lk.providers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                  {d.status === 'open' && <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setDefect(d.id, { status: 'fixed' })}>Mark fixed</button>}
                  {d.status !== 'closed' && <button type="button" className="btn-primary px-2.5 py-1 text-xs" onClick={() => setDefect(d.id, { status: 'closed' })}><CheckCircle2 size={13} /> Checked, close it</button>}
                  {d.status !== 'open' && <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setDefect(d.id, { status: 'open' })}><RotateCcw size={13} /> Reopen</button>}
                  {d.closedAt && <span className="text-xs text-slate-500">Closed by {lk.user(d.closedBy ?? '')?.name ?? 'the office'} {fmtDateTime(d.closedAt)}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Opens a project document in a new tab. The tab opens straight away (browsers block pop-ups opened
 * after a wait) and loads once the private link is ready.
 */
export function useOpenDocument(onError: (message: string) => void) {
  const { projectFileUrl } = useStore()
  return async (d: ProjectDocument) => {
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    try {
      let url = await projectFileUrl(d.path)
      // Browsers won't open data: links in a tab; a blob: link works.
      if (url.startsWith('data:')) url = URL.createObjectURL(await (await fetch(url)).blob())
      if (tab) tab.location.href = url
      else window.location.href = url
    } catch (e) {
      tab?.close()
      onError((e as Error).message)
    }
  }
}

export const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** Office: plans, permits, certificates and so on, each shared with the client, trades, both or nobody. */
export function DocumentsPanel({ projectId }: { projectId: string }) {
  const { data, uploadProjectFile, deleteProjectDocument } = useStore()
  const lk = useLookup()
  const change = useProjectUpdate(projectId)
  const p = data.projects.find((x) => x.id === projectId)
  const [category, setCategory] = useState<ProjectDocument['category']>('Plans')
  const [share, setShare] = useState<DocumentShare>('office')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = useOpenDocument(setError)
  if (!p) return null
  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    setError(null)
    try {
      for (const file of Array.from(files)) {
        const stored = await uploadProjectFile(projectId, file)
        change((x) => {
          x.documents.push({ id: uid('doc'), name: file.name, category, share, ...stored, uploadedAt: new Date().toISOString() })
        })
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const groups = DOCUMENT_CATEGORIES.map((c) => ({ c, docs: p.documents.filter((d) => d.category === c) })).filter((g) => g.docs.length)
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 p-4">
        <Field label="Type">
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as ProjectDocument['category'])}>
            {DOCUMENT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Who can see it">
          <select className="input" value={share} onChange={(e) => setShare(e.target.value as DocumentShare)}>
            {(Object.keys(DOCUMENT_SHARE_LABEL) as DocumentShare[]).map((s) => <option key={s} value={s}>{DOCUMENT_SHARE_LABEL[s]}</option>)}
          </select>
        </Field>
        <label className={`btn-primary cursor-pointer ${busy ? 'opacity-60' : ''}`}>
          <Plus size={15} /> {busy ? 'Uploading…' : 'Upload files'}
          <input type="file" multiple className="hidden" aria-label="Upload files" disabled={busy} onChange={(e) => void upload(e.target.files).then(() => (e.target.value = ''))} />
        </label>
        <p className="text-xs text-slate-500">Up to 25 MB each. Files are private: only people you share them with can open them.</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {groups.length === 0 ? (
        <p className="text-sm text-slate-500">No documents yet.</p>
      ) : (
        groups.map((g) => (
          <section key={g.c}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.c}</h3>
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
              {g.docs.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <FileText size={16} className="text-slate-400" aria-hidden="true" />
                  <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => void open(d)}>
                    {d.name}
                  </button>
                  <span className="num text-xs text-slate-500">{size(d.sizeBytes)} · {fmtDate(d.uploadedAt)}{d.uploadedBy ? ` · ${lk.user(d.uploadedBy)?.name ?? ''}` : ''}</span>
                  <select
                    className="input w-auto py-1 text-xs"
                    aria-label={`Who can see ${d.name}`}
                    value={d.share}
                    onChange={(e) =>
                      change((x) => {
                        const y = x.documents.find((z) => z.id === d.id)
                        if (y) y.share = e.target.value as DocumentShare
                      })
                    }
                  >
                    {(Object.keys(DOCUMENT_SHARE_LABEL) as DocumentShare[]).map((s) => <option key={s} value={s}>{DOCUMENT_SHARE_LABEL[s]}</option>)}
                  </select>
                  <button type="button" className="text-slate-500 hover:text-slate-900" aria-label={`Open ${d.name}`} onClick={() => void open(d)}>
                    <Download size={15} />
                  </button>
                  <button type="button" className="text-slate-500 hover:text-red-600" aria-label={`Delete ${d.name}`} onClick={() => deleteProjectDocument(projectId, d.id)}>
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}

/** A one-line fact for the workspace header. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="num font-semibold text-slate-900">{children}</dd>
    </div>
  )
}
