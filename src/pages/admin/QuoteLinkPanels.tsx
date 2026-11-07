import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Mail, Trash2 } from 'lucide-react'
import { Status, type Tone } from '../../components/ui'
import { TextButton } from '../../components/TextMessage'
import { useLookup, useStore } from '../../lib/store'
import { DEPOSIT_STATUS_LABEL, type DepositStatus, type Project } from '../../lib/types'
import { quoteTotal } from '../../lib/quote'
import { fmtDate, money } from '../../lib/utils'
import { supabase } from '../../lib/supabase'

/**
 * The quote's private link token. The live database keeps it from trades and clients (anyone with it
 * can accept the quote), so the office asks for it separately; demo data carries it on the project.
 */
function useQuoteToken(p: Project): string | undefined {
  const [token, setToken] = useState<string | undefined>(supabase ? undefined : p.quoteToken)
  const issued = p.status === 'quoted' ? `${p.id}:${p.quoteIssuedAt ?? ''}` : ''
  useEffect(() => {
    if (!supabase) return setToken(p.quoteToken)
    setToken(undefined)
    if (!issued) return
    const client = supabase
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // Just issued: the token is made when the save reaches the database, so try again for a few seconds.
    const ask = async (tries: number) => {
      const { data } = await client.rpc('admin_quote_token', { p_id: p.id })
      if (!live) return
      if (data) setToken(data as string)
      else if (tries > 0) timer = setTimeout(() => void ask(tries - 1), 2000)
    }
    void ask(3)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [issued, p.id, p.quoteToken])
  return token
}

export const quoteLink = (token: string) => `${window.location.origin}/#/quote/${token}`

/**
 * An issued quote's private link, for the client to read and accept it (no login needed): copy it,
 * or email or text it to the client with a short message. Sending it counts as a follow-up.
 */
export function SendQuoteLink({ p }: { p: Project }) {
  const { update } = useStore()
  const lk = useLookup()
  const [copied, setCopied] = useState(false)
  const token = useQuoteToken(p)
  if (!token) return null
  const client = lk.user(p.clientId)
  const first = client?.name.split(' ')[0] || 'there'
  const link = quoteLink(token)
  const message = `Hi ${first}, it's Next Phase Maintenance. Your quote for ${p.title} is ready: ${money(quoteTotal(p))} inc. GST${
    p.quoteValidUntil ? `, valid until ${fmtDate(p.quoteValidUntil)}` : ''
  }. You can read it and accept it here: ${link}`
  const sent = () =>
    update((d) => {
      const x = d.projects.find((y) => y.id === p.id)
      if (x) x.quoteFollowedUpAt = new Date().toISOString()
    })
  const copy = async () => {
    await navigator.clipboard?.writeText(link).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <span className="mr-auto flex flex-wrap items-center gap-2 text-sm" aria-label="Send the quote link">
      <span className="text-slate-600">Send the quote{client ? ` to ${client.name}` : ''}:</span>
      {client?.email && (
        <a className="btn-ghost px-3 py-1.5" href={`mailto:${client.email}?subject=${encodeURIComponent(`Your quote P-${p.number}: ${p.title}`)}&body=${encodeURIComponent(message)}`} onClick={sent}>
          <Mail size={15} aria-hidden="true" /> Email
        </a>
      )}
      {client?.phone && <TextButton phone={client.phone} message={message} event={`Quote P-${p.number}`} label="Text" className="btn-ghost px-3 py-1.5" onOpen={sent} />}
      <button type="button" className="btn-ghost px-3 py-1.5" onClick={() => void copy()}>
        {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />} {copied ? 'Copied' : 'Copy link'}
      </button>
      <a className="text-xs text-slate-500 underline" href={link} target="_blank" rel="noreferrer">
        Preview <ExternalLink size={11} className="inline" aria-hidden="true" />
      </a>
    </span>
  )
}

const DEPOSIT_TONE: Record<DepositStatus, Tone> = {
  none: 'slate',
  pending: 'slate',
  working: 'slate',
  sent: 'outline',
  failed: 'red',
  held: 'orange',
  paid: 'green',
  skipped: 'slate',
}

/** An accepted quote's deposit invoice: what it's for, where it's up to, its pay link, and Send. */
export function DepositPanel({ p }: { p: Project }) {
  const { data, sendQuoteDeposit, cloud } = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!['approved', 'in_progress', 'completed'].includes(p.status) || !p.deposit) return null
  const d = p.deposit
  const inv = d.invoiceId ? data.invoices.find((i) => i.id === d.invoiceId) : undefined
  const canSend = ['none', 'failed', 'held', 'skipped'].includes(d.status) && cloud
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendQuoteDeposit(p.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mb-5 rounded-md border border-slate-200 p-3 text-sm" aria-label="Deposit invoice">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Deposit</span>
        <Status tone={DEPOSIT_TONE[d.status]}>{DEPOSIT_STATUS_LABEL[d.status]}</Status>
        {d.amount ? <span className="num">{money(d.amount)} inc. GST</span> : null}
        {inv && <span className="num text-slate-600">· invoice {inv.qbInvoiceNumber}</span>}
        {p.quoteAnsweredName && <span className="text-slate-500">· accepted by {p.quoteAnsweredName} from the link</span>}
        {inv?.payLink && d.status === 'sent' && (
          <a className="ml-auto font-semibold underline" href={inv.payLink} target="_blank" rel="noreferrer">Pay link</a>
        )}
        {canSend && (
          <button type="button" className="btn-ghost ml-auto px-3 py-1 text-xs" disabled={busy} onClick={() => void send()}>
            {busy ? 'Sending…' : d.status === 'failed' ? 'Try again' : 'Send deposit invoice'}
          </button>
        )}
      </div>
      {d.status === 'sent' && <p className="mt-1 text-slate-600">Emailed from QuickBooks with its pay link. It’s marked paid here once it’s paid.</p>}
      {d.status === 'none' && <p className="mt-1 text-slate-600">Accepted before deposits were sent automatically, or it came to $0.</p>}
      {d.status === 'skipped' && <p className="mt-1 text-slate-600">Accepted before QuickBooks was connected.</p>}
      {d.error && <p className={d.status === 'held' ? 'mt-1 text-amber-800' : 'mt-1 text-red-600'}>{d.error}</p>}
      {error && <p className="mt-1 text-red-600">{error}</p>}
    </section>
  )
}

/** The quote as a QuickBooks estimate: its number, or why it didn't go, with Try again. */
export function EstimateLine({ p }: { p: Project }) {
  const { retryQuoteEstimate } = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const e = p.estimate
  if (!e || e.status === 'none') return null
  const retry = async () => {
    setBusy(true)
    setError(null)
    try {
      await retryQuoteEstimate(p.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="mr-auto flex flex-wrap items-center gap-2 text-xs text-slate-500" aria-label="QuickBooks estimate">
      {e.status === 'synced' && <>QuickBooks estimate <span className="num font-semibold text-slate-700">{e.number}</span></>}
      {(e.status === 'pending' || e.status === 'working') && 'Updating its QuickBooks estimate…'}
      {e.status === 'skipped' && 'Not in QuickBooks (issued before it was connected).'}
      {e.status === 'failed' && <span className="text-red-600">QuickBooks estimate failed: {e.error}</span>}
      {(e.status === 'failed' || e.status === 'skipped') && (
        <button type="button" className="underline" disabled={busy} onClick={() => void retry()}>{busy ? 'Sending…' : e.status === 'failed' ? 'Try again' : 'Add it to QuickBooks'}</button>
      )}
      {error && <span className="text-red-600">{error}</span>}
    </span>
  )
}


/**
 * Deletes a quote, after a confirmation that says what happens in QuickBooks: its estimate is
 * deleted there and an unpaid deposit invoice voided. Not for jobs under way or finished, nor for
 * anything with money paid against it (the server refuses those too).
 */
export function DeleteQuote({ p, onDeleted }: { p: Project; onDeleted: () => void }) {
  const { data, can, deleteQuote } = useStore()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!can('canManageProjects') || p.status === 'in_progress' || p.status === 'completed') return null
  const invoices = data.invoices.filter((i) => i.projectId === p.id)
  const paid = invoices.some((i) => i.status === 'paid') || p.deposit?.status === 'paid'
  const estimate = p.estimate?.status === 'synced' ? p.estimate.number : ''
  const toVoid = invoices.filter((i) => i.status !== 'paid' && i.qbInvoiceNumber)
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await deleteQuote(p.id)
      onDeleted()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  if (!asking) {
    return (
      <button type="button" className="btn-ghost order-first text-red-600 hover:bg-red-50" onClick={() => setAsking(true)}>
        <Trash2 size={15} aria-hidden="true" /> Delete quote
      </button>
    )
  }
  return (
    <div role="alertdialog" aria-labelledby={`del-${p.id}`} className="order-first basis-full rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <p id={`del-${p.id}`} className="font-semibold">Delete quote P-{p.number}?</p>
      {paid ? (
        <p className="mt-1">Money has been paid against this quote, so it can’t be deleted. Refund or credit it in QuickBooks first.</p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>The quote and everything in it (its lines, payment stages, notes and documents) is deleted from the portal. This can’t be undone.</li>
          {estimate && <li>Its QuickBooks estimate <span className="num font-semibold">{estimate}</span> is deleted in QuickBooks.</li>}
          {toVoid.map((i) => (
            <li key={i.id}>Its deposit invoice <span className="num font-semibold">{i.qbInvoiceNumber}</span> is voided in QuickBooks (it stays on record as void). If the client already got it, let them know.</li>
          ))}
          {p.status === 'quoted' && <li>Its quote link stops working for the client.</li>}
        </ul>
      )}
      {error && <p className="mt-2 font-semibold">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {!paid && (
          <button type="button" className="btn bg-red-600 text-white hover:bg-red-700" disabled={busy} onClick={() => void go()}>
            {busy ? 'Deleting…' : 'Yes, delete it'}
          </button>
        )}
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setAsking(false); setError(null) }}>Cancel</button>
      </div>
    </div>
  )
}
