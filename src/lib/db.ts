/**
 * Maps the in-memory AppData model to the Supabase tables and back.
 *
 * Pages keep editing an AppData copy (see `update` in store.tsx). In cloud mode
 * the store diffs the before/after copies and turns the difference into
 * insert/update/delete calls, so row-level security on the server decides what
 * each person is actually allowed to change.
 */
import type {
  AppData,
  Expense,
  InboxMessage,
  Lead,
  TextLogEntry,
  QuoteTemplate,
  DepositStatus,
  MaintenanceRequest,
  Milestone,
  OrderItem,
  PaymentStage,
  ProjectTask,
  DiaryEntry,
  Defect,
  ProjectDocument,
  Product,
  Project,
  ProjectCost,
  ProductCompliance,
  OrderInvoiceStatus,
  ProductOption,
  ProductSpec,
  ProductSource,
  SupplierStock,
  Pricing,
  Property,
  QuickBooksInvoice,
  QuoteItem,
  SmsNotification,
  SmsSettings,
  StoreOrder,
  UserAccount,
  Variation,
} from './types'
import { DATA_VERSION } from './seed'

export type Row = Record<string, unknown>

export const TABLES = [
  'profiles',
  'properties',
  'projects',
  'requests',
  'project_milestones',
  'project_expenses',
  'project_quote_items',
  'project_variations',
  'project_payments',
  'project_costs',
  'project_tasks',
  'project_diary',
  'project_defects',
  'project_documents',
  'invoices',
  'inbox',
  'sms_log',
  'settings',
  'products',
  'product_trade_prices',
  'product_client_prices',
  'product_sources',
  'orders',
  'order_items',
  'order_notes',
  'leads',
  'text_log',
  'quote_templates',
  'product_price_history',
] as const
export type TableName = (typeof TABLES)[number]

export interface DbAdapter {
  select(table: TableName): Promise<Row[]>
  insert(table: TableName, rows: Row[]): Promise<void>
  update(table: TableName, id: string | number, patch: Row): Promise<void>
  remove(table: TableName, id: string | number): Promise<void>
  /** Runs a database function that takes no arguments and returns JSON (live mode only). */
  call?(fn: 'my_booked_projects'): Promise<unknown>
}

export type Op =
  | { kind: 'insert'; table: TableName; rows: Row[] }
  | { kind: 'update'; table: TableName; id: string | number; patch: Row }
  | { kind: 'delete'; table: TableName; id: string | number }

const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v)
const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v)
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v))

import { DEFAULT_PRICING, DEFAULT_SMS } from './types'
export { DEFAULT_SMS }

// ───────────── to rows ─────────────

export const profileRow = (u: UserAccount): Row => ({
  id: u.id,
  name: u.name,
  email: u.email.trim() || null,
  role: u.role,
  phone: u.phone,
  company: nul(u.company),
  trade: nul(u.trade),
  permissions: u.permissions,
  status: u.status,
  created_at: u.createdAt,
})

export const propertyRow = (p: Property): Row => ({
  id: p.id,
  client_id: p.clientId,
  address: p.address,
  suburb: p.suburb,
  postcode: p.postcode,
  paint_colors: p.paintColors,
  skirt_profile: p.skirtProfile,
  cladding_type: p.claddingType,
  access_code: p.accessCode,
  notes: p.notes,
  floor_plan: nul(p.floorPlan),
})

const requestRow = (r: MaintenanceRequest): Row => ({
  id: r.id,
  number: r.number,
  client_id: r.clientId,
  property_id: r.propertyId,
  title: r.title,
  description: r.description,
  category: r.category,
  urgency: r.urgency,
  photos: r.photos,
  completion_photos: r.completionPhotos,
  status: r.status,
  assigned_provider_id: nul(r.assignedProviderId),
  scheduled_date: nul(r.scheduledDate),
  notes: r.notes,
  sms_notified: r.smsNotified,
  created_at: r.createdAt,
  completed_at: nul(r.completedAt),
  created_by: nul(r.createdBy),
})

const projectRow = (p: Project): Row => ({
  id: p.id,
  number: p.number,
  client_id: p.clientId,
  property_id: p.propertyId,
  title: p.title,
  description: p.description,
  type: p.type,
  budget: p.budget,
  quote_amount: nul(p.quoteAmount),
  scope_of_works: p.scopeOfWorks,
  status: p.status,
  assigned_provider_id: nul(p.assignedProviderId),
  created_at: p.createdAt,
  created_by: nul(p.createdBy),
  quote_decided_by: nul(p.quoteDecidedBy),
  quote_decision: nul(p.quoteDecision),
  quote_inclusions: p.quoteInclusions,
  quote_exclusions: p.quoteExclusions,
  quote_valid_until: nul(p.quoteValidUntil),
  quote_issued_at: nul(p.quoteIssuedAt),
  quote_decided_at: nul(p.quoteDecidedAt),
  quote_followed_up_at: nul(p.quoteFollowedUpAt),
  order_id: nul(p.orderId),
})

const quoteItemRow = (projectId: string, i: QuoteItem, position: number): Row => ({
  id: i.id,
  project_id: projectId,
  position,
  section: i.section,
  description: i.description,
  kind: i.kind,
  qty: i.qty,
  unit: i.unit,
  rate: i.rate,
})

const variationRow = (projectId: string, v: Variation): Row => ({
  id: v.id,
  project_id: projectId,
  number: v.number,
  title: v.title,
  description: v.description,
  amount: v.amount,
  status: v.status,
  created_at: v.createdAt,
  created_by: nul(v.createdBy),
  decided_by: nul(v.decidedBy),
  decided_at: nul(v.decidedAt),
})

const paymentRow = (projectId: string, s: PaymentStage, position: number): Row => ({
  id: s.id,
  project_id: projectId,
  position,
  title: s.title,
  basis: s.basis,
  value: s.value,
  milestone_id: nul(s.milestoneId),
  invoice_id: nul(s.invoiceId),
})

const costRow = (projectId: string, c: ProjectCost): Row => ({
  id: c.id,
  project_id: projectId,
  date: c.date,
  description: c.description,
  category: c.category,
  supplier: c.supplier,
  amount: c.amount,
})

const taskRow = (projectId: string, t: ProjectTask, position: number): Row => ({
  id: t.id,
  project_id: projectId,
  position,
  stage: t.stage,
  title: t.title,
  start_date: t.startDate,
  end_date: t.endDate,
  start_time: nul(t.startTime),
  assignee_id: nul(t.assigneeId),
  status: t.status,
  notes: t.notes,
  client_visible: t.clientVisible,
})

const diaryRow = (projectId: string, e: DiaryEntry): Row => ({
  id: e.id,
  project_id: projectId,
  date: e.date,
  weather: e.weather,
  on_site: e.onSite,
  work_done: e.workDone,
  issues: e.issues,
  photos: e.photos,
  share_with_client: e.shareWithClient,
  author_id: nul(e.authorId),
  created_at: e.createdAt,
})

const defectRow = (projectId: string, d: Defect): Row => ({
  id: d.id,
  project_id: projectId,
  number: d.number,
  title: d.title,
  location: d.location,
  description: d.description,
  assignee_id: nul(d.assigneeId),
  due_date: nul(d.dueDate),
  status: d.status,
  photos: d.photos,
  fix_photos: d.fixPhotos,
  fix_notes: d.fixNotes,
  raised_by: nul(d.raisedBy),
  raised_at: d.raisedAt,
  fixed_by: nul(d.fixedBy),
  fixed_at: nul(d.fixedAt),
  closed_by: nul(d.closedBy),
  closed_at: nul(d.closedAt),
})

const documentRow = (projectId: string, d: ProjectDocument): Row => ({
  id: d.id,
  project_id: projectId,
  name: d.name,
  category: d.category,
  path: d.path,
  size_bytes: d.sizeBytes,
  content_type: d.contentType,
  share: d.share,
  uploaded_by: nul(d.uploadedBy),
  uploaded_at: d.uploadedAt,
})

const milestoneRow = (projectId: string, m: Milestone): Row => ({ id: m.id, project_id: projectId, title: m.title, date: m.date, done: m.done })

const expenseRow = (projectId: string, e: Expense): Row => ({
  id: e.id,
  project_id: projectId,
  provider_id: e.providerId || null,
  created_by: nul(e.createdBy),
  date: e.date,
  description: e.description,
  category: e.category,
  amount: e.amount,
  status: e.status,
})

const invoiceRow = (i: QuickBooksInvoice): Row => ({
  id: i.id,
  request_id: nul(i.requestId),
  project_id: nul(i.projectId),
  client_id: i.clientId,
  qb_invoice_number: i.qbInvoiceNumber,
  amount: i.amount,
  status: i.status,
  bank_transfer_ref: i.bankTransferRef,
  paid_date: nul(i.paidDate),
  due_date: i.dueDate,
  created_at: i.createdAt,
})

const inboxRow = (m: InboxMessage): Row => ({
  id: m.id,
  user_id: m.userId,
  title: m.title,
  body: m.body,
  created_at: m.createdAt,
  read: m.read,
  requires_ack: m.requiresAck,
  acknowledged: m.acknowledged,
  acknowledged_by: nul(m.acknowledgedBy),
  request_id: nul(m.requestId),
  project_id: nul(m.projectId),
})

const smsRow = (s: SmsNotification): Row => ({
  id: s.id,
  recipient_phone: s.recipientPhone,
  message: s.message,
  sent_at: s.timestamp,
  status: s.status,
  trigger_event: s.triggerEvent,
  detail: nul(s.detail),
})

const settingsRow = (d: AppData): Row => ({
  id: 1,
  sms: {
    recipients: d.smsSettings.recipients,
    notifyOnNewRequest: d.smsSettings.notifyOnNewRequest,
    notifyOnUrgentOnly: d.smsSettings.notifyOnUrgentOnly,
    notifyProviderOnAssign: d.smsSettings.notifyProviderOnAssign,
    bookingReminderTexts: d.smsSettings.bookingReminderTexts,
    autoReply: d.smsSettings.autoReply,
    autoReplyMessage: d.smsSettings.autoReplyMessage.slice(0, 480),
    quoteFollowUps: d.smsSettings.quoteFollowUps,
    quoteFollowUpDays: d.smsSettings.quoteFollowUpDays,
    quoteFollowUpMessage: d.smsSettings.quoteFollowUpMessage.slice(0, 480),
  },
  bank: d.bank,
  pricing: d.pricing,
})

const productRow = (p: Product): Row => ({
  id: p.id,
  title: p.title,
  description: p.description,
  category: p.category,
  brand: p.brand,
  sku: p.sku,
  price: p.price,
  images: p.images,
  // The client and trade add-ons are set by the database (with the client and trade prices).
  options: (p.options ?? []).map((g) => ({ id: g.id, name: g.name, values: g.values.map((v) => ({ id: v.id, label: v.label, price: v.price, available: v.available, ...(v.image ? { image: v.image } : {}) })) })),
  // Listings saved before these details existed (or by older code) still save, with them empty.
  specs: p.specs ?? [],
  highlights: p.highlights ?? [],
  seo_title: p.seoTitle ?? '',
  meta_description: p.metaDescription ?? '',
  image_alt: p.imageAlt ?? [],
  videos: p.videos ?? [],
  gtin: p.gtin ?? '',
  compliance: p.compliance ?? {},
  status: p.status,
  stock: p.stock,
  created_by: nul(p.createdBy),
  created_at: p.createdAt,
})

const orderRow = (o: StoreOrder): Row => ({
  id: o.id,
  number: o.number,
  customer_id: nul(o.customerId),
  name: o.name,
  email: o.email,
  phone: o.phone,
  delivery: o.delivery,
  address: o.address,
  notes: o.notes,
  trade: o.trade,
  total: o.total,
  status: o.status,
  created_at: o.createdAt,
})

const leadRow = (l: Lead): Row => ({
  id: l.id,
  number: l.number,
  name: l.name,
  email: l.email,
  phone: l.phone,
  company: l.company,
  suburb: l.suburb,
  services: l.services,
  urgency: l.urgency,
  contact_by: l.contactBy,
  message: l.message,
  photos: l.photos,
  status: l.status,
  notes: l.notes,
  client_id: nul(l.clientId),
  created_at: l.createdAt,
})

const textRow = (t: TextLogEntry): Row => ({
  id: t.id,
  recipient_phone: t.to,
  message: t.message,
  trigger_event: t.event,
  opened_by: nul(t.openedBy),
  opened_at: t.openedAt,
})

const orderItemRow = (orderId: string, i: OrderItem): Row => ({
  id: i.id,
  order_id: orderId,
  product_id: nul(i.productId),
  title: i.title,
  sku: i.sku,
  unit_price: i.unitPrice,
  qty: i.qty,
  options: i.options ?? '',
  install: !!i.install,
})

interface Spec {
  table: TableName
  rows: (d: AppData) => Row[]
  /** Columns the database generates; never sent on insert or update. */
  readonly?: string[]
}

// Parent tables first: inserts run in this order, deletes in reverse.
const SPECS: Spec[] = [
  { table: 'profiles', rows: (d) => d.users.map(profileRow) },
  { table: 'properties', rows: (d) => d.properties.map(propertyRow) },
  // created_by, quote_decided_by/quote_decision and acknowledged_by are stamped by the database from
  // whoever is signed in, so the app never sends them.
  { table: 'projects', rows: (d) => d.projects.map(projectRow), readonly: ['number', 'created_by', 'quote_decided_by', 'quote_decision', 'quote_issued_at', 'quote_decided_at'] },
  { table: 'requests', rows: (d) => d.requests.map(requestRow), readonly: ['number', 'created_by'] },
  { table: 'project_milestones', rows: (d) => d.projects.flatMap((p) => p.milestones.map((m) => milestoneRow(p.id, m))) },
  { table: 'project_expenses', rows: (d) => d.projects.flatMap((p) => p.expenses.map((e) => expenseRow(p.id, e))), readonly: ['created_by'] },
  { table: 'project_quote_items', rows: (d) => d.projects.flatMap((p) => p.quoteItems.map((i, n) => quoteItemRow(p.id, i, n))) },
  // Who proposed and who decided each variation (and when) is set by the database.
  { table: 'project_variations', rows: (d) => d.projects.flatMap((p) => p.variations.map((v) => variationRow(p.id, v))), readonly: ['created_by', 'decided_by', 'decided_at'] },
  { table: 'project_costs', rows: (d) => d.projects.flatMap((p) => p.costs.map((c) => costRow(p.id, c))) },
  { table: 'project_tasks', rows: (d) => d.projects.flatMap((p) => p.tasks.map((t, n) => taskRow(p.id, t, n))) },
  // Authors, numbers and who raised, fixed and closed what (and when) are set by the database.
  { table: 'project_diary', rows: (d) => d.projects.flatMap((p) => p.diary.map((e) => diaryRow(p.id, e))), readonly: ['author_id', 'created_at'] },
  {
    table: 'project_defects',
    rows: (d) => d.projects.flatMap((p) => p.defects.map((x) => defectRow(p.id, x))),
    readonly: ['number', 'raised_by', 'raised_at', 'fixed_by', 'fixed_at', 'closed_by', 'closed_at'],
  },
  { table: 'project_documents', rows: (d) => d.projects.flatMap((p) => p.documents.map((x) => documentRow(p.id, x))), readonly: ['uploaded_by', 'uploaded_at'] },
  { table: 'invoices', rows: (d) => d.invoices.map(invoiceRow) },
  // After invoices: a claimed payment refers to its invoice.
  { table: 'project_payments', rows: (d) => d.projects.flatMap((p) => p.payments.map((s, n) => paymentRow(p.id, s, n))) },
  { table: 'inbox', rows: (d) => d.inbox.map(inboxRow), readonly: ['acknowledged_by'] },
  { table: 'sms_log', rows: (d) => d.sms.map(smsRow) },
  { table: 'settings', rows: (d) => [settingsRow(d)] },
  { table: 'products', rows: (d) => d.products.map(productRow), readonly: ['created_by'] },
  // Keyed by the product's id. Only store managers change these.
  {
    table: 'product_trade_prices',
    rows: (d) => d.products.filter((p) => p.tradePrice !== undefined).map((p) => ({ id: p.id, price: p.tradePrice })),
  },
  {
    table: 'product_client_prices',
    rows: (d) => d.products.filter((p) => p.clientPrice !== undefined).map((p) => ({ id: p.id, price: p.clientPrice })),
  },
  {
    table: 'product_sources',
    rows: (d) =>
      d.products
        .filter((p) => p.source)
        .map((p) => ({
          id: p.id,
          supplier: p.source!.supplier,
          source_url: p.source!.url,
          cost: nul(p.source!.cost),
          notes: p.source!.notes,
          auto_price: p.source!.autoPrice ?? true,
          track_stock: p.source!.trackStock ?? true,
          out_of_stock_as: p.source!.outOfStockAs ?? 'out_of_stock',
          option_costs: p.source!.optionCosts ?? {},
        })),
  },
  // Orders are placed by the database (place_order); store managers only change the status, and
  // keep their notes in order_notes (keyed by the order's id), which customers can't read.
  { table: 'orders', rows: (d) => d.orders.map(orderRow), readonly: ['number'] },
  { table: 'order_items', rows: (d) => d.orders.flatMap((o) => o.items.map((i) => orderItemRow(o.id, i))) },
  { table: 'order_notes', rows: (d) => d.orders.filter((o) => o.adminNotes).map((o) => ({ id: o.id, notes: o.adminNotes })) },
  // Leads only arrive through submit_lead; the office changes their status and notes.
  { table: 'leads', rows: (d) => d.leads.map(leadRow), readonly: ['number'] },
  // Who opened each text, and when, is set by the database; entries are never changed.
  { table: 'quote_templates', rows: (d) => d.quoteTemplates.map((t) => ({ id: t.id, name: t.name, items: t.items, inclusions: t.inclusions, exclusions: t.exclusions, created_at: t.createdAt })) },
  { table: 'text_log', rows: (d) => d.texts.map(textRow), readonly: ['opened_by', 'opened_at'] },
]

const strip = (row: Row, cols: string[] = []) => {
  const out = { ...row }
  for (const c of cols) delete out[c]
  return out
}

/** A table's rows by id, each with its JSON (to compare a whole row at once). */
type RowIndex = Map<string, { row: Row; json: string }>

// The rows built from each AppData copy, kept while that copy lives. The copy one `diff` builds as
// "next" is usually the next one's "prev", so each edit builds and serialises the rows once, not twice.
const rowCache = new WeakMap<AppData, Map<Spec, RowIndex>>()

function rowIndex(d: AppData, spec: Spec): RowIndex {
  let perSpec = rowCache.get(d)
  if (!perSpec) rowCache.set(d, (perSpec = new Map()))
  let index = perSpec.get(spec)
  if (!index) {
    index = new Map(spec.rows(d).map((row) => [row.id as string, { row, json: JSON.stringify(row) }]))
    perSpec.set(spec, index)
  }
  return index
}

/**
 * Computes the database operations that turn `prev` into `next`. Both must be treated as immutable
 * once diffed (the store only ever replaces its data with a fresh copy), as their rows are cached.
 */
export function diff(prev: AppData, next: AppData): Op[] {
  const inserts: Op[] = []
  const updates: Op[] = []
  const deletes: Op[] = []
  for (const spec of SPECS) {
    const before = rowIndex(prev, spec)
    const after = rowIndex(next, spec)
    const added: Row[] = []
    for (const [id, { row, json }] of after) {
      const was = before.get(id)
      if (!was) {
        added.push(strip(row, spec.readonly))
        continue
      }
      // Most rows are unchanged: one comparison of the whole row settles them.
      if (was.json === json) continue
      const old = was.row
      const patch: Row = {}
      for (const k of Object.keys(row)) {
        if (spec.readonly?.includes(k)) continue
        if (JSON.stringify(row[k]) !== JSON.stringify(old[k])) patch[k] = row[k]
      }
      if (Object.keys(patch).length) updates.push({ kind: 'update', table: spec.table, id, patch })
    }
    if (added.length) inserts.push({ kind: 'insert', table: spec.table, rows: added })
    for (const id of before.keys()) if (!after.has(id)) deletes.unshift({ kind: 'delete', table: spec.table, id })
  }
  return [...inserts, ...updates, ...deletes]
}

export async function applyOps(db: DbAdapter, ops: Op[]): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'insert') await db.insert(op.table, op.rows)
    else if (op.kind === 'update') await db.update(op.table, op.id, op.patch)
    else await db.remove(op.table, op.id)
  }
}

// ───────────── from rows ─────────────

export const userFromRow = (r: Row): UserAccount => ({
  id: r.id as string,
  name: r.name as string,
  email: (r.email as string | null) ?? '',
  role: r.role as UserAccount['role'],
  phone: (r.phone as string) ?? '',
  company: opt(r.company as string | null),
  trade: opt(r.trade as string | null),
  permissions: (r.permissions as UserAccount['permissions']) ?? [],
  createdAt: r.created_at as string,
  status: r.status as UserAccount['status'],
  passwordHash: '',
  hasLogin: r.has_login as boolean,
})

const propertyFromRow = (r: Row): Property => ({
  id: r.id as string,
  clientId: r.client_id as string,
  address: r.address as string,
  suburb: r.suburb as string,
  postcode: r.postcode as string,
  paintColors: r.paint_colors as Property['paintColors'],
  skirtProfile: r.skirt_profile as string,
  claddingType: r.cladding_type as string,
  accessCode: r.access_code as string,
  notes: r.notes as string,
  floorPlan: opt(r.floor_plan as string | null),
})

export const requestFromRow = (r: Row): MaintenanceRequest => ({
  id: r.id as string,
  number: num(r.number),
  clientId: r.client_id as string,
  propertyId: r.property_id as string,
  title: r.title as string,
  description: r.description as string,
  category: r.category as MaintenanceRequest['category'],
  urgency: r.urgency as MaintenanceRequest['urgency'],
  photos: (r.photos as string[]) ?? [],
  completionPhotos: (r.completion_photos as string[]) ?? [],
  status: r.status as MaintenanceRequest['status'],
  assignedProviderId: opt(r.assigned_provider_id as string | null),
  scheduledDate: opt(r.scheduled_date as string | null),
  notes: r.notes as string,
  smsNotified: r.sms_notified as boolean,
  createdAt: r.created_at as string,
  completedAt: opt(r.completed_at as string | null),
  createdBy: opt(r.created_by as string | null),
})

/** Rows of a project's quote items, variations, payments and costs. */
interface ProjectChildren {
  items?: Row[]
  variations?: Row[]
  payments?: Row[]
  costs?: Row[]
  tasks?: Row[]
  diary?: Row[]
  defects?: Row[]
  documents?: Row[]
}
/** "07:30:00" → "07:30". */
const hhmm = (t: unknown) => (typeof t === 'string' && t ? t.slice(0, 5) : undefined)
const byPosition = (a: Row, b: Row) => num(a.position) - num(b.position)

export const projectFromRow = (r: Row, milestones: Row[] = [], expenses: Row[] = [], more: ProjectChildren = {}): Project => ({
  id: r.id as string,
  number: num(r.number),
  clientId: r.client_id as string,
  propertyId: r.property_id as string,
  title: r.title as string,
  description: r.description as string,
  type: r.type as Project['type'],
  budget: num(r.budget),
  quoteAmount: r.quote_amount === null || r.quote_amount === undefined ? undefined : num(r.quote_amount),
  scopeOfWorks: r.scope_of_works as string,
  status: r.status as Project['status'],
  assignedProviderId: opt(r.assigned_provider_id as string | null),
  createdAt: r.created_at as string,
  createdBy: opt(r.created_by as string | null),
  quoteDecidedBy: opt(r.quote_decided_by as string | null),
  quoteDecision: opt(r.quote_decision as Project['quoteDecision'] | null),
  quoteInclusions: (r.quote_inclusions as string | undefined) ?? '',
  quoteExclusions: (r.quote_exclusions as string | undefined) ?? '',
  quoteValidUntil: opt(r.quote_valid_until as string | null | undefined),
  quoteIssuedAt: opt(r.quote_issued_at as string | null | undefined),
  quoteDecidedAt: opt(r.quote_decided_at as string | null | undefined),
  quoteFollowedUpAt: opt(r.quote_followed_up_at as string | null | undefined),
  orderId: opt(r.order_id as string | null | undefined),
  quoteToken: opt(r.quote_token as string | null | undefined),
  quoteAnsweredName: opt(r.quote_answered_name as string | null | undefined),
  estimate: r.estimate_status
    ? { status: r.estimate_status as NonNullable<Project['estimate']>['status'], number: (r.estimate_number as string | undefined) ?? '', error: (r.estimate_error as string | undefined) ?? '' }
    : undefined,
  deposit: r.deposit_status
    ? {
        status: r.deposit_status as DepositStatus,
        amount: r.deposit_amount == null ? undefined : Number(r.deposit_amount),
        invoiceId: opt(r.deposit_invoice_id as string | null | undefined),
        error: (r.deposit_error as string | undefined) ?? '',
      }
    : undefined,
  quoteItems: [...(more.items ?? [])].sort(byPosition).map((i) => ({
    id: i.id as string,
    section: i.section as string,
    description: i.description as string,
    kind: i.kind as QuoteItem['kind'],
    qty: num(i.qty),
    unit: i.unit as string,
    rate: num(i.rate),
  })),
  variations: (more.variations ?? [])
    .map((v) => ({
      id: v.id as string,
      number: num(v.number),
      title: v.title as string,
      description: v.description as string,
      amount: num(v.amount),
      status: v.status as Variation['status'],
      createdAt: v.created_at as string,
      createdBy: opt(v.created_by as string | null),
      decidedBy: opt(v.decided_by as string | null),
      decidedAt: opt(v.decided_at as string | null),
    }))
    .sort((a, b) => a.number - b.number),
  payments: [...(more.payments ?? [])].sort(byPosition).map((s) => ({
    id: s.id as string,
    title: s.title as string,
    basis: s.basis as PaymentStage['basis'],
    value: num(s.value),
    milestoneId: opt(s.milestone_id as string | null),
    invoiceId: opt(s.invoice_id as string | null),
  })),
  costs: (more.costs ?? [])
    .map((c) => ({
      id: c.id as string,
      date: c.date as string,
      description: c.description as string,
      category: c.category as string,
      supplier: c.supplier as string,
      amount: num(c.amount),
    }))
    .sort((a, b) => a.date.localeCompare(b.date)),
  tasks: [...(more.tasks ?? [])].sort(byPosition).map((t) => ({
    id: t.id as string,
    stage: t.stage as string,
    title: t.title as string,
    startDate: t.start_date as string,
    endDate: t.end_date as string,
    startTime: hhmm(t.start_time),
    assigneeId: opt(t.assignee_id as string | null),
    status: t.status as ProjectTask['status'],
    notes: t.notes as string,
    clientVisible: t.client_visible as boolean,
  })),
  diary: (more.diary ?? [])
    .map((e) => ({
      id: e.id as string,
      date: e.date as string,
      weather: e.weather as string,
      onSite: e.on_site as string,
      workDone: e.work_done as string,
      issues: e.issues as string,
      photos: (e.photos as string[]) ?? [],
      shareWithClient: e.share_with_client as boolean,
      authorId: opt(e.author_id as string | null),
      createdAt: e.created_at as string,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
  defects: (more.defects ?? [])
    .map((x) => ({
      id: x.id as string,
      number: num(x.number),
      title: x.title as string,
      location: x.location as string,
      description: x.description as string,
      assigneeId: opt(x.assignee_id as string | null),
      dueDate: opt(x.due_date as string | null),
      status: x.status as Defect['status'],
      photos: (x.photos as string[]) ?? [],
      fixPhotos: (x.fix_photos as string[]) ?? [],
      fixNotes: x.fix_notes as string,
      raisedBy: opt(x.raised_by as string | null),
      raisedAt: x.raised_at as string,
      fixedBy: opt(x.fixed_by as string | null),
      fixedAt: opt(x.fixed_at as string | null),
      closedBy: opt(x.closed_by as string | null),
      closedAt: opt(x.closed_at as string | null),
    }))
    .sort((a, b) => a.number - b.number),
  documents: (more.documents ?? [])
    .map((x) => ({
      id: x.id as string,
      name: x.name as string,
      category: x.category as ProjectDocument['category'],
      path: x.path as string,
      sizeBytes: num(x.size_bytes),
      contentType: x.content_type as string,
      share: x.share as ProjectDocument['share'],
      uploadedBy: opt(x.uploaded_by as string | null),
      uploadedAt: x.uploaded_at as string,
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
  milestones: milestones
    .map((m) => ({ id: m.id as string, title: m.title as string, date: m.date as string, done: m.done as boolean }))
    .sort((a, b) => a.date.localeCompare(b.date)),
  expenses: expenses
    .map((e) => ({
      id: e.id as string,
      providerId: (e.provider_id as string | null) ?? '',
      date: e.date as string,
      description: e.description as string,
      category: e.category as Expense['category'],
      amount: num(e.amount),
      status: e.status as Expense['status'],
      createdBy: opt(e.created_by as string | null),
    }))
    .sort((a, b) => a.date.localeCompare(b.date)),
})

const invoiceFromRow = (r: Row): QuickBooksInvoice => ({
  id: r.id as string,
  requestId: opt(r.request_id as string | null),
  projectId: opt(r.project_id as string | null),
  clientId: r.client_id as string,
  qbInvoiceNumber: r.qb_invoice_number as string,
  payLink: (r.pay_link as string | undefined) || undefined,
  amount: num(r.amount),
  status: r.status as QuickBooksInvoice['status'],
  bankTransferRef: r.bank_transfer_ref as string,
  paidDate: opt(r.paid_date as string | null),
  dueDate: r.due_date as string,
  createdAt: r.created_at as string,
})

const inboxFromRow = (r: Row): InboxMessage => ({
  id: r.id as string,
  userId: r.user_id as string,
  title: r.title as string,
  body: r.body as string,
  createdAt: r.created_at as string,
  read: r.read as boolean,
  requiresAck: r.requires_ack as boolean,
  acknowledged: r.acknowledged as boolean,
  acknowledgedBy: opt(r.acknowledged_by as string | null),
  requestId: opt(r.request_id as string | null),
  projectId: opt(r.project_id as string | null),
})

const smsFromRow = (r: Row): SmsNotification => ({
  id: r.id as string,
  recipientPhone: r.recipient_phone as string,
  message: r.message as string,
  timestamp: r.sent_at as string,
  status: r.status as SmsNotification['status'],
  triggerEvent: r.trigger_event as string,
  detail: opt(r.detail as string | null),
})

const newestFirst = (k: string) => (a: Row, b: Row) => String(b[k]).localeCompare(String(a[k]))

export const productsFromRows = (products: Row[], tradePrices: Row[] = [], sources: Row[] = [], clientPrices: Row[] = []): Product[] => {
  const trade = new Map(tradePrices.map((r) => [r.id as string, num(r.price)]))
  const client = new Map(clientPrices.map((r) => [r.id as string, num(r.price)]))
  type Amounts = Record<string, number>
  const tradeAdds = new Map(tradePrices.map((r) => [r.id as string, (r.option_prices as Amounts | undefined) ?? {}]))
  const clientAdds = new Map(clientPrices.map((r) => [r.id as string, (r.option_prices as Amounts | undefined) ?? {}]))
  const source = new Map(sources.map((r) => [r.id as string, r]))
  return products
    .sort((a, b) => String(a.title).localeCompare(String(b.title)))
    .map((r) => {
      const s = source.get(r.id as string)
      return {
        id: r.id as string,
        title: r.title as string,
        description: r.description as string,
        category: r.category as string,
        brand: r.brand as string,
        sku: r.sku as string,
        price: num(r.price),
        tradePrice: trade.get(r.id as string),
        clientPrice: client.get(r.id as string),
        images: (r.images as string[]) ?? [],
        options: ((r.options as ProductOption[] | undefined) ?? []).map((g) => ({
          id: g.id,
          name: g.name,
          values: g.values.map((v) => {
            const c = clientAdds.get(r.id as string)?.[v.id]
            const t = tradeAdds.get(r.id as string)?.[v.id]
            return { id: v.id, label: v.label, price: num(v.price), available: v.available !== false, clientPrice: c === undefined ? undefined : num(c), tradePrice: t === undefined ? undefined : num(t), ...(typeof v.image === 'string' && v.image ? { image: v.image } : {}) }
          }),
        })),
        specs: ((r.specs as ProductSpec[] | undefined) ?? []).map((x) => ({ label: String(x.label ?? ''), value: String(x.value ?? '') })),
        highlights: (r.highlights as string[] | undefined) ?? [],
        seoTitle: (r.seo_title as string | undefined) ?? '',
        metaDescription: (r.meta_description as string | undefined) ?? '',
        imageAlt: (r.image_alt as string[] | undefined) ?? [],
        videos: (r.videos as string[] | undefined) ?? [],
        gtin: (r.gtin as string | undefined) ?? '',
        compliance: (r.compliance as ProductCompliance | undefined) ?? {},
        status: r.status as Product['status'],
        stock: r.stock as Product['stock'],
        source: s
          ? {
              supplier: s.supplier as string,
              url: s.source_url as string,
              cost: s.cost === null ? undefined : num(s.cost),
              notes: s.notes as string,
              autoPrice: (s.auto_price as boolean | undefined) ?? true,
              trackStock: (s.track_stock as boolean | undefined) ?? true,
              outOfStockAs: (s.out_of_stock_as as ProductSource['outOfStockAs']) ?? 'out_of_stock',
              optionCosts: Object.fromEntries(Object.entries((s.option_costs as Record<string, number> | undefined) ?? {}).map(([k, v]) => [k, num(v)])),
              supplierStock: {
                status: ((s.stock_status as SupplierStock['status'] | undefined) ?? 'unknown'),
                qty: s.stock_qty === null || s.stock_qty === undefined ? undefined : num(s.stock_qty),
                price: s.supplier_price === null || s.supplier_price === undefined ? undefined : num(s.supplier_price),
                note: (s.stock_note as string | undefined) ?? '',
                checkedAt: opt(s.stock_checked_at as string | null | undefined),
                changedAt: opt(s.stock_changed_at as string | null | undefined),
              },
            }
          : undefined,
        createdBy: opt(r.created_by as string | null),
        createdAt: r.created_at as string,
      }
    })
}

const ordersFromRows = (orders: Row[], items: Row[], notes: Row[]): StoreOrder[] => {
  const noteFor = new Map(notes.map((r) => [r.id as string, r.notes as string]))
  const byOrder = new Map<string, OrderItem[]>()
  for (const i of items) {
    const list = byOrder.get(i.order_id as string) ?? []
    list.push({
      id: i.id as string,
      productId: opt(i.product_id as string | null),
      title: i.title as string,
      sku: i.sku as string,
      unitPrice: num(i.unit_price),
      qty: i.qty as number,
      options: (i.options as string | undefined) || undefined,
      ...(i.install ? { install: true } : {}),
    })
    byOrder.set(i.order_id as string, list)
  }
  return orders.sort(newestFirst('created_at')).map((r) => ({
    id: r.id as string,
    number: r.number as number,
    customerId: opt(r.customer_id as string | null),
    name: r.name as string,
    email: r.email as string,
    phone: r.phone as string,
    delivery: r.delivery as StoreOrder['delivery'],
    address: r.address as string,
    notes: r.notes as string,
    trade: r.trade as boolean,
    total: num(r.total),
    status: r.status as StoreOrder['status'],
    adminNotes: noteFor.get(r.id as string) ?? '',
    createdAt: r.created_at as string,
    items: (byOrder.get(r.id as string) ?? []).sort((a, b) => a.title.localeCompare(b.title)),
    deliveryFee: r.delivery_fee == null ? undefined : num(r.delivery_fee),
    deliveryNote: (r.delivery_note as string | undefined) || undefined,
    invoice: r.invoice_status
      ? {
          status: r.invoice_status as OrderInvoiceStatus,
          number: (r.invoice_number as string | undefined) ?? '',
          payLink: (r.pay_link as string | undefined) ?? '',
          error: (r.invoice_error as string | undefined) ?? '',
        }
      : undefined,
  }))
}

/** The rows of every table as the database returned them, plus the projects a trade is booked on. */
export interface RawData {
  tables: Record<TableName, Row[]>
  /** The `my_booked_projects` answer. */
  booked: Row[]
}

/** Reads the given tables (all of them by default). */
export async function fetchTables(db: DbAdapter, tables: readonly TableName[] = TABLES): Promise<Partial<Record<TableName, Row[]>>> {
  const rows = await Promise.all(tables.map((t) => db.select(t)))
  return Object.fromEntries(tables.map((t, n) => [t, rows[n]])) as Partial<Record<TableName, Row[]>>
}

/**
 * Projects a trade is booked on but isn't the project's own trade for: their tasks, diary, defects
 * and documents come with the tables, and this adds the project's name and address.
 */
export async function fetchBooked(db: DbAdapter): Promise<Row[]> {
  return ((await db.call?.('my_booked_projects')) ?? []) as Row[]
}

/** Reads everything the signed-in person is allowed to see, as rows. */
export async function fetchRaw(db: DbAdapter): Promise<RawData> {
  const [tables, booked] = await Promise.all([fetchTables(db), fetchBooked(db)])
  return { tables: tables as Record<TableName, Row[]>, booked }
}

/** Loads everything the signed-in person is allowed to see. */
export async function fetchAll(db: DbAdapter): Promise<AppData> {
  return assemble(await fetchRaw(db))
}

const ALL_PROJECT_CHILDREN: TableName[] = [
  'project_milestones',
  'project_expenses',
  'project_quote_items',
  'project_variations',
  'project_payments',
  'project_costs',
  'project_tasks',
  'project_diary',
  'project_defects',
  'project_documents',
]

/**
 * Tables whose visible rows can change when a row of the key table changes, though they get no
 * change event of their own (row-level security follows the parent: e.g. a trade assigned to a
 * project starts seeing its milestones, property and invoices).
 */
const ALSO_REFRESH: Partial<Record<TableName, TableName[]>> = {
  projects: [...ALL_PROJECT_CHILDREN, 'properties', 'invoices'],
  requests: ['properties', 'invoices'],
  // Being booked on a task or defect shows that project's tasks, diary, defects and documents
  // (and, through my_booked_projects, its name and address).
  project_tasks: ['project_tasks', 'project_defects', 'project_diary', 'project_documents', 'projects', 'properties'],
  project_defects: ['project_tasks', 'project_defects', 'project_diary', 'project_documents', 'projects', 'properties'],
  products: ['product_trade_prices', 'product_client_prices', 'product_sources', 'product_price_history'],
  orders: ['order_items', 'order_notes'],
}

/**
 * The tables to read again after change events on `changed` (table names from realtime payloads),
 * or 'all'. A change to a profile can change a person's role or permissions, and with them what
 * every table shows, so it reloads everything. Tables the app doesn't load are ignored.
 */
export function tablesToRefresh(changed: Iterable<string>): TableName[] | 'all' {
  const out = new Set<TableName>()
  for (const name of changed) {
    if (!(TABLES as readonly string[]).includes(name)) continue
    const t = name as TableName
    if (t === 'profiles') return 'all'
    out.add(t)
    for (const extra of ALSO_REFRESH[t] ?? []) out.add(extra)
  }
  return TABLES.filter((t) => out.has(t))
}

/** Builds the app's data from the rows. Leaves `raw` unchanged, so it can be kept and built again. */
export function assemble(raw: RawData): AppData {
  const t = raw.tables
  const projects = [...t.projects]
  const properties = [...t.properties]
  for (const b of raw.booked) {
    if (projects.some((p) => p.id === b.id)) continue
    const site = `site-${b.id as string}`
    projects.push({ id: b.id, number: b.number, title: b.title, status: b.status, client_id: '', property_id: site, description: '', type: 'renovation', budget: 0, scope_of_works: '', created_at: '' })
    properties.push({ id: site, client_id: '', address: b.address, suburb: b.suburb, postcode: b.postcode, paint_colors: { walls: '', trim: '', ceiling: '' }, skirt_profile: '', cladding_type: '', access_code: '', notes: '' })
  }
  const profiles = [...t.profiles]
  const requests = [...t.requests]
  const invoices = [...t.invoices]
  const inbox = [...t.inbox]
  const sms = [...t.sms_log]
  const settings = t.settings
  const priceHistory = [...t.product_price_history]
  const leads = [...t.leads]
  const texts = [...t.text_log]
  const quoteTemplates = [...t.quote_templates]
  const byProject = (rows: Row[]) => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      const list = m.get(r.project_id as string)
      if (list) list.push(r)
      else m.set(r.project_id as string, [r])
    }
    return m
  }
  const ms = byProject(t.project_milestones)
  const ex = byProject(t.project_expenses)
  const qi = byProject(t.project_quote_items)
  const va = byProject(t.project_variations)
  const pa = byProject(t.project_payments)
  const co = byProject(t.project_costs)
  const ta = byProject(t.project_tasks)
  const di = byProject(t.project_diary)
  const de = byProject(t.project_defects)
  const dc = byProject(t.project_documents)
  const s = settings[0] as { sms?: Partial<SmsSettings>; bank?: AppData['bank']; pricing?: Partial<Pricing> } | undefined
  return {
    version: DATA_VERSION,
    users: profiles.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(userFromRow),
    properties: properties.sort((a, b) => String(a.address).localeCompare(String(b.address))).map(propertyFromRow),
    requests: requests.sort(newestFirst('created_at')).map(requestFromRow),
    projects: projects.sort(newestFirst('created_at')).map((p) => {
      const id = p.id as string
      return projectFromRow(p, ms.get(id), ex.get(id), { items: qi.get(id), variations: va.get(id), payments: pa.get(id), costs: co.get(id), tasks: ta.get(id), diary: di.get(id), defects: de.get(id), documents: dc.get(id) })
    }),
    invoices: invoices.sort(newestFirst('created_at')).map(invoiceFromRow),
    sms: sms.sort(newestFirst('sent_at')).map(smsFromRow),
    inbox: inbox.sort(newestFirst('created_at')).map(inboxFromRow),
    smsSettings: { ...DEFAULT_SMS, ...(s?.sms ?? {}) },
    bank: s?.bank ?? { accountName: 'Next Phase Maintenance', bsb: '', accountNumber: '' },
    pricing: { ...DEFAULT_PRICING, ...(s?.pricing ?? {}) },
    priceHistory: priceHistory
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map((r) => ({
        id: r.id as string,
        productId: r.product_id as string,
        at: r.at as string,
        reason: r.reason as string,
        costBasis: r.cost_basis === null || r.cost_basis === undefined ? undefined : num(r.cost_basis),
        publicPrice: r.public_price === null || r.public_price === undefined ? undefined : num(r.public_price),
        clientPrice: r.client_price === null || r.client_price === undefined ? undefined : num(r.client_price),
        tradePrice: r.trade_price === null || r.trade_price === undefined ? undefined : num(r.trade_price),
        changedBy: opt(r.changed_by as string | null),
        options: ((r.options as Record<string, unknown>[] | undefined) ?? []).map((o) => ({
          option: String(o.option ?? ''),
          choice: String(o.choice ?? ''),
          cost: o.cost === null || o.cost === undefined ? undefined : num(o.cost),
          public: o.public === null || o.public === undefined ? undefined : num(o.public),
          client: o.client === null || o.client === undefined ? undefined : num(o.client),
          trade: o.trade === null || o.trade === undefined ? undefined : num(o.trade),
        })),
      })),
    products: productsFromRows([...t.products], t.product_trade_prices, t.product_sources, t.product_client_prices),
    orders: ordersFromRows([...t.orders], t.order_items, t.order_notes),
    leads: leads.sort(newestFirst('created_at')).map((r) => ({
      id: r.id as string,
      number: num(r.number),
      name: r.name as string,
      email: r.email as string,
      phone: r.phone as string,
      company: r.company as string,
      suburb: r.suburb as string,
      services: (r.services as string[]) ?? [],
      urgency: r.urgency as Lead['urgency'],
      contactBy: r.contact_by as Lead['contactBy'],
      message: r.message as string,
      photos: (r.photos as string[] | undefined) ?? [],
      status: r.status as Lead['status'],
      notes: r.notes as string,
      clientId: opt(r.client_id as string | null),
      source: opt(r.source as string | null),
      jobUrl: opt(r.job_url as string | null),
      createdAt: r.created_at as string,
    })),
    texts: texts.sort(newestFirst('opened_at')).map((r) => ({
      id: r.id as string,
      to: r.recipient_phone as string,
      message: r.message as string,
      event: r.trigger_event as string,
      openedBy: opt(r.opened_by as string | null),
      openedAt: r.opened_at as string,
    })),
    quoteTemplates: quoteTemplates
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((r) => ({
        id: r.id as string,
        name: r.name as string,
        items: (r.items as QuoteTemplate['items']) ?? [],
        inclusions: r.inclusions as string,
        exclusions: r.exclusions as string,
        createdAt: r.created_at as string,
      })),
  }
}

export function emptyData(): AppData {
  return {
    version: DATA_VERSION,
    users: [],
    properties: [],
    requests: [],
    projects: [],
    invoices: [],
    sms: [],
    inbox: [],
    smsSettings: DEFAULT_SMS,
    bank: { accountName: 'Next Phase Maintenance', bsb: '', accountNumber: '' },
    pricing: DEFAULT_PRICING,
    priceHistory: [],
    products: [],
    orders: [],
    leads: [],
    texts: [],
    quoteTemplates: [],
  }
}
