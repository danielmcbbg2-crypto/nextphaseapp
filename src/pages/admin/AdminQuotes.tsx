import { useState } from 'react'
import { AlarmClock, Mail, Plus, Trash2 } from 'lucide-react'
import { Empty, PageHeader, Stat, Tabs } from '../../components/ui'
import { TextButton } from '../../components/TextMessage'
import { useLookup, useStore } from '../../lib/store'
import { daysSince, daysToExpiry, FOLLOW_UP_DAYS, itemsSubtotal, needsFollowUp, quoteStage, quoteStats, quoteTotal, withGst, type QuoteStage } from '../../lib/quote'
import type { Project, QuoteItem } from '../../lib/types'
import { fmtDate, money } from '../../lib/utils'
import { NewProjectForm, ProjectEditor, useSaveProject } from './AdminProjects'
import { takeOpenOnArrival } from '../../lib/openOnArrival'

const COLUMNS: { stage: QuoteStage[]; title: string; hint: string }[] = [
  { stage: ['requested'], title: 'Requested', hint: 'Not priced yet' },
  { stage: ['pricing'], title: 'Being priced', hint: 'Not sent yet' },
  { stage: ['issued'], title: 'Issued', hint: 'Waiting on the client' },
  { stage: ['won', 'lost'], title: 'Answered', hint: 'Last 30 days' },
]

const ago = (days: number) => (days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`)

/** Admin → Quotes: every quote from request to answer, what needs chasing, and how they're converting. */
export function AdminQuotes() {
  const { data } = useStore()
  const save = useSaveProject()
  const [tab, setTab] = useState<'board' | 'templates'>('board')
  // Opened from its store order: straight into that quote.
  const [editing, setEditing] = useState<Project | null>(() => {
    const id = takeOpenOnArrival('quote')
    return (id && data.projects.find((p) => p.id === id)) || null
  })
  const [creating, setCreating] = useState(false)
  const now = Date.now()

  const stats = quoteStats(data.projects, 90, now)
  const inPlay = data.projects.filter((p) => {
    const stage = quoteStage(p)
    if (!stage) return false
    if (stage === 'won' || stage === 'lost') return !!p.quoteDecidedAt && daysSince(p.quoteDecidedAt, now) <= 30
    return true
  })
  const chase = data.projects.filter((p) => needsFollowUp(p, now))
  // Close to (or past) its expiry date, and not chased in the last few days.
  const expiring = data.projects.filter((p) => {
    const d = daysToExpiry(p, now)
    return d !== undefined && d <= 7 && (!p.quoteFollowedUpAt || daysSince(p.quoteFollowedUpAt, now) >= FOLLOW_UP_DAYS)
  })

  return (
    <>
      <PageHeader
        title="Quotes"
        subtitle="From request to yes: what to price, what to chase, and how you're converting."
        actions={<button className="btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New quote</button>}
      />
      <div className="card mb-6 grid divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
        <Stat label="Open quotes" value={money(stats.openValue)} hint={`${stats.openCount} waiting on clients · inc GST`} />
        <Stat label="Won (90 days)" value={money(stats.wonValue)} hint={`${stats.wonCount} accepted`} />
        <Stat label="Win rate (90 days)" value={stats.winRate === undefined ? '—' : `${stats.winRate}%`} hint={`${stats.wonCount} of ${stats.wonCount + stats.lostCount} answered`} />
        <Stat label="Average quote" value={stats.averageQuote === undefined ? '—' : money(stats.averageQuote)} hint={`${stats.issuedCount} issued in 90 days`} />
      </div>
      <p className="-mt-3 mb-6 text-sm text-slate-600">
        {data.smsSettings.quoteFollowUps
          ? `Automatic follow-up texts are on: clients get a text with their quote's link ${data.smsSettings.quoteFollowUpDays.join(' and ')} days after it's issued, while it's unanswered.`
          : 'Automatic follow-up texts are off.'}{' '}
        <a className="underline" href="#/admin/sms">{data.smsSettings.quoteFollowUps ? 'Change' : 'Switch them on'}</a>
      </p>

      {(chase.length > 0 || expiring.length > 0) && (
        <section className="card mb-6 overflow-hidden" aria-labelledby="chase-title">
          <h2 id="chase-title" className="flex items-center gap-2 border-b border-slate-200 px-5 py-3 font-bold">
            <AlarmClock size={18} className="text-accent" aria-hidden="true" /> Needs a follow-up
          </h2>
          <ul className="divide-y divide-slate-100">
            {[...new Set([...chase, ...expiring])].map((p) => (
              <FollowUpRow key={p.id} p={p} now={now} onOpen={() => setEditing(p)} />
            ))}
          </ul>
        </section>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'board', label: 'Pipeline', count: inPlay.filter((p) => quoteStage(p) !== 'won' && quoteStage(p) !== 'lost').length },
          { value: 'templates', label: 'Templates', count: data.quoteTemplates.length },
        ]}
      />
      {tab === 'board' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((c) => {
            const cards = inPlay
              .filter((p) => c.stage.includes(quoteStage(p)!))
              .sort((a, b) => (b.quoteDecidedAt ?? b.quoteIssuedAt ?? b.createdAt).localeCompare(a.quoteDecidedAt ?? a.quoteIssuedAt ?? a.createdAt))
            const total = cards.reduce((s, p) => s + quoteTotal(p), 0)
            return (
              <section key={c.title} className="flex flex-col rounded-md bg-slate-100/70 p-3" aria-label={c.title}>
                <header className="mb-3 flex items-baseline justify-between px-1">
                  <h2 className="font-bold">
                    {c.title} <span className="num text-sm font-normal text-slate-500">{cards.length}</span>
                  </h2>
                  <span className="num text-xs text-slate-500">{total ? money(total) : c.hint}</span>
                </header>
                <div className="space-y-2">
                  {cards.length === 0 && <p className="px-1 py-4 text-center text-xs text-slate-400">Nothing here</p>}
                  {cards.map((p) => (
                    <QuoteCard key={p.id} p={p} now={now} onOpen={() => setEditing(p)} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <Templates />
      )}

      {editing && (
        <ProjectEditor
          key={editing.id}
          project={editing}
          initialTab="quote"
          onClose={() => setEditing(null)}
          onSave={(p, base) => {
            save(p, base)
            setEditing(null)
          }}
        />
      )}
      {creating && <NewProjectForm quote onClose={() => setCreating(false)} onCreated={() => setCreating(false)} />}
    </>
  )
}

function QuoteCard({ p, now, onOpen }: { p: Project; now: number; onOpen: () => void }) {
  const lk = useLookup()
  const stage = quoteStage(p)
  const expiry = daysToExpiry(p, now)
  const value = quoteTotal(p)
  return (
    <button type="button" onClick={onOpen} className="block w-full rounded-md border border-slate-200 bg-white p-3 text-left shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="num">P-{p.number}</span>
        <span>
          {stage === 'issued' ? `Sent ${ago(daysSince(p.quoteIssuedAt, now))}` : stage === 'won' || stage === 'lost' ? ago(daysSince(p.quoteDecidedAt, now)) : `Asked ${ago(daysSince(p.createdAt, now))}`}
        </span>
      </div>
      <p className="mt-1 font-semibold leading-snug">{p.title}</p>
      <p className="text-xs text-slate-500">{lk.user(p.clientId)?.name}</p>
      {p.orderId && <p className="mt-1 text-xs font-semibold text-accent-ink">Install for a store order</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="num text-sm font-semibold">{value ? money(value) : 'Not priced'}</span>
        {stage === 'won' && <span className="bg-emerald-600 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-white">Won</span>}
        {stage === 'lost' && <span className="bg-slate-500 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-white">Declined</span>}
        {needsFollowUp(p, now) && <span className="bg-amber-500 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-white">Follow up</span>}
        {expiry !== undefined && expiry <= 7 && (
          <span className="bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-white">{expiry < 0 ? 'Expired' : expiry === 0 ? 'Expires today' : `Expires in ${expiry}d`}</span>
        )}
      </div>
    </button>
  )
}

/** A quote to chase: why, and one tap to text or email the client (which records the follow-up). */
function FollowUpRow({ p, now, onOpen }: { p: Project; now: number; onOpen: () => void }) {
  const { update } = useStore()
  const lk = useLookup()
  const client = lk.user(p.clientId)
  const first = client?.name.split(' ')[0] ?? 'there'
  const expiry = daysToExpiry(p, now)
  const issued = p.quoteIssuedAt ? fmtDate(p.quoteIssuedAt) : 'recently'
  const message = `Hi ${first}, it's Next Phase Maintenance. Just checking in on the quote for ${p.title} we sent on ${issued}${
    expiry !== undefined && expiry >= 0 && expiry <= 7 ? ` (it's valid until ${fmtDate(p.quoteValidUntil)})` : ''
  }. Happy to answer any questions or adjust anything. You can accept it in your portal.`
  const markFollowedUp = () =>
    update((d) => {
      const x = d.projects.find((y) => y.id === p.id)
      if (x) x.quoteFollowedUpAt = new Date().toISOString()
    })
  const reasons = [
    needsFollowUp(p, now) && `sent ${ago(daysSince(p.quoteIssuedAt, now))}${p.quoteFollowedUpAt ? `, last followed up ${ago(daysSince(p.quoteFollowedUpAt, now))}` : ', no answer yet'}`,
    expiry !== undefined && expiry <= 7 && (expiry < 0 ? 'quote has expired' : `expires ${expiry === 0 ? 'today' : `in ${expiry} day${expiry === 1 ? '' : 's'}`}`),
  ].filter(Boolean)
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
      <button type="button" className="min-w-0 text-left" onClick={onOpen}>
        <span className="num text-xs text-slate-500">P-{p.number}</span> <span className="font-semibold">{p.title}</span>
        <span className="text-slate-500"> · {client?.name} · {money(quoteTotal(p))}</span>
        <span className="block text-xs text-amber-700">{reasons.join(' · ')}</span>
      </button>
      <span className="flex flex-wrap gap-2">
        {client?.phone && (
          <TextButton phone={client.phone} message={message} event={`Quote follow-up P-${p.number}`} label="Text" className="btn-ghost px-3 py-1" onOpen={markFollowedUp} />
        )}
        {client?.email && (
          <a
            className="btn-ghost px-3 py-1"
            href={`mailto:${client.email}?subject=${encodeURIComponent(`Your quote: ${p.title}`)}&body=${encodeURIComponent(message)}`}
            onClick={markFollowedUp}
          >
            <Mail size={15} aria-hidden="true" /> Email
          </a>
        )}
        <button type="button" className="btn-ghost px-3 py-1" onClick={markFollowedUp} title={`Hide it for ${FOLLOW_UP_DAYS} days`}>
          Done
        </button>
      </span>
    </li>
  )
}

/** Saved standard quotes; new ones are saved from a quote's Quote tab. */
function Templates() {
  const { data, update } = useStore()
  if (data.quoteTemplates.length === 0) {
    return <Empty title="No templates yet">Open a quote, price it, and choose “Save as template” on its Quote tab.</Empty>
  }
  const set = (id: string, name: string) =>
    update((d) => {
      const t = d.quoteTemplates.find((x) => x.id === id)
      if (t) t.name = name
    })
  return (
    <ul className="card divide-y divide-slate-100">
      {data.quoteTemplates.map((t) => {
        const subtotal = itemsSubtotal(t.items.map((i, n) => ({ ...i, id: String(n) }) as QuoteItem))
        return (
          <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <input className="input max-w-xs py-1 font-semibold" aria-label="Template name" defaultValue={t.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.name && set(t.id, e.target.value.trim())} />
            <span className="text-slate-500">{t.items.length} lines · {[...new Set(t.items.map((i) => i.section || 'General'))].join(', ')}</span>
            <span className="num ml-auto font-semibold">{money(withGst(subtotal))}</span>
            <button
              type="button"
              className="text-slate-500 hover:text-red-600"
              aria-label={`Delete ${t.name}`}
              onClick={() =>
                update((d) => {
                  d.quoteTemplates = d.quoteTemplates.filter((x) => x.id !== t.id)
                })
              }
            >
              <Trash2 size={15} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
