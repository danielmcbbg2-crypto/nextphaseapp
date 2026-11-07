import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { QuoteBreakdown } from '../../components/quote'
import { Field, Stat } from '../../components/ui'
import { useStore } from '../../lib/store'
import { approvedVariationsExGst, contractTotal, GST_RATE, itemsSubtotal, lineTotal, paymentAmounts, projectFinancials, quoteTotal, sections, withGst } from '../../lib/quote'
import { COST_CATEGORIES, QUOTE_ITEM_KIND_LABEL, type PaymentStage, type Project, type QuickBooksInvoice, type QuoteItem, type QuoteItemKind } from '../../lib/types'
import { fmtDate, money, todayISO, uid } from '../../lib/utils'
import { QuoteDrafter } from './QuoteDrafter'

type Panel = { p: Project; set: (patch: Partial<Project>) => void }

const num = (s: string) => (s === '' ? 0 : Number(s) || 0)

/** Once the client has accepted, the quote stays as agreed and changes go through variations. */
export const quoteLocked = (p: Project) => ['approved', 'in_progress', 'completed'].includes(p.status)

/** Admin: itemised quote by section, with terms. Rates exclude GST. */
export function QuoteBuilder({ p, set }: Panel) {
  if (quoteLocked(p)) {
    return (
      <div className="space-y-4">
        <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-600">The client accepted this quote, so it stays as agreed. Price any changes as variations.</p>
        {p.quoteItems.length === 0 && <p className="num text-sm">Quoted as a single amount: {money(p.quoteAmount ?? 0)} inc GST.</p>}
        <QuoteBreakdown p={p} />
      </div>
    )
  }
  const subtotal = itemsSubtotal(p.quoteItems)
  const setItem = (id: string, patch: Partial<QuoteItem>) => set({ quoteItems: p.quoteItems.map((i) => (i.id === id ? { ...i, ...patch } : i)) })
  const blank = (section: string): QuoteItem => ({ id: uid('qi'), section, description: '', kind: 'labour', qty: 1, unit: '', rate: 0 })
  // A line added to a section goes after that section's last line.
  const addTo = (section: string) => {
    const items = [...p.quoteItems]
    const at = items.map((i) => i.section.trim()).lastIndexOf(section)
    items.splice(at < 0 ? items.length : at + 1, 0, blank(section))
    set({ quoteItems: items })
  }
  const renameSection = (from: string, to: string) => set({ quoteItems: p.quoteItems.map((i) => (i.section.trim() === from ? { ...i, section: to } : i)) })

  return (
    <div className="space-y-4">
      <QuoteDrafter p={p} set={set} />
      <QuoteSources p={p} set={set} />
      {p.quoteItems.length === 0 && (
        <div className="space-y-3">
          <Field label="Quote amount (AUD, inc. GST)" className="max-w-xs">
            <input type="number" min="0" step="0.01" className="input num" value={p.quoteAmount ?? ''} onChange={(e) => set({ quoteAmount: e.target.value ? Number(e.target.value) : undefined })} />
          </Field>
          <p className="text-sm text-slate-600">
            Or itemise it: break the job into sections (stages or trades) and price each line. The client sees the breakdown with GST once you issue the
            quote.
          </p>
        </div>
      )}
      {sections(p.quoteItems).map((g) => {
        const name = g.items[0].section.trim()
        return (
          // Keyed by its first line, so renaming the section keeps the cursor in the box.
          <div key={g.items[0].id} className="overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th colSpan={7} className="px-2 py-1.5 text-left">
                    <input
                      className="input w-64 py-1 font-semibold"
                      aria-label="Section name"
                      placeholder="Section, e.g. Demolition"
                      value={g.items[0].section}
                      onChange={(e) => renameSection(name, e.target.value)}
                    />
                  </th>
                </tr>
                <tr className="text-left text-xs text-slate-500">
                  <th className="px-2 py-1 font-semibold">Description</th>
                  <th className="w-40 px-2 py-1 font-semibold">Type</th>
                  <th className="w-20 px-2 py-1 font-semibold">Qty</th>
                  <th className="w-20 px-2 py-1 font-semibold">Unit</th>
                  <th className="w-28 px-2 py-1 font-semibold">Rate ex GST</th>
                  <th className="w-28 px-2 py-1 text-right font-semibold">Amount</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {g.items.map((i) => (
                  <tr key={i.id}>
                    <td className="px-2 py-1">
                      <input className="input py-1" aria-label="Description" required value={i.description} onChange={(e) => setItem(i.id, { description: e.target.value })} />
                    </td>
                    <td className="px-2 py-1">
                      <select className="input py-1" aria-label="Type" value={i.kind} onChange={(e) => setItem(i.id, { kind: e.target.value as QuoteItemKind })}>
                        {(Object.keys(QUOTE_ITEM_KIND_LABEL) as QuoteItemKind[]).map((k) => <option key={k} value={k}>{QUOTE_ITEM_KIND_LABEL[k]}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <input className="input num py-1" aria-label="Qty" type="number" min="0" step="0.01" value={i.qty} onChange={(e) => setItem(i.id, { qty: num(e.target.value) })} />
                    </td>
                    <td className="px-2 py-1">
                      <input className="input py-1" aria-label="Unit" value={i.unit} onChange={(e) => setItem(i.id, { unit: e.target.value })} placeholder="m²" />
                    </td>
                    <td className="px-2 py-1">
                      <input className="input num py-1" aria-label="Rate" type="number" min="0" step="0.01" value={i.rate} onChange={(e) => setItem(i.id, { rate: num(e.target.value) })} />
                    </td>
                    <td className="num px-2 py-1 text-right">{money(lineTotal(i))}</td>
                    <td className="px-2 py-1 text-right">
                      <button type="button" className="text-slate-500 hover:text-red-600" onClick={() => set({ quoteItems: p.quoteItems.filter((x) => x.id !== i.id) })} aria-label={`Remove ${i.description || 'line'}`}>
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-100">
                <tr>
                  <td colSpan={5} className="px-2 py-1.5">
                    <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => addTo(name)}>
                      <Plus size={14} /> Line in {g.name}
                    </button>
                  </td>
                  <td className="num px-2 py-1.5 text-right text-slate-600">{money(g.subtotal)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )
      })}
      <button type="button" className="btn-ghost" onClick={() => set({ quoteItems: [...p.quoteItems, blank(p.quoteItems.length ? `Section ${sections(p.quoteItems).length + 1}` : '')] })}>
        <Plus size={15} /> {p.quoteItems.length ? 'Add a section' : 'Start an itemised quote'}
      </button>
      {p.quoteItems.length > 0 && (
        <dl className="ml-auto max-w-xs space-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-slate-600">Subtotal (ex GST)</dt><dd className="num">{money(subtotal)}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-600">GST {Math.round(GST_RATE * 100)}%</dt><dd className="num">{money(withGst(subtotal) - subtotal)}</dd></div>
          <div className="flex justify-between border-t border-slate-200 pt-1 font-bold"><dt>Quote total</dt><dd className="num">{money(quoteTotal(p))}</dd></div>
        </dl>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Included">
          <textarea className="input min-h-[80px]" value={p.quoteInclusions} onChange={(e) => set({ quoteInclusions: e.target.value })} placeholder="e.g. All labour and materials listed, site clean-up, waste removal" />
        </Field>
        <Field label="Not included">
          <textarea className="input min-h-[80px]" value={p.quoteExclusions} onChange={(e) => set({ quoteExclusions: e.target.value })} placeholder="e.g. Appliances, structural changes, council permits" />
        </Field>
        <Field label="Quote valid until">
          <input type="date" className="input num" value={p.quoteValidUntil ?? ''} onChange={(e) => set({ quoteValidUntil: e.target.value || undefined })} />
        </Field>
      </div>
    </div>
  )
}

/** Start from a template or another quote (its lines are added, with fresh copies), or save this one as a template. */
function QuoteSources({ p, set }: Panel) {
  const { data, update } = useStore()
  const [naming, setNaming] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const past = data.projects.filter((x) => x.id !== p.id && x.quoteItems.length > 0).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const copyFrom = (key: string) => {
    const [kind, id] = key.split(':')
    const src =
      kind === 't'
        ? data.quoteTemplates.find((t) => t.id === id)
        : (() => {
            const q = data.projects.find((x) => x.id === id)
            return q && { items: q.quoteItems, inclusions: q.quoteInclusions, exclusions: q.quoteExclusions }
          })()
    if (!src) return
    set({
      quoteItems: [...p.quoteItems, ...src.items.map((i) => ({ section: i.section, description: i.description, kind: i.kind, qty: i.qty, unit: i.unit, rate: i.rate, id: uid('qi') }))],
      quoteInclusions: p.quoteInclusions || src.inclusions,
      quoteExclusions: p.quoteExclusions || src.exclusions,
    })
  }
  const saveTemplate = (name: string) => {
    update((d) => {
      d.quoteTemplates.push({
        id: uid('qt'),
        name,
        items: p.quoteItems.map(({ section, description, kind, qty, unit, rate }) => ({ section, description, kind, qty, unit, rate })),
        inclusions: p.quoteInclusions,
        exclusions: p.quoteExclusions,
        createdAt: new Date().toISOString(),
      })
      d.quoteTemplates.sort((a, b) => a.name.localeCompare(b.name))
    })
    setNaming(null)
    setSaved(true)
  }
  if (!data.quoteTemplates.length && !past.length && !p.quoteItems.length) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 p-3 text-sm">
      {(data.quoteTemplates.length > 0 || past.length > 0) && (
        <select className="input w-auto max-w-full py-1" aria-label="Add lines from a template or past quote" value="" onChange={(e) => e.target.value && copyFrom(e.target.value)}>
          <option value="">{p.quoteItems.length ? 'Add lines from…' : 'Start from a template or past quote…'}</option>
          {data.quoteTemplates.length > 0 && (
            <optgroup label="Templates">
              {data.quoteTemplates.map((t) => <option key={t.id} value={`t:${t.id}`}>{t.name} ({t.items.length} lines)</option>)}
            </optgroup>
          )}
          {past.length > 0 && (
            <optgroup label="Past quotes">
              {past.slice(0, 30).map((x) => <option key={x.id} value={`p:${x.id}`}>P-{x.number} {x.title} ({money(quoteTotal(x))})</option>)}
            </optgroup>
          )}
        </select>
      )}
      {p.quoteItems.length > 0 &&
        (naming === null ? (
          <button type="button" className="btn-ghost ml-auto px-3 py-1" onClick={() => { setNaming(p.title); setSaved(false) }}>
            {saved ? 'Saved as a template ✓' : 'Save as template'}
          </button>
        ) : (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <input className="input w-56 py-1" aria-label="Template name" autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} />
            <button type="button" className="btn-primary px-3 py-1" disabled={!naming.trim()} onClick={() => saveTemplate(naming.trim())}>Save</button>
            <button type="button" className="btn-ghost px-3 py-1" onClick={() => setNaming(null)}>Cancel</button>
          </span>
        ))}
    </div>
  )
}

/** Admin: price changes after the quote; the client approves or declines them (or the office records their answer). */
export function VariationsPanel({ p, set, original }: Panel & { original: Project }) {
  const [f, setF] = useState({ title: '', description: '', amount: '' })
  const saved = new Set(original.variations.map((v) => v.id))
  const pending = p.variations.filter((v) => v.status === 'proposed')
  const setStatus = (id: string, status: 'approved' | 'rejected') => set({ variations: p.variations.map((v) => (v.id === id ? { ...v, status, decidedAt: new Date().toISOString() } : v)) })

  return (
    <div className="space-y-4">
      <div className="grid divide-y divide-slate-100 rounded-md border border-slate-200 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat label="Original quote" value={money(quoteTotal(p))} hint="inc GST" />
        <Stat label="Approved variations" value={money(withGst(approvedVariationsExGst(p)))} hint={`${p.variations.filter((v) => v.status === 'approved').length} approved · inc GST`} />
        <Stat label="Contract total" value={money(contractTotal(p))} hint={pending.length ? `${pending.length} awaiting the client` : 'inc GST'} />
      </div>
      {p.variations.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
          {p.variations.map((v) => (
            <li key={v.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-medium"><span className="num text-slate-500">V{v.number}</span> · {v.title}</p>
                {v.description && <p className="whitespace-pre-wrap text-slate-600">{v.description}</p>}
                <p className="text-xs text-slate-500">
                  {v.status === 'proposed' ? (saved.has(v.id) ? 'Awaiting the client' : 'New: the client is told when you save') : v.status === 'approved' ? 'Approved' : 'Declined'}
                  {v.decidedAt ? ` · ${fmtDate(v.decidedAt)}` : ''}
                </p>
              </div>
              <div className="text-right">
                <p className={`num font-semibold ${v.status === 'rejected' ? 'text-slate-400 line-through' : ''}`}>{v.amount < 0 ? '−' : ''}{money(Math.abs(v.amount))}</p>
                <p className="num text-xs text-slate-500">{money(withGst(v.amount))} inc GST</p>
                {v.status === 'proposed' && (
                  <div className="mt-1 flex justify-end gap-1">
                    {saved.has(v.id) && (
                      <>
                        <button type="button" className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setStatus(v.id, 'approved')} title="Record that the client approved it">Client approved</button>
                        <button type="button" className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setStatus(v.id, 'rejected')} title="Record that the client declined it">Declined</button>
                      </>
                    )}
                    <button type="button" className="text-slate-500 hover:text-red-600" onClick={() => set({ variations: p.variations.filter((x) => x.id !== v.id) })} aria-label={`Withdraw V${v.number}`}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <fieldset className="grid gap-3 rounded-md border border-slate-200 p-4 sm:grid-cols-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">New variation</legend>
        <Field label="Title" className="sm:col-span-3">
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Upgrade to frameless shower screen" />
        </Field>
        <Field label="Amount ex GST">
          <input className="input num" type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="Negative for a credit" />
        </Field>
        <Field label="Details for the client" className="sm:col-span-4">
          <textarea className="input min-h-[60px]" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div className="sm:col-span-4">
          <button
            type="button"
            className="btn-ghost"
            disabled={!f.title.trim() || !num(f.amount)}
            onClick={() => {
              const number = Math.max(0, ...p.variations.map((v) => v.number)) + 1
              set({
                variations: [
                  ...p.variations,
                  { id: uid('v'), number, title: f.title.trim(), description: f.description.trim(), amount: Math.round(num(f.amount) * 100) / 100, status: 'proposed', createdAt: new Date().toISOString() },
                ],
              })
              setF({ title: '', description: '', amount: '' })
            }}
          >
            <Plus size={15} /> Add variation
          </button>
        </div>
      </fieldset>
    </div>
  )
}

const STANDARD_SCHEDULE: Omit<PaymentStage, 'id'>[] = [
  { title: 'Deposit', basis: 'percent', value: 10 },
  { title: 'Progress claim', basis: 'percent', value: 40 },
  { title: 'Practical completion', basis: 'balance', value: 0 },
]

/** Admin: deposit, progress claims and balance; each is claimed by raising a draft invoice. */
export function PaymentsPanel({ p, set, invoices, dirty, canInvoice, onClaim }: Panel & {
  invoices: QuickBooksInvoice[]
  dirty: boolean
  canInvoice: boolean
  onClaim: (stage: PaymentStage, amount: number) => void
}) {
  const amounts = paymentAmounts(p, invoices)
  const setStage = (id: string, patch: Partial<PaymentStage>) => set({ payments: p.payments.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const percent = p.payments.filter((s) => s.basis === 'percent').reduce((t, s) => t + s.value, 0)
  const scheduled = [...amounts.values()].reduce((a, b) => a + b, 0)
  const contract = contractTotal(p)
  const gap = Math.round((contract - scheduled) * 100) / 100

  return (
    <div className="space-y-4">
      {p.payments.length === 0 ? (
        <div className="space-y-2 text-sm text-slate-600">
          <p>Set out when the client pays: a deposit, claims at milestones, and the balance at completion. Each one is raised as an invoice when it's due.</p>
          <button type="button" className="btn-ghost" onClick={() => set({ payments: STANDARD_SCHEDULE.map((s) => ({ ...s, id: uid('ps') })) })}>
            Start with 10% deposit, 40% progress, balance at completion
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {p.payments.map((s, idx) => {
            const inv = s.invoiceId ? invoices.find((i) => i.id === s.invoiceId) : undefined
            const claimed = !!s.invoiceId
            const milestone = p.milestones.find((m) => m.id === s.milestoneId)
            return (
              <li key={s.id} className="grid grid-cols-2 items-end gap-2 px-3 py-2.5 sm:grid-cols-12">
                <Field label="Stage" className="col-span-2 sm:col-span-3">
                  <input className="input py-1" required value={s.title} onChange={(e) => setStage(s.id, { title: e.target.value })} />
                </Field>
                <Field label="Basis" className="sm:col-span-2">
                  <select className="input py-1" disabled={claimed} value={s.basis} onChange={(e) => setStage(s.id, { basis: e.target.value as PaymentStage['basis'] })}>
                    <option value="percent">% of quote</option>
                    <option value="amount">Fixed $</option>
                    <option value="balance">Balance</option>
                  </select>
                </Field>
                <Field label={s.basis === 'percent' ? '%' : '$ inc GST'} className="sm:col-span-1">
                  <input className="input num py-1" type="number" min="0" step="0.01" disabled={claimed || s.basis === 'balance'} value={s.basis === 'balance' ? '' : s.value} onChange={(e) => setStage(s.id, { value: num(e.target.value) })} />
                </Field>
                <Field label="Due at milestone" className="col-span-2 sm:col-span-3">
                  <select className="input py-1" value={s.milestoneId ?? ''} onChange={(e) => setStage(s.id, { milestoneId: e.target.value || undefined })}>
                    <option value="">{idx === 0 ? 'On acceptance' : 'No milestone'}</option>
                    {p.milestones.map((m) => <option key={m.id} value={m.id}>{m.title}{m.done ? ' ✓' : ''}</option>)}
                  </select>
                </Field>
                <div className="col-span-2 flex items-center justify-end gap-2 pb-1 text-sm sm:col-span-3">
                  <span className="num font-semibold">{money(amounts.get(s.id) ?? 0)}</span>
                  {inv ? (
                    <span className="text-xs text-slate-500">{inv.qbInvoiceNumber} · {inv.status === 'paid' ? 'paid' : inv.status}</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={milestone?.done || (!milestone && idx === 0 && quoteLocked(p)) ? 'btn-primary px-2.5 py-1 text-xs' : 'btn-ghost px-2.5 py-1 text-xs'}
                        disabled={!canInvoice || dirty || !((amounts.get(s.id) ?? 0) > 0)}
                        title={!canInvoice ? 'Needs “Manage invoices”' : dirty ? 'Save your changes first' : 'Raise a draft invoice for this stage'}
                        onClick={() => onClaim(s, amounts.get(s.id) ?? 0)}
                      >
                        Raise claim
                      </button>
                      <button type="button" className="text-slate-500 hover:text-red-600" onClick={() => set({ payments: p.payments.filter((x) => x.id !== s.id) })} aria-label={`Remove ${s.title}`}>
                        <Trash2 size={15} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
          <li className="px-3 py-2">
            <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => set({ payments: [...p.payments, { id: uid('ps'), title: 'Progress claim', basis: 'percent', value: 0 }] })}>
              <Plus size={14} /> Add stage
            </button>
          </li>
        </ul>
      )}
      {p.payments.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="flex justify-between"><span className="text-slate-600">Scheduled</span><span className="num">{money(scheduled)}</span></p>
          <p className="flex justify-between"><span className="text-slate-600">Contract total (quote and approved variations, inc GST)</span><span className="num font-semibold">{money(contract)}</span></p>
          {percent > 100 && <p className="text-red-600">The percentages add up to more than 100%.</p>}
          {Math.abs(gap) >= 0.01 && (
            <p className="text-amber-700">
              {gap > 0 ? `${money(gap)} of the contract isn't scheduled yet: add a balance stage to cover it.` : `The stages come to ${money(-gap)} more than the contract.`}
            </p>
          )}
        </div>
      )}
      {dirty && p.payments.some((s) => !s.invoiceId) && <p className="text-xs text-slate-500">Save the project before raising a claim.</p>}
    </div>
  )
}

/** Admin: budget against actual and margin, with costs logged against the project. */
export function CostsPanel({ p, set, invoices }: Panel & { invoices: QuickBooksInvoice[] }) {
  const [f, setF] = useState({ date: todayISO(), description: '', category: 'Materials', supplier: '', amount: '' })
  const fin = projectFinancials(p, invoices)
  const byCategory = [
    ...(fin.expenses > 0 ? [{ name: 'Trade expenses', amount: fin.expenses }] : []),
    ...COST_CATEGORIES.map((c) => ({ name: c as string, amount: p.costs.filter((x) => x.category === c).reduce((s, x) => s + x.amount, 0) })).filter((x) => x.amount > 0),
  ]
  const usedPct = fin.contract > 0 ? Math.min(100, Math.round((fin.costs / fin.contract) * 100)) : 0

  return (
    <div className="space-y-4">
      <div className="grid divide-y divide-slate-100 rounded-md border border-slate-200 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <Stat label="Contract" value={money(fin.contract)} hint="ex GST, with approved variations" />
        <Stat label="Costs to date" value={money(fin.costs)} hint={fin.pendingExpenses ? `+ ${money(fin.pendingExpenses)} awaiting approval` : 'ex GST'} />
        <Stat label="Margin" value={<span className={fin.margin < 0 ? 'text-red-600' : ''}>{money(fin.margin)}</span>} hint={`${fin.marginPct}% of contract`} />
        <Stat label="Claimed" value={money(fin.invoiced)} hint={`${money(fin.paid)} paid · inc GST`} />
      </div>
      {fin.contract > 0 && (
        <div className="text-sm">
          <div className="flex justify-between text-slate-600">
            <span>Costs against the contract</span>
            <span className={fin.margin < 0 ? 'font-semibold text-red-600' : ''}>
              {fin.margin < 0 ? `${money(-fin.margin)} over` : `${usedPct}% used · ${money(fin.margin)} left`}
            </span>
          </div>
          <div className="mt-1 h-2 bg-slate-100" role="img" aria-label={`Costs are ${usedPct}% of the contract`}>
            <div className={`h-2 ${fin.margin < 0 ? 'bg-red-500' : 'bg-accent'}`} style={{ width: `${usedPct}%` }} />
          </div>
          {p.budget > 0 && <p className="mt-1 text-xs text-slate-500">The client's indicative budget was {money(p.budget)}.</p>}
        </div>
      )}
      {byCategory.length > 0 && (
        <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {byCategory.map((c) => (
            <li key={c.name} className="flex justify-between border-b border-slate-100 py-1">
              <span className="text-slate-600">{c.name}</span>
              <span className="num">{money(c.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      {p.costs.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Cost</th>
                <th className="px-3 py-2 font-semibold">Supplier</th>
                <th className="px-3 py-2 text-right font-semibold">Ex GST</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...p.costs].sort((a, b) => b.date.localeCompare(a.date)).map((c) => (
                <tr key={c.id}>
                  <td className="num whitespace-nowrap px-3 py-1.5">{fmtDate(c.date)}</td>
                  <td className="px-3 py-1.5">{c.description}<span className="ml-1.5 text-xs text-slate-400">{c.category}</span></td>
                  <td className="px-3 py-1.5 text-slate-600">{c.supplier || '—'}</td>
                  <td className="num px-3 py-1.5 text-right">{money(c.amount)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button type="button" className="text-slate-500 hover:text-red-600" onClick={() => set({ costs: p.costs.filter((x) => x.id !== c.id) })} aria-label={`Remove ${c.description}`}>
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <fieldset className="grid gap-3 rounded-md border border-slate-200 p-4 sm:grid-cols-6">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Log a cost</legend>
        <Field label="Date" className="sm:col-span-2"><input type="date" className="input num" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Category" className="sm:col-span-2">
          <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {COST_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Amount ex GST" className="sm:col-span-2"><input type="number" min="0" step="0.01" className="input num" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="What" className="sm:col-span-4"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Tiles and adhesive" /></Field>
        <Field label="Supplier" className="sm:col-span-2"><input className="input" value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></Field>
        <div className="sm:col-span-6">
          <button
            type="button"
            className="btn-ghost"
            disabled={!f.description.trim() || !(num(f.amount) > 0) || !f.date}
            onClick={() => {
              set({ costs: [...p.costs, { id: uid('c'), date: f.date, description: f.description.trim(), category: f.category, supplier: f.supplier.trim(), amount: Math.round(num(f.amount) * 100) / 100 }] })
              setF({ ...f, description: '', supplier: '', amount: '' })
            }}
          >
            <Plus size={15} /> Add cost
          </button>
        </div>
      </fieldset>
      <p className="text-xs text-slate-500">Approved trade expenses count as costs automatically. Only the office sees this tab.</p>
    </div>
  )
}
