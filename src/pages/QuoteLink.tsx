import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Logo } from '../components/Logo'
import { Field } from '../components/ui'
import { PaymentSafety } from '../components/PaymentSafety'
import { useStore } from '../lib/store'
import type { QuoteLinkView } from '../lib/types'
import { fmtDate, melbourneToday, money } from '../lib/utils'
import { BRAND } from '../lib/brand'

const cents = (n: number) => Math.round(n * 100) / 100

/**
 * The quote a client opens from their private link (no sign-in: the link is the key). They read the
 * itemised quote and accept it with their name, or decline. Accepting sends the deposit invoice from
 * QuickBooks straight away, and its pay link appears here.
 */
export function QuoteLink({ token }: { token: string }) {
  const { quoteByToken, answerQuoteByToken, cloud } = useStore()
  const [q, setQ] = useState<QuoteLinkView | null | undefined>(undefined)
  const [name, setName] = useState('')
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [declining, setDeclining] = useState(false)

  useEffect(() => {
    let live = true
    quoteByToken(token)
      .then((r) => live && setQ(r))
      .catch(() => live && setQ(null))
    return () => {
      live = false
    }
  }, [quoteByToken, token])

  // Just accepted: the deposit invoice is made within moments; wait a little for its pay link.
  // Keyed on the statuses, not the quote itself: each poll replaces the quote, which would otherwise
  // restart the timer (and its try count) every time, so it never stopped.
  const waitingForDeposit = !!q && q.status === 'approved' && ['pending', 'working'].includes(q.deposit.status)
  useEffect(() => {
    if (!waitingForDeposit) return
    let live = true
    let tries = 0
    const t = setInterval(async () => {
      tries++
      const r = await quoteByToken(token).catch(() => null)
      if (!live) return
      if (r) setQ(r)
      if (tries >= 15 || (r && !['pending', 'working'].includes(r.deposit.status))) clearInterval(t)
    }, 3000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [waitingForDeposit, quoteByToken, token])

  const answer = async (accept: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setQ(await answerQuoteByToken(token, accept, name))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const accept = (e: FormEvent) => {
    e.preventDefault()
    if (!agree) return setError('Tick the box to say you accept the quote and its terms.')
    void answer(true)
  }

  if (q === undefined) return <Shell><p className="text-sm text-slate-500">Loading your quote…</p></Shell>
  if (q === null) {
    return (
      <Shell>
        <h1 className="text-xl font-bold">This quote link isn’t valid</h1>
        <p className="mt-2 text-sm text-slate-600">
          {cloud ? 'It may have been mistyped, or the quote was replaced. Contact us and we’ll send you a new link.' : 'Quote links work on the live portal.'}
        </p>
      </Shell>
    )
  }

  const groups: { name: string; items: QuoteLinkView['items'] }[] = []
  for (const i of q.items) {
    const name = i.section.trim() || 'General'
    let g = groups.find((x) => x.name === name)
    if (!g) groups.push((g = { name, items: [] }))
    g.items.push(i)
  }
  const exGst = cents(q.items.reduce((s, i) => s + cents(i.qty * i.rate), 0))
  const expired = !!q.validUntil && q.status === 'quoted' && q.validUntil < melbourneToday()
  const d = q.deposit

  return (
    <Shell>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Quote P-{q.number}</p>
      <h1 className="mt-1 text-2xl font-bold">{q.title}</h1>
      <p className="mt-1 text-sm text-slate-600">
        For {q.client}
        {q.address ? ` · ${q.address}` : ''}
        {q.issuedAt ? ` · issued ${fmtDate(q.issuedAt)}` : ''}
        {q.validUntil ? ` · valid until ${fmtDate(q.validUntil)}` : ''}
      </p>

      {q.status === 'approved' && (
        <div className="mt-5 rounded-md border border-emerald-200 bg-emerald-50 p-4" role="status">
          <p className="flex items-center gap-2 font-semibold text-emerald-900">
            <CheckCircle2 size={18} /> Accepted{q.answeredName ? ` by ${q.answeredName}` : ''}{q.answeredAt ? ` on ${fmtDate(q.answeredAt)}` : ''}. Thank you!
          </p>
          {(d.status === 'sent' || d.status === 'paid') && d.amount ? (
            <div className="mt-2 text-sm text-emerald-900">
              {d.status === 'paid' ? (
                <p>Your deposit of <span className="num font-semibold">{money(d.amount)}</span> has been paid. We’ll be in touch to book the work in.</p>
              ) : (
                <>
                  <p>
                    Deposit invoice{d.number ? ` #${d.number}` : ''} for <span className="num font-semibold">{money(d.amount)}</span> inc. GST has been emailed to you. Paying it secures your booking.
                  </p>
                  {d.payLink && (
                    <a className="btn-primary mt-3 inline-flex" href={d.payLink} target="_blank" rel="noreferrer">
                      Pay deposit
                    </a>
                  )}
                </>
              )}
            </div>
          ) : ['pending', 'working'].includes(d.status) ? (
            <p className="mt-2 text-sm text-emerald-900">Your deposit invoice is on its way by email…</p>
          ) : (
            <p className="mt-2 text-sm text-emerald-900">We’ll be in touch shortly with your deposit invoice and to book the work in.</p>
          )}
        </div>
      )}
      {q.status === 'rejected' && (
        <p className="mt-5 flex items-center gap-2 rounded-md bg-slate-100 p-4 text-sm text-slate-700" role="status">
          <XCircle size={18} /> You declined this quote{q.answeredAt ? ` on ${fmtDate(q.answeredAt)}` : ''}. If you change your mind or want changes, contact us.
        </p>
      )}

      {q.scope && <p className="mt-5 whitespace-pre-wrap text-sm text-slate-700">{q.scope}</p>}

      {q.items.length > 0 ? (
        <div className="mt-5 overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.name} className="divide-y divide-slate-100 border-t border-slate-200">
                {groups.length > 1 && (
                  <tr>
                    <th colSpan={4} className="bg-slate-50/60 px-3 py-1.5 text-left text-xs font-semibold text-slate-600">{g.name}</th>
                  </tr>
                )}
                {g.items.map((i, n) => (
                  <tr key={n}>
                    <td className="px-3 py-1.5">{i.description}</td>
                    <td className="num px-3 py-1.5 text-right">{i.qty} {i.unit}</td>
                    <td className="num px-3 py-1.5 text-right">{money(i.rate)}</td>
                    <td className="num px-3 py-1.5 text-right">{money(cents(i.qty * i.rate))}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : null}
      <dl className="mt-3 ml-auto max-w-xs space-y-1 text-sm">
        {q.items.length > 0 && (
          <>
            <div className="flex justify-between"><dt>Subtotal (ex GST)</dt><dd className="num">{money(exGst)}</dd></div>
            <div className="flex justify-between"><dt>GST</dt><dd className="num">{money(cents(q.total - exGst))}</dd></div>
          </>
        )}
        <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-bold"><dt>Total (inc GST)</dt><dd className="num">{money(q.total)}</dd></div>
      </dl>

      {(q.inclusions || q.exclusions) && (
        <div className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
          {q.inclusions && (
            <div>
              <p className="font-semibold">Included</p>
              <p className="mt-1 whitespace-pre-wrap text-slate-700">{q.inclusions}</p>
            </div>
          )}
          {q.exclusions && (
            <div>
              <p className="font-semibold">Not included</p>
              <p className="mt-1 whitespace-pre-wrap text-slate-700">{q.exclusions}</p>
            </div>
          )}
        </div>
      )}

      {q.status === 'quoted' && (
        expired ? (
          <p className="mt-6 rounded-md bg-amber-50 p-4 text-sm text-amber-900">This quote expired on {fmtDate(q.validUntil!)}. Contact us for an updated quote.</p>
        ) : (
          <form className="mt-6 space-y-3 rounded-md border border-slate-200 p-4" onSubmit={accept} aria-label="Accept the quote">
            <p className="font-semibold">Happy to go ahead?</p>
            <Field label="Your name">
              <input className="input max-w-sm" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>I accept this quote{q.validUntil ? `, valid until ${fmtDate(q.validUntil)},` : ''} for {money(q.total)} inc. GST, and its inclusions and exclusions.</span>
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Accept quote'}</button>
              {declining ? (
                <span className="flex items-center gap-2 text-sm">
                  Decline this quote?
                  <button type="button" className="btn-ghost px-3 py-1" disabled={busy} onClick={() => void answer(false)}>Yes, decline</button>
                  <button type="button" className="text-slate-500 underline" onClick={() => setDeclining(false)}>No</button>
                </span>
              ) : (
                <button type="button" className="text-sm text-slate-600 underline" onClick={() => setDeclining(true)}>Decline</button>
              )}
            </div>
            <p className="text-xs text-slate-500">Accepting emails you a deposit invoice to secure your booking.</p>
          </form>
        )
      )}
      <PaymentSafety className="mt-6" />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <a href="/" aria-label={BRAND.name}><Logo /></a>
        <div className="card mt-5 p-5 sm:p-7">{children}</div>
      </div>
    </div>
  )
}
