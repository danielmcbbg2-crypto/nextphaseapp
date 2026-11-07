import type { Project, QuickBooksInvoice, QuoteItem } from './types'

/** Australian GST. Quote rates, variations and costs are entered without it. */
export const GST_RATE = 0.1

const cents = (n: number) => Math.round(n * 100) / 100

export const lineTotal = (i: Pick<QuoteItem, 'qty' | 'rate'>) => cents(i.qty * i.rate)
export const itemsSubtotal = (items: QuoteItem[]) => cents(items.reduce((s, i) => s + lineTotal(i), 0))
export const withGst = (exGst: number) => cents(exGst * (1 + GST_RATE))

/** Line items grouped by section, in order of first appearance. */
export function sections(items: QuoteItem[]): { name: string; items: QuoteItem[]; subtotal: number }[] {
  const out: { name: string; items: QuoteItem[]; subtotal: number }[] = []
  for (const i of items) {
    const name = i.section.trim() || 'General'
    let g = out.find((x) => x.name === name)
    if (!g) out.push((g = { name, items: [], subtotal: 0 }))
    g.items.push(i)
  }
  for (const g of out) g.subtotal = itemsSubtotal(g.items)
  return out
}

/** The quote's total inc. GST: from the line items when there are any, otherwise the amount entered. */
export function quoteTotal(p: Pick<Project, 'quoteItems' | 'quoteAmount'>): number {
  return p.quoteItems.length ? withGst(itemsSubtotal(p.quoteItems)) : p.quoteAmount ?? 0
}

export const approvedVariationsExGst = (p: Pick<Project, 'variations'>) =>
  cents(p.variations.filter((v) => v.status === 'approved').reduce((s, v) => s + v.amount, 0))

/** What the client has agreed to pay, inc. GST: the quote plus approved variations. */
export function contractTotal(p: Pick<Project, 'quoteItems' | 'quoteAmount' | 'variations'>): number {
  return cents(quoteTotal(p) + withGst(approvedVariationsExGst(p)))
}

/** The amount of each payment stage, inc. GST (a claimed stage keeps its invoice's amount). */
export function paymentAmounts(p: Project, invoices: QuickBooksInvoice[]): Map<string, number> {
  const out = new Map<string, number>()
  const quoted = quoteTotal(p)
  for (const s of p.payments) {
    const inv = s.invoiceId ? invoices.find((i) => i.id === s.invoiceId) : undefined
    if (inv) out.set(s.id, inv.amount)
    else if (s.basis === 'percent') out.set(s.id, cents((quoted * s.value) / 100))
    else if (s.basis === 'amount') out.set(s.id, cents(s.value))
  }
  const balance = p.payments.filter((s) => s.basis === 'balance' && !out.has(s.id))
  if (balance.length) {
    const rest = Math.max(0, cents(contractTotal(p) - [...out.values()].reduce((a, b) => a + b, 0)))
    // The remainder is shared evenly across the balance stages; the last takes the rounding.
    const share = cents(rest / balance.length)
    balance.forEach((s, n) => out.set(s.id, n === balance.length - 1 ? cents(rest - share * (balance.length - 1)) : share))
  }
  return out
}

/** The contract against actual costs, ex GST: its value, costs so far (approved expenses and logged costs) and margin. */
export function projectFinancials(p: Project, invoices: QuickBooksInvoice[]) {
  const contract = cents((p.quoteItems.length ? itemsSubtotal(p.quoteItems) : (p.quoteAmount ?? 0) / (1 + GST_RATE)) + approvedVariationsExGst(p))
  const expenses = cents(p.expenses.filter((e) => e.status === 'approved').reduce((s, e) => s + e.amount, 0))
  const pendingExpenses = cents(p.expenses.filter((e) => e.status === 'submitted').reduce((s, e) => s + e.amount, 0))
  const otherCosts = cents(p.costs.reduce((s, c) => s + c.amount, 0))
  const costs = cents(expenses + otherCosts)
  const margin = cents(contract - costs)
  const mine = invoices.filter((i) => i.projectId === p.id)
  return {
    contract,
    expenses,
    pendingExpenses,
    otherCosts,
    costs,
    margin,
    marginPct: contract > 0 ? Math.round((margin / contract) * 1000) / 10 : 0,
    invoiced: cents(mine.reduce((s, i) => s + i.amount, 0)),
    paid: cents(mine.filter((i) => i.status === 'paid').reduce((s, i) => s + i.amount, 0)),
  }
}

/** A new project's parts (quote, money, schedule, diary, defects, documents), all empty. */
export const blankCommercials = (): Pick<
  Project,
  'quoteItems' | 'quoteInclusions' | 'quoteExclusions' | 'variations' | 'payments' | 'costs' | 'tasks' | 'diary' | 'defects' | 'documents'
> => ({
  quoteItems: [],
  quoteInclusions: '',
  quoteExclusions: '',
  variations: [],
  payments: [],
  costs: [],
  tasks: [],
  diary: [],
  defects: [],
  documents: [],
})

/** The next QuickBooks-style invoice number, e.g. INV-2050. */
export function nextInvoiceNumber(invoices: QuickBooksInvoice[]): string {
  const nums = invoices.map((i) => parseInt(i.qbInvoiceNumber.replace(/\D/g, ''), 10)).filter((n) => !Number.isNaN(n))
  return `INV-${nums.length ? Math.max(...nums) + 1 : 1001}`
}

// ───────────── pipeline ─────────────

/** Days an issued quote waits for an answer before it needs a follow-up (and between follow-ups). */
export const FOLLOW_UP_DAYS = 5
const DAY = 86_400_000
export const daysSince = (iso: string | undefined, now = Date.now()) => (iso ? Math.floor((now - new Date(iso).getTime()) / DAY) : 0)

export type QuoteStage = 'requested' | 'pricing' | 'issued' | 'won' | 'lost'

/** Where a quote is in the pipeline (undefined for projects that never were a quote in play). */
export function quoteStage(p: Project): QuoteStage | undefined {
  if (p.status === 'quote_requested') return p.quoteItems.length || p.quoteAmount ? 'pricing' : 'requested'
  if (p.status === 'quoted') return 'issued'
  if (p.quoteDecision === 'approved') return 'won'
  if (p.quoteDecision === 'rejected' || p.status === 'rejected') return 'lost'
  return undefined
}

/** An issued quote nobody has answered or followed up for a while. */
export function needsFollowUp(p: Project, now = Date.now()): boolean {
  if (p.status !== 'quoted') return false
  return daysSince(p.quoteIssuedAt, now) >= FOLLOW_UP_DAYS && (!p.quoteFollowedUpAt || daysSince(p.quoteFollowedUpAt, now) >= FOLLOW_UP_DAYS)
}

/** Days until an issued quote's validity ends (negative once expired); undefined without a date. */
export function daysToExpiry(p: Project, now = Date.now()): number | undefined {
  if (p.status !== 'quoted' || !p.quoteValidUntil) return undefined
  return Math.ceil((new Date(`${p.quoteValidUntil}T23:59:59`).getTime() - now) / DAY)
}

/** Win rate and values over the last `days` days (by when quotes were answered or issued). */
export function quoteStats(projects: Project[], days = 90, now = Date.now()) {
  const since = now - days * DAY
  const within = (iso?: string) => !!iso && new Date(iso).getTime() >= since
  const won = projects.filter((p) => p.quoteDecision === 'approved' && within(p.quoteDecidedAt))
  const lost = projects.filter((p) => p.quoteDecision === 'rejected' && within(p.quoteDecidedAt))
  const issued = projects.filter((p) => within(p.quoteIssuedAt))
  const open = projects.filter((p) => p.status === 'quoted')
  const sum = (list: Project[]) => cents(list.reduce((s, p) => s + quoteTotal(p), 0))
  const answered = won.length + lost.length
  return {
    openCount: open.length,
    openValue: sum(open),
    wonCount: won.length,
    wonValue: sum(won),
    lostCount: lost.length,
    winRate: answered ? Math.round((won.length / answered) * 100) : undefined,
    averageQuote: issued.length ? cents(sum(issued) / issued.length) : undefined,
    issuedCount: issued.length,
  }
}
