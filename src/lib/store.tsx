import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RealtimeChannel, Session } from '@supabase/supabase-js'
import type {
  OrderInvoiceStatus,
  QuickBooksStatus,
  OrderItem,
  AppData,
  DraftListing,
  QuoteDraft,
  QuoteLinkView,
  FoundProduct,
  InboxMessage,
  Lead,
  MaintenanceRequest,
  Permission,
  Product,
  Project,
  ProjectStatus,
  Property,
  Role,
  StoreOrder,
  SupplierStock,
  UserAccount,
} from './types'
import { BRAND, SITE_SERVICES } from './brand'
import { blankCommercials } from './quote'
import { deliveryName } from './storePolicy'
import { createSeed, DATA_VERSION } from './seed'
import { dispatchSms } from './sms'
import { generateInviteCode, money, sha256, uid } from './utils'
import { applyOps, assemble, diff, emptyData, fetchBooked, fetchTables, productsFromRows, TABLES, tablesToRefresh, type RawData, type TableName, profileRow, projectFromRow, propertyRow, requestFromRow, userFromRow } from './db'
import { ANON_KEY, CLOUD, DEMO, DEMO_BUILD, FUNCTIONS_URL, supabase, supabaseAdapter, uploadLeadPhoto, uploadPhoto } from './supabase'

const DATA_KEY = 'npm.data.v1'
const LOAD_ERROR = 'Couldn\'t load the latest data: '
const SESSION_KEY = 'npm.session.v1'
const ACTING_KEY = 'npm.actingAs.v1'

/**
 * In a dashboard an admin has opened for a client or trade, an action that person's own permission
 * would allow needs this admin permission instead (the same rule the database applies to admins).
 */
const ACTING_PERMISSION: Partial<Record<Permission, Permission>> = {
  canSubmitRequests: 'canDispatchJobs',
  canSubmitExpenses: 'canManageProjects',
}
const alwaysAllowed = () => true

function loadDemoData(): AppData {
  if (!DEMO_BUILD) return emptyData()
  try {
    const raw = localStorage.getItem(DATA_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AppData
      if (parsed.version === DATA_VERSION) return parsed
    }
  } catch {
    /* fall through to seed */
  }
  return createSeed()
}

function loadDemoSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

/** Where Supabase email links (invites, password resets) send people back to. */
const appUrl = () => window.location.origin + window.location.pathname

async function invokeFunction<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase!.functions.invoke(name, { body })
  if (error) {
    let message = error.message
    let code: string | undefined
    try {
      const ctx = (error as { context?: Response }).context
      const json = ctx ? await ctx.json() : null
      if (json?.error) message = json.error
      code = json?.code
    } catch {
      /* keep the generic message */
    }
    // `code` lets the screen react to a known case (e.g. the AI assistant isn't set up yet).
    throw Object.assign(new Error(message), { code })
  }
  return data as T
}

/**
 * Calls a server function that answers as lines of JSON while it works (the AI product finder):
 * progress lines go to `onProgress`, and the last line is the result or the error.
 */
async function streamFunction<T>(name: string, body: Record<string, unknown>, onProgress?: (text: string) => void, signal?: AbortSignal): Promise<T> {
  const { data: auth } = await supabase!.auth.getSession()
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: `Bearer ${auth.session?.access_token ?? ANON_KEY}` },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => null)
    throw Object.assign(new Error(json?.error ?? `The request failed (${res.status}). Try again.`), { code: json?.code })
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line) continue // keep-alive
      const msg = JSON.parse(line) as { type: string; text?: string; data?: T; error?: string; code?: string }
      if (msg.type === 'progress' && msg.text) onProgress?.(msg.text)
      else if (msg.type === 'result') return msg.data as T
      else if (msg.type === 'error') throw Object.assign(new Error(msg.error ?? 'Something went wrong.'), { code: msg.code })
    }
  }
  throw new Error('The assistant stopped before it finished. Try again.')
}

/** The quote link's answer as the app uses it. */
function linkView(r: Record<string, unknown>): QuoteLinkView {
  const d = (r.deposit ?? {}) as Record<string, unknown>
  return {
    number: Number(r.number),
    title: String(r.title ?? ''),
    client: String(r.client ?? ''),
    address: String(r.address ?? ''),
    scope: String(r.scope ?? ''),
    status: r.status as QuoteLinkView['status'],
    validUntil: (r.valid_until as string | null) ?? undefined,
    issuedAt: (r.issued_at as string | null) ?? undefined,
    answeredAt: (r.answered_at as string | null) ?? undefined,
    answeredName: String(r.answered_name ?? ''),
    items: ((r.items as Record<string, unknown>[]) ?? []).map((i) => ({ section: String(i.section ?? ''), description: String(i.description ?? ''), qty: Number(i.qty), unit: String(i.unit ?? ''), rate: Number(i.rate) })),
    inclusions: String(r.inclusions ?? ''),
    exclusions: String(r.exclusions ?? ''),
    total: Number(r.total),
    deposit: { status: (d.status as QuoteLinkView['deposit']['status']) ?? 'none', amount: d.amount == null ? undefined : Number(d.amount), number: (d.number as string | null) ?? undefined, payLink: String(d.pay_link ?? '') },
  }
}

/** Waits like a slow server call would, for demo mode; rejects if `signal` is aborted. */
function demoWait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(t)
      reject(new DOMException('Stopped', 'AbortError'))
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
  })
}

/** A plain picture for demo results (live mode shows the supplier's photo). */
const demoPhoto = (label: string, hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="hsl(${hue},25%,92%)"/><rect x="120" y="70" width="160" height="160" rx="12" fill="hsl(${hue},25%,70%)"/><text x="200" y="275" font-family="sans-serif" font-size="18" text-anchor="middle" fill="#334155">${label}</text></svg>`,
  )}`

type AuthResult = { error?: string; role?: Role }
type NewRequest = Omit<MaintenanceRequest, 'id' | 'number' | 'createdAt' | 'status' | 'smsNotified' | 'completionPhotos' | 'notes'>
type InboxDraft = Omit<InboxMessage, 'id' | 'createdAt' | 'read' | 'acknowledged'>

/** A store order as the checkout sends it; prices are worked out by the database. */
/** An order just placed: enough for the confirmation screen to show its invoice. */
export interface PlacedOrder {
  id: string
  number: number
  total: number
  email: string
  /** The number of the quote request made for the items to install, if any. */
  installQuote?: number
  /** How it's to be delivered: delivery orders are invoiced once the office confirms the delivery cost and date. */
  delivery: StoreOrder['delivery']
}

export interface OrderInput {
  /** options: option id → value id, one for each of the product's options. */
  items: { productId: string; qty: number; options?: Record<string, string>; install?: boolean }[]
  name: string
  email: string
  phone: string
  delivery: StoreOrder['delivery']
  address: string
  notes: string
}

/** An enquiry from the website's quote form. */
export type LeadInput = Pick<Lead, 'name' | 'email' | 'phone' | 'company' | 'suburb' | 'urgency' | 'contactBy' | 'message'> & {
  /** One of the services on the website. */
  service: string
  /** Photos of the job, as image data URLs. */
  photos: string[]
}

/** A project an admin sets up, optionally with a new client (added without a login) and property. */
export interface NewProject {
  newClient?: UserAccount
  newProperty?: Property
  project: Pick<
    Project,
    'clientId' | 'propertyId' | 'title' | 'description' | 'type' | 'budget' | 'quoteAmount' | 'scopeOfWorks' | 'status' | 'assignedProviderId'
  >
}

/**
 * - `loading`: checking the session or loading data (cloud mode)
 * - `set-password`: arrived from an invite or reset email and must choose a password
 * - `two-step`: an admin signed in with their password must enter a code from their authenticator
 *   app (or set one up first); until then the database gives them no admin access
 * - `ready`: normal operation (signed in or not)
 */
export type Phase = 'loading' | 'set-password' | 'two-step' | 'ready'

/** Setting up an authenticator app: the QR code to scan, and the key to type in instead. */
export interface TwoStepSetup {
  factorId: string
  qr: string
  secret: string
}

interface StoreValue {
  /** True when connected to Supabase; false in single-browser demo mode. */
  cloud: boolean
  phase: Phase
  /** In the two-step phase: whether to set up an authenticator app first, or just enter a code. */
  twoStep: 'set-up' | 'code' | null
  /** The signed-in login's email, while it's not ready yet (the two-step screen shows it). */
  cloudUserEmail?: string
  startTwoStepSetup: () => Promise<TwoStepSetup>
  /** Checks the code (from the app just set up, or the one already set up); then the portal loads. */
  confirmTwoStep: (code: string, factorId?: string) => Promise<string | null>
  data: AppData
  user: UserAccount | null
  /** Problem saving or loading, shown as a banner. */
  syncError: string | null
  /** Message for the signed-out home page, e.g. after a suspended account is signed out. */
  authNotice: string | null
  /**
   * Who is really signed in. The same as `user`, except inside a dashboard an admin has opened for
   * someone else: there `user` is that client or trade and `actor` is the admin. Name `actor` in
   * anything that records who did something.
   */
  actor: UserAccount | null
  /** The client or trade whose dashboard the signed-in admin has open, if any. */
  actingAs: UserAccount | null
  /** Admins: open a client's or trade's dashboard, or leave it. */
  startActingAs: (id: string) => void
  stopActingAs: () => void
  /**
   * For actions in a client or trade portal that their owner may always take: true for the owner, and
   * in a dashboard an admin has opened, whether the admin holds the permission the database requires
   * of admins for it.
   */
  canAct: (adminPermission: Permission) => boolean
  /** Apply a mutation to a copy of the data and save it. Keep side effects out of `fn`. */
  update: (fn: (draft: AppData) => void) => void
  can: (p: Permission) => boolean
  login: (email: string, password: string) => Promise<AuthResult>
  /** Demo mode: activate an invite with its code. */
  acceptInvite: (email: string, code: string, password: string) => Promise<AuthResult>
  /** Cloud mode: email a password reset / setup link. */
  sendPasswordEmail: (email: string) => Promise<string | null>
  /** Cloud mode: finish an invite or reset by choosing a password. */
  setNewPassword: (password: string) => Promise<AuthResult>
  /** Cloud mode: sign in with a link made by "Create invite link" / "Create password link"; returns an error or null. */
  acceptLink: (tokenHash: string, type: string) => Promise<string | null>
  logout: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<string | null>
  /** SMS every admin recipient (admin only in cloud mode). */
  notifyAdmins: (message: string, triggerEvent: string) => Promise<void>
  /** SMS one number (admin only in cloud mode). */
  sendSms: (to: string, message: string, triggerEvent: string) => Promise<void>
  submitRequest: (req: NewRequest) => Promise<MaintenanceRequest>
  requestQuote: (q: { clientId: string; propertyId: string; title: string; description: string; budget: number }) => Promise<void>
  assignRequest: (requestId: string, providerId: string, scheduledDate: string, sms: boolean) => Promise<void>
  /** Published products for the public shop (visitors aren't signed in, so they don't have `data`). */
  loadCatalog: () => Promise<Product[]>
  /** Places a store order for anyone; throws with a message the customer can act on. */
  placeOrder: (o: OrderInput) => Promise<PlacedOrder>
  /** Anyone, signed in or not: send a maintenance request (with photos) to the office. */
  submitLead: (l: LeadInput) => Promise<{ number: number }>
  leadPhotoUrls: (paths: string[]) => Promise<string[]>
  /** Stores a project document's file (live: the private project-docs bucket; demo: in the browser). */
  uploadProjectFile: (projectId: string, file: File) => Promise<{ path: string; sizeBytes: number; contentType: string }>
  /** A link to open a project document (live: a short-lived signed link). */
  projectFileUrl: (path: string) => Promise<string>
  /** Removes a project document and its file. */
  deleteProjectDocument: (projectId: string, documentId: string) => void
  /** Records that a text was opened in Messages on this device (who and when are set by the database). */
  logText: (to: string, message: string, event: string) => void
  deleteLead: (id: string) => void
  /**
   * Store managers: the AI assistant searches the web for products (sample results in demo mode).
   * `onProgress` hears what it's doing as it goes; aborting `signal` stops it.
   */
  findProducts: (query: string, onProgress?: (text: string) => void, signal?: AbortSignal) => Promise<{ products: FoundProduct[]; note: string }>
  /** Store managers: the AI assistant drafts a listing from a found product, for review. */
  draftListing: (product: FoundProduct, instructions?: string, onProgress?: (text: string) => void, signal?: AbortSignal) => Promise<DraftListing>
  /** A quote from its private link (null if the link isn't valid); for clients without a login. */
  quoteByToken: (token: string) => Promise<QuoteLinkView | null>
  /** The client accepts (with their name) or declines from the link. */
  answerQuoteByToken: (token: string, accept: boolean, name: string) => Promise<QuoteLinkView>
  /** The office sends a failed (or skipped) quote estimate to QuickBooks again. */
  retryQuoteEstimate: (projectId: string) => Promise<void>
  /** The office sends (again) an accepted quote's deposit invoice. */
  sendQuoteDeposit: (projectId: string) => Promise<void>
  /**
   * Deletes a quote (not a job under way, and never one with money paid against it). Its QuickBooks
   * estimate is deleted and any unpaid deposit invoice voided there, by the server shortly after.
   */
  deleteQuote: (projectId: string) => Promise<{ estimates: number; invoices: number }>
  /** The AI quote drafter: an itemised draft for the quote, from its request, site notes and photos. */
  draftQuote: (p: Pick<Project, 'id' | 'title' | 'description' | 'scopeOfWorks'>, notes: string, onProgress?: (text: string) => void, signal?: AbortSignal) => Promise<QuoteDraft>
  /** New photos of the product on a supplier page, made by AI from the supplier's photos (store managers). */
  /** New photos of a product from the supplier's; `colours` (its colour or finish choices) each get a studio shot. */
  recreatePhotos: (
    url: string,
    title: string,
    photos: string[],
    onProgress?: (text: string) => void,
    signal?: AbortSignal,
    colours?: string[],
  ) => Promise<{ images: string[]; references: string[]; colourImages?: Record<string, string>; colourErrors?: string[] }>
  /** One new studio photo of a product in one of its colours or finishes; returns its link. */
  colourPhoto: (url: string, title: string, colour: string, photos: string[], onProgress?: (text: string) => void, signal?: AbortSignal) => Promise<string>
  /**
   * What a supplier's page says about stock now. With a product id, the reading is saved (and the
   * listing switched if it ran out or came back); with a link, it's only read.
   */
  checkSupplierStock: (target: { productId: string } | { url: string }) => Promise<SupplierStock>
  /** QuickBooks: whether it's connected; the sign-in address to connect; disconnect; retry an order's invoice. */
  quickBooksStatus: () => Promise<QuickBooksStatus>
  connectQuickBooks: () => Promise<string>
  disconnectQuickBooks: () => Promise<void>
  setQuickBooksLimits: (dailyLimit: number, maxTotal: number) => Promise<void>
  retryInvoice: (orderId: string) => Promise<void>
  /** Confirms a delivery order's delivery cost (inc. GST) and date, and approves its invoice (which includes them). */
  confirmDelivery: (orderId: string, fee: number, note: string) => Promise<void>
  /** A just-placed order's invoice (its number and pay link), for the confirmation screen. */
  orderInvoice: (orderId: string, email: string) => Promise<{ status: OrderInvoiceStatus; number: string; payLink: string } | null>
  /** Admins: create a project, with its client and property if they're new. Throws with a message if it can't be saved. */
  createProject: (p: NewProject) => Promise<Project>
  /** Message one person's inbox (admins). */
  pushInbox: (msg: InboxDraft) => void
  /** Message every admin's inbox (anyone signed in). */
  pushAdminInbox: (title: string, body: string, refs?: { requestId?: string; projectId?: string }) => Promise<void>
  /** Stores a photo and returns the URL (cloud) or the data URL itself (demo). */
  uploadImage: (dataUrl: string) => Promise<string>
  /**
   * Creates an invited account. Demo mode returns the invite code; cloud mode emails an invite
   * link, or with delivery 'link' returns it for the admin to send.
   */
  inviteAccount: (account: UserAccount, delivery?: 'email' | 'link') => Promise<{ error?: string; code?: string; link?: string }>
  /** Cloud mode: a fresh sign-in link for an existing account (new invite link, or password link). */
  getSignInLink: (profileId: string) => Promise<{ error?: string; link?: string }>
  deleteAccount: (id: string) => Promise<string | null>
  resetDemoData: () => void
}

const StoreContext = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setDataState] = useState<AppData>(() => (CLOUD ? emptyData() : loadDemoData()))
  const [demoSessionId, setDemoSessionId] = useState<string | null>(() => (CLOUD ? null : loadDemoSession()))
  const [cloudProfile, setCloudProfile] = useState<UserAccount | null>(null)
  const [phase, setPhase] = useState<Phase>(CLOUD ? 'loading' : 'ready')
  const [twoStep, setTwoStep] = useState<'set-up' | 'code' | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [authNotice, setAuthNotice] = useState<string | null>(null)
  // Kept for this tab only, so a reload stays in the dashboard but a new tab starts as the admin.
  const [actingAsId, setActingAsId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(ACTING_KEY)
    } catch {
      return null
    }
  })

  const dataRef = useRef(data)
  const setData = useCallback((d: AppData) => {
    dataRef.current = d
    setDataState(d)
  }, [])

  // ───────────── demo-mode persistence ─────────────

  useEffect(() => {
    if (CLOUD) return
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(data))
      setSyncError(null)
    } catch {
      setSyncError('Browser storage is full — recent changes (often photos) could not be saved. Remove some photos and try again.')
    }
  }, [data])

  useEffect(() => {
    if (CLOUD) return
    try {
      if (demoSessionId) localStorage.setItem(SESSION_KEY, demoSessionId)
      else localStorage.removeItem(SESSION_KEY)
    } catch {
      /* session simply won't persist */
    }
  }, [demoSessionId])

  useEffect(() => {
    try {
      if (actingAsId) sessionStorage.setItem(ACTING_KEY, actingAsId)
      else sessionStorage.removeItem(ACTING_KEY)
    } catch {
      /* the dashboard simply won't survive a reload */
    }
  }, [actingAsId])

  // ───────────── cloud sync ─────────────

  const db = useMemo(() => (supabase ? supabaseAdapter(supabase) : null), [])
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const localVersion = useRef(0)
  const refreshWanted = useRef(false)
  const signedInAs = useRef<string | null>(null)
  const refreshGeneration = useRef(0)
  /** Changes with each sign-in and sign-out, so a load started for one session never lands in another. */
  const sessionEpoch = useRef(0)
  /** The rows last read from each table; a change event reads only its tables again and rebuilds from these. */
  const raw = useRef<RawData | null>(null)
  /** Per table (and the booked projects), the generation of the refresh whose rows `raw` holds. */
  const appliedGeneration = useRef<Partial<Record<TableName | 'booked', number>>>({})
  /** Tables whose refresh was dropped (the person changed something meanwhile), to read again. */
  const dirty = useRef<Set<TableName> | 'all'>(new Set())
  /** The last failed save's message and tables: only a later save to one of those tables clears it. */
  const saveFailure = useRef<{ message: string; tables: Set<TableName> } | null>(null)

  const markDirty = useCallback((tables: readonly TableName[] | 'all') => {
    if (tables === 'all' || dirty.current === 'all') dirty.current = 'all'
    else for (const t of tables) dirty.current.add(t)
  }, [])

  /** Takes the tables waiting to be read again: undefined for all of them. */
  const takeDirty = useCallback((): TableName[] | undefined => {
    const d = dirty.current
    dirty.current = new Set()
    return d === 'all' ? undefined : TABLES.filter((t) => d.has(t))
  }, [])

  /** Clears the cached rows, e.g. on sign-out, so the next load reads everything. */
  const resetCache = useCallback(() => {
    sessionEpoch.current++
    raw.current = null
    appliedGeneration.current = {}
    dirty.current = new Set()
    refreshWanted.current = false
  }, [])

  /**
   * Reads the given tables again (all of them by default, or when nothing is loaded yet) and rebuilds
   * the data from the newest rows of every table.
   */
  const refresh = useCallback(
    async (tables?: readonly TableName[]): Promise<void> => {
      if (!db || !signedInAs.current) return
      const want: readonly TableName[] | 'all' = tables && raw.current ? tables : 'all'
      if (want !== 'all' && want.length === 0) return
      if (pending.current > 0) {
        markDirty(want)
        refreshWanted.current = true
        return
      }
      const startedAt = localVersion.current
      const epoch = sessionEpoch.current
      // Realtime changes can start a second refresh before the first returns. Each table keeps the
      // rows of the newest refresh that has landed for it, so an older, slower one never puts stale
      // rows back, while its other tables still land.
      const generation = ++refreshGeneration.current
      const list = want === 'all' ? TABLES : want
      try {
        // The booked projects are worked out from projects, tasks and defects; it's one cheap call, so
        // it's read with every refresh.
        const [rows, booked] = await Promise.all([fetchTables(db, list), fetchBooked(db)])
        if (epoch !== sessionEpoch.current) return
        // Drop the result if the person changed something while it was loading; it runs again once
        // the change is saved (or straight away if nothing is waiting to save).
        if (startedAt !== localVersion.current || pending.current > 0) {
          markDirty(want)
          if (pending.current > 0) refreshWanted.current = true
          else void refresh(takeDirty())
          return
        }
        const base: RawData = raw.current ?? { tables: {} as RawData['tables'], booked: [] }
        const next: RawData = { tables: { ...base.tables }, booked: base.booked }
        const applied = appliedGeneration.current
        for (const t of list) {
          if ((applied[t] ?? 0) > generation) continue
          next.tables[t] = rows[t] ?? []
          applied[t] = generation
        }
        if ((applied.booked ?? 0) <= generation) {
          next.booked = booked
          applied.booked = generation
        }
        // Nothing to build until every table has landed once.
        if (TABLES.some((t) => !next.tables[t])) return
        raw.current = next
        setData(assemble(next))
        setSyncError((cur) => (cur?.startsWith(LOAD_ERROR) ? null : cur))
      } catch (e) {
        if (epoch !== sessionEpoch.current) return
        // Read again next time.
        markDirty(want)
        setSyncError(`${LOAD_ERROR}${(e as Error).message}`)
      }
    },
    [db, setData, markDirty, takeDirty],
  )

  /** Saves the difference; resolves true once saved (or if there was nothing to save), false if it failed. */
  const enqueueSave = useCallback(
    (prev: AppData, next: AppData): Promise<boolean> => {
      if (!db) return Promise.resolve(true)
      const ops = diff(prev, next)
      if (ops.length === 0) return Promise.resolve(true)
      pending.current++
      let saved = false
      const tables = new Set(ops.map((o) => o.table))
      queue.current = queue.current
        .then(() => applyOps(db, ops))
        .then(() => {
          saved = true
          // A failed save stays on screen until the same kind of change saves; other messages clear.
          const failed = saveFailure.current
          if (failed && ![...tables].some((t) => failed.tables.has(t))) return
          saveFailure.current = null
          setSyncError(null)
        })
        .catch((e: Error) => {
          const message = `Not saved — ${e.message}`
          saveFailure.current = { message, tables }
          setSyncError(message)
          // Put back what the server really has.
          markDirty('all')
          refreshWanted.current = true
        })
        .finally(() => {
          pending.current--
          if (pending.current === 0 && refreshWanted.current) {
            refreshWanted.current = false
            void refresh(takeDirty())
          }
        })
      return queue.current.then(() => saved)
    },
    [db, refresh, markDirty, takeDirty],
  )

  /** Like `update`, resolving once the change is saved (true) or the save failed (false). */
  const updateAndSave = useCallback(
    (fn: (draft: AppData) => void): Promise<boolean> => {
      const prev = dataRef.current
      const next = structuredClone(prev)
      fn(next)
      localVersion.current++
      setData(next)
      return CLOUD ? enqueueSave(prev, next) : Promise.resolve(true)
    },
    [setData, enqueueSave],
  )

  const update = useCallback(
    (fn: (draft: AppData) => void) => {
      void updateAndSave(fn)
    },
    [updateAndSave],
  )

  /** Adds rows the server already created (e.g. a just-inserted request) without re-saving them. */
  const mergeLocal = useCallback(
    (fn: (draft: AppData) => void) => {
      const next = structuredClone(dataRef.current)
      fn(next)
      localVersion.current++
      setData(next)
    },
    [setData],
  )

  // ───────────── cloud auth ─────────────

  const recovering = useRef(false)
  const loadSession = useRef<(session: Session | null) => Promise<void>>(async () => {})

  useEffect(() => {
    if (!supabase) return
    const client = supabase
    let channel: RealtimeChannel | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    /** Tables named by change events in the current debounce window. */
    let changed = new Set<string>()
    /** Each load takes the next number; one that sees a newer number after an await stops there. */
    let loadSeq = 0
    /** The login a load is under way for, if any. */
    let loadingFor: string | null = null

    const removeChannel = () => {
      clearTimeout(timer)
      changed = new Set()
      if (channel) void client.removeChannel(channel)
      channel = null
    }

    const teardown = () => {
      removeChannel()
      signedInAs.current = null
      resetCache()
    }

    const load = async (session: Session | null) => {
      if (!session) {
        loadSeq++
        loadingFor = null
        recovering.current = false
        teardown()
        setCloudProfile(null)
        setData(emptyData())
        setPhase('ready')
        return
      }
      const id = session.user.id
      if (!recovering.current) {
        // The same login signed in twice (e.g. the first session and then SIGNED_IN): the load under
        // way finishes and sets the phase.
        if (loadingFor === id) return
        if (signedInAs.current === id) {
          setPhase('ready')
          return
        }
      }
      const seq = ++loadSeq
      loadingFor = id
      const stale = () => seq !== loadSeq
      const finish = () => {
        if (!stale()) loadingFor = null
      }
      setPhase('loading')
      const { data: rows, error } = await client.from('profiles').select('*').eq('auth_id', id)
      if (stale()) return
      const row = rows?.[0]
      if (error || !row || row.status === 'suspended') {
        setAuthNotice(
          error
            ? `Couldn't load your account: ${error.message}`
            : !row
              ? "This login isn't linked to a Next Phase Maintenance account."
              : 'This account is suspended. Contact Next Phase Maintenance.',
        )
        finish()
        await client.auth.signOut()
        return
      }
      const profile = userFromRow(row)
      setCloudProfile(profile)
      if (profile.status === 'invited' || recovering.current) {
        setPhase('set-password')
        finish()
        return
      }
      // Admins need the second step before the database gives them anything.
      if (profile.role === 'admin') {
        const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel()
        if (stale()) return
        if (aal?.currentLevel !== 'aal2') {
          teardown()
          setData(emptyData())
          setTwoStep(aal?.nextLevel === 'aal2' ? 'code' : 'set-up')
          setPhase('two-step')
          finish()
          return
        }
      }
      setTwoStep(null)
      teardown()
      signedInAs.current = id
      setAuthNotice(null)
      await refresh()
      if (stale()) return
      // Only ever one subscription, even if an earlier load got this far.
      removeChannel()
      channel = client
        .channel('npm-db')
        .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
          // Read again only the tables that changed (and those whose visible rows follow them).
          changed.add(payload.table)
          clearTimeout(timer)
          timer = setTimeout(() => {
            const tables = tablesToRefresh(changed)
            changed = new Set()
            if (tables === 'all') void refresh()
            else void refresh(tables)
          }, 400)
        })
        .subscribe()
      setPhase('ready')
      finish()
    }

    loadSession.current = load
    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') recovering.current = true
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return
      // Supabase advises against awaiting its own calls inside this callback.
      setTimeout(() => void load(session), 0)
    })
    return () => {
      sub.subscription.unsubscribe()
      loadSeq++
      teardown()
    }
  }, [refresh, setData, resetCache])

  const startTwoStepSetup = useCallback(async (): Promise<TwoStepSetup> => {
    if (!supabase) throw new Error('Two-step sign-in is for the live portal.')
    // A half-finished set-up from before is cleared first (each new one has its own QR code).
    const { data: list } = await supabase.auth.mfa.listFactors()
    for (const f of list?.all ?? []) if (f.factor_type === 'totp' && f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id })
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 16)}`, issuer: 'Next Phase Maintenance' })
    if (error || !data) throw new Error(error?.message ?? 'Couldn’t start setting up the authenticator app.')
    return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret }
  }, [])

  const confirmTwoStep = useCallback(async (code: string, factorId?: string): Promise<string | null> => {
    if (!supabase) return null
    const digits = code.replace(/\s/g, '')
    if (!/^\d{6}$/.test(digits)) return 'Enter the 6-digit code from your authenticator app.'
    let id = factorId
    if (!id) {
      const { data: list } = await supabase.auth.mfa.listFactors()
      id = list?.totp[0]?.id
      if (!id) return 'No authenticator app is set up for this login.'
    }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: id, code: digits })
    if (error) return /invalid|expired/i.test(error.message) ? 'That code didn’t work. Check the time on your phone is set automatically, and enter the newest code.' : error.message
    // Signed in with both steps now: the auth listener loads the portal.
    setPhase('loading')
    return null
  }, [])

  // ───────────── identity ─────────────

  const user = useMemo(() => {
    if (CLOUD) {
      if (phase !== 'ready' || !cloudProfile) return null
      return data.users.find((u) => u.id === cloudProfile.id) ?? cloudProfile
    }
    const u = data.users.find((x) => x.id === demoSessionId)
    return u && u.status === 'active' ? u : null
  }, [data.users, demoSessionId, cloudProfile, phase])

  const can = useCallback((p: Permission) => !!user?.permissions.includes(p), [user])

  const actingAs = useMemo(
    () => (user?.role === 'admin' && actingAsId ? data.users.find((u) => u.id === actingAsId && u.role !== 'admin') ?? null : null),
    [user, actingAsId, data.users],
  )
  const startActingAs = useCallback((id: string) => setActingAsId(id), [])
  const stopActingAs = useCallback(() => setActingAsId(null), [])

  const login = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    if (supabase) {
      const { data: res, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (error) return { error: error.message === 'Invalid login credentials' ? 'Incorrect email or password.' : error.message }
      const { data: rows } = await supabase.from('profiles').select('role,status').eq('auth_id', res.user.id)
      const row = rows?.[0]
      if (!row) return { error: "This login isn't linked to a Next Phase Maintenance account." }
      if (row.status === 'suspended') return { error: 'This account is suspended. Contact Next Phase Maintenance.' }
      // The auth listener loads the data and sets the phase. Portal routes are held until it's ready,
      // but a phase it has already moved on to (two-step, set-password, ready) is left alone.
      setPhase((p) => (p === 'ready' && signedInAs.current !== res.user.id ? 'loading' : p))
      return { role: row.role as Role }
    }
    const u = dataRef.current.users.find((x) => x.email.toLowerCase() === email.trim().toLowerCase())
    if (!u) return { error: 'No account found for that email. Accounts are invite-only.' }
    if (u.status === 'invited') return { error: 'This account has a pending invite. Use “I have an invite code” to set your password.' }
    if (u.status === 'suspended') return { error: 'This account is suspended. Contact Next Phase Maintenance.' }
    if ((await sha256(password)) !== u.passwordHash) return { error: 'Incorrect password.' }
    setDemoSessionId(u.id)
    return { role: u.role }
  }, [])

  const acceptInvite = useCallback(
    async (email: string, code: string, password: string): Promise<AuthResult> => {
      const u = dataRef.current.users.find((x) => x.email.toLowerCase() === email.trim().toLowerCase())
      if (!u || u.status !== 'invited' || !u.inviteCode) return { error: 'No pending invite for that email.' }
      if (u.inviteCode.toUpperCase() !== code.trim().toUpperCase()) return { error: 'Invite code does not match.' }
      if (password.length < 8) return { error: 'Password must be at least 8 characters.' }
      const hash = await sha256(password)
      update((d) => {
        const target = d.users.find((x) => x.id === u.id)!
        target.passwordHash = hash
        target.status = 'active'
        delete target.inviteCode
      })
      setDemoSessionId(u.id)
      return { role: u.role }
    },
    [update],
  )

  const sendPasswordEmail = useCallback(async (email: string) => {
    if (!supabase) return 'Not available in demo mode.'
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: appUrl() })
    return error ? error.message : null
  }, [])

  const acceptLink = useCallback(async (tokenHash: string, type: string) => {
    if (!supabase) return 'Not available in demo mode.'
    if (!tokenHash || (type !== 'invite' && type !== 'recovery')) return 'This link is not valid.'
    setAuthNotice(null)
    // Every link an admin sends ends at "Choose your password", whichever kind of token it carries.
    recovering.current = true
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (!error) return null
    recovering.current = false
    return error.status === 403 || error.code === 'otp_expired'
      ? 'This link has expired or has already been used. Ask Next Phase Maintenance for a new one.'
      : "Couldn't check your link. Check your connection and press Continue again."
  }, [])

  const setNewPassword = useCallback(
    async (password: string): Promise<AuthResult> => {
      if (!supabase) return { error: 'Not available in demo mode.' }
      if (password.length < 8) return { error: 'Password must be at least 8 characters.' }
      const { data: s } = await supabase.auth.getSession()
      if (!s.session) return { error: 'Your link has expired. Ask for a new one from Sign in → Forgot password.' }
      const { error } = await supabase.auth.updateUser({ password })
      if (error) return { error: error.message }
      const { error: rpcError } = await supabase.rpc('activate_my_account')
      if (rpcError) return { error: rpcError.message }
      recovering.current = false
      signedInAs.current = null
      // Run the normal signed-in load now that the account is active.
      await loadSession.current(s.session)
      return { role: cloudProfile?.role }
    },
    [cloudProfile],
  )

  const logout = useCallback(async () => {
    setActingAsId(null)
    if (supabase) {
      await supabase.auth.signOut()
      return
    }
    setDemoSessionId(null)
  }, [])

  const changePassword = useCallback(
    async (current: string, next: string) => {
      if (next.length < 8) return 'New password must be at least 8 characters.'
      if (supabase) {
        if (!user) return 'Not signed in.'
        const { error: authError } = await supabase.auth.signInWithPassword({ email: user.email, password: current })
        if (authError) return 'Current password is incorrect.'
        const { error } = await supabase.auth.updateUser({ password: next })
        return error ? error.message : null
      }
      const u = dataRef.current.users.find((x) => x.id === demoSessionId)
      if (!u) return 'Not signed in.'
      if ((await sha256(current)) !== u.passwordHash) return 'Current password is incorrect.'
      const hash = await sha256(next)
      update((d) => {
        d.users.find((x) => x.id === u.id)!.passwordHash = hash
      })
      return null
    },
    [demoSessionId, update, user],
  )

  // ───────────── SMS ─────────────

  const reportError = useCallback((e: unknown) => setSyncError((e as Error).message), [])

  const sendSms = useCallback(
    async (to: string, message: string, triggerEvent: string) => {
      if (supabase) {
        await invokeFunction('send-sms', { kind: 'direct', to, message, event: triggerEvent }).catch(reportError)
        return
      }
      const entry = await dispatchSms(dataRef.current.smsSettings, to, message, triggerEvent)
      update((d) => {
        d.sms.unshift(entry)
      })
    },
    [update, reportError],
  )

  const notifyAdmins = useCallback(
    async (message: string, triggerEvent: string) => {
      if (supabase) {
        await invokeFunction('send-sms', { kind: 'admins', message, event: triggerEvent }).catch(reportError)
        return
      }
      const recipients = dataRef.current.smsSettings.recipients.filter(Boolean)
      if (recipients.length === 0) {
        await sendSms('(no admin numbers set)', message, triggerEvent)
        return
      }
      await Promise.all(recipients.map((r) => sendSms(r, message, triggerEvent)))
    },
    [sendSms, reportError],
  )

  // ───────────── inbox ─────────────

  const pushInbox = useCallback(
    (msg: InboxDraft) => {
      update((d) => {
        d.inbox.unshift({ ...msg, id: uid('n'), createdAt: new Date().toISOString(), read: false, acknowledged: false })
      })
    },
    [update],
  )

  const pushAdminInbox = useCallback(
    async (title: string, body: string, refs: { requestId?: string; projectId?: string } = {}) => {
      if (supabase) {
        const { error } = await supabase.rpc('notify_admins', {
          p_title: title,
          p_body: body,
          p_request_id: refs.requestId ?? null,
          p_project_id: refs.projectId ?? null,
        })
        if (error) setSyncError(error.message)
        return
      }
      update((d) => {
        for (const a of d.users.filter((u) => u.role === 'admin' && u.status === 'active')) {
          d.inbox.unshift({ id: uid('n'), userId: a.id, title, body, createdAt: new Date().toISOString(), read: false, requiresAck: false, acknowledged: false, ...refs })
        }
      })
    },
    [update],
  )

  // ───────────── workflows ─────────────

  const submitRequest = useCallback(
    async (input: NewRequest): Promise<MaintenanceRequest> => {
      if (supabase) {
        const { data: row, error } = await supabase
          .from('requests')
          .insert({
            client_id: input.clientId,
            property_id: input.propertyId,
            title: input.title,
            description: input.description,
            category: input.category,
            urgency: input.urgency,
            photos: input.photos,
          })
          .select()
          .single()
        if (error) throw new Error(error.message)
        const req = requestFromRow(row)
        mergeLocal((d) => {
          d.requests.unshift(req)
        })
        // The server decides whether to SMS based on the admin's trigger settings.
        await invokeFunction('send-sms', { kind: 'new_request', requestId: req.id }).catch(reportError)
        return req
      }
      const d0 = dataRef.current
      const number = Math.max(1000, ...d0.requests.map((r) => r.number)) + 1
      const settings = d0.smsSettings
      const shouldSms = settings.notifyOnNewRequest && (!settings.notifyOnUrgentOnly || input.urgency === 'urgent')
      const req: MaintenanceRequest = {
        ...input,
        id: uid('r'),
        number,
        createdAt: new Date().toISOString(),
        status: 'pending',
        smsNotified: shouldSms,
        completionPhotos: [],
        notes: '',
        createdBy: user?.id,
      }
      update((d) => {
        d.requests.unshift(req)
      })
      if (shouldSms) {
        const prop = d0.properties.find((p) => p.id === input.propertyId)
        const where = prop ? ` · ${prop.address}, ${prop.suburb}` : ''
        await notifyAdmins(`NPM #${number}${input.urgency === 'urgent' ? ' URGENT' : ''} — ${input.title}${where} (${input.category})`, 'New maintenance request')
      }
      return req
    },
    [update, mergeLocal, notifyAdmins, reportError, user],
  )

  /** The client's name, or "Admin for Client" when an admin did it from the client's dashboard. */
  const requester = useCallback(
    (clientId: string) => {
      const client = dataRef.current.users.find((u) => u.id === clientId)
      const name = client?.name ?? 'Client'
      return user && user.id !== clientId ? `${user.name} for ${name}` : name
    },
    [user],
  )

  const requestQuote = useCallback(
    async (q: { clientId: string; propertyId: string; title: string; description: string; budget: number }) => {
      if (supabase) {
        const { data: row, error } = await supabase
          .from('projects')
          .insert({ client_id: q.clientId, property_id: q.propertyId, title: q.title, description: q.description, budget: q.budget })
          .select()
          .single()
        if (error) throw new Error(error.message)
        const project: Project = projectFromRow(row)
        mergeLocal((d) => {
          d.projects.unshift(project)
        })
        await pushAdminInbox(`Quote request P-${project.number}`, `${requester(q.clientId)}: ${q.title}`, { projectId: project.id })
        await invokeFunction('send-sms', { kind: 'quote_request', projectId: project.id }).catch(reportError)
        return
      }
      const d0 = dataRef.current
      const number = Math.max(200, ...d0.projects.map((p) => p.number)) + 1
      const id = uid('pr')
      update((d) => {
        d.projects.unshift({
          ...blankCommercials(),
          id,
          number,
          clientId: q.clientId,
          propertyId: q.propertyId,
          title: q.title,
          description: q.description,
          type: 'renovation',
          budget: q.budget,
          scopeOfWorks: '',
          status: 'quote_requested',
          milestones: [],
          expenses: [],
          createdAt: new Date().toISOString(),
          createdBy: user?.id,
        })
      })
      await pushAdminInbox(`Quote request P-${number}`, `${requester(q.clientId)}: ${q.title}`, { projectId: id })
      await notifyAdmins(`NPM quote request P-${number} — ${q.title} (${requester(q.clientId)})`, 'Renovation quote request')
    },
    [update, mergeLocal, pushAdminInbox, notifyAdmins, reportError, requester, user],
  )

  const assignRequest = useCallback(
    async (requestId: string, providerId: string, scheduledDate: string, sms: boolean) => {
      const d0 = dataRef.current
      const req = d0.requests.find((r) => r.id === requestId)
      const provider = d0.users.find((u) => u.id === providerId)
      if (!req || !provider) return
      const prop = d0.properties.find((p) => p.id === req.propertyId)
      const where = prop ? `${prop.address}, ${prop.suburb}` : ''
      update((d) => {
        const r = d.requests.find((x) => x.id === requestId)!
        r.assignedProviderId = providerId
        r.scheduledDate = scheduledDate || undefined
        if (r.status === 'pending') r.status = 'assigned'
        d.inbox.unshift({
          id: uid('n'),
          userId: providerId,
          title: `New work order #${req.number}`,
          body: `${req.title} — ${where}${scheduledDate ? `. Scheduled ${scheduledDate}` : ''}. Please acknowledge.`,
          createdAt: new Date().toISOString(),
          read: false,
          requiresAck: true,
          acknowledged: false,
          requestId,
        })
      })
      if (sms && provider.phone) {
        await sendSms(
          provider.phone,
          `Next Phase Maintenance: work order #${req.number} assigned — ${req.title}, ${where}${scheduledDate ? ` on ${scheduledDate}` : ''}.`,
          'Provider assignment',
        )
      }
    },
    [update, sendSms],
  )

  const createProject = useCallback(
    async ({ newClient, newProperty, project: p }: NewProject): Promise<Project> => {
      // A client or property already saved by an earlier attempt (that failed later on) isn't added again.
      const d0 = dataRef.current
      const client = newClient && !d0.users.some((u) => u.id === newClient.id) ? newClient : undefined
      const property = newProperty && !d0.properties.some((x) => x.id === newProperty.id) ? newProperty : undefined
      const owner = property?.clientId ?? d0.properties.find((x) => x.id === p.propertyId)?.clientId
      if (owner !== p.clientId) throw new Error('That property belongs to another client. Choose one of theirs or add a new one.')
      const notify = (saved: Project) => {
        if (saved.assignedProviderId) {
          pushInbox({ userId: saved.assignedProviderId, title: `Assigned to project P-${saved.number}`, body: saved.title, requiresAck: true, projectId: saved.id })
        }
        if (saved.status === 'quoted') {
          pushInbox({
            userId: saved.clientId,
            title: `Quote ready: ${saved.title}`,
            body: `Quoted at ${money(saved.quoteAmount ?? 0)}. Review it under Projects.`,
            requiresAck: false,
            projectId: saved.id,
          })
        }
      }
      if (supabase) {
        // Saved one at a time, straight away, so the project can refer to them and any error is shown.
        if (client) {
          const { error } = await supabase.from('profiles').insert(profileRow(client))
          if (error) throw new Error(error.code === '23505' ? 'Another account already uses this email.' : error.message)
          mergeLocal((d) => {
            d.users.push(client)
          })
        }
        if (property) {
          const { error } = await supabase.from('properties').insert(propertyRow(property))
          if (error) throw new Error(error.message)
          mergeLocal((d) => {
            d.properties.push(property)
          })
        }
        const { data: row, error } = await supabase
          .from('projects')
          .insert({
            client_id: p.clientId,
            property_id: p.propertyId,
            title: p.title,
            description: p.description,
            type: p.type,
            budget: p.budget,
            quote_amount: p.quoteAmount ?? null,
            scope_of_works: p.scopeOfWorks,
            status: p.status,
            assigned_provider_id: p.assignedProviderId ?? null,
          })
          .select()
          .single()
        if (error) throw new Error(error.message)
        const saved = projectFromRow(row)
        mergeLocal((d) => {
          d.projects.unshift(saved)
        })
        notify(saved)
        return saved
      }
      const saved: Project = {
        ...p,
        id: uid('pr'),
        number: Math.max(200, ...d0.projects.map((x) => x.number)) + 1,
        ...blankCommercials(),
        milestones: [],
        expenses: [],
        createdAt: new Date().toISOString(),
        createdBy: user?.id,
      }
      update((d) => {
        if (client) d.users.push(client)
        if (property) d.properties.push(property)
        d.projects.unshift(saved)
      })
      notify(saved)
      return saved
    },
    [update, mergeLocal, pushInbox, user],
  )

  // ───────────── store ─────────────

  const loadCatalog = useCallback(async (): Promise<Product[]> => {
    if (supabase) {
      const rows = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('products').select('*').eq('status', 'published').order('id').range(from, from + 999)
        if (error) throw new Error(error.message)
        rows.push(...(data ?? []))
        if (!data || data.length < 1000) return productsFromRows(rows)
      }
    }
    return dataRef.current.products.filter((p) => p.status === 'published')
  }, [])

  const placeOrder = useCallback(
    async (o: OrderInput): Promise<PlacedOrder> => {
      if (supabase) {
        const { data: res, error } = await supabase.rpc('place_order', {
          p_items: o.items.map((i) => ({ product_id: i.productId, qty: i.qty, options: i.options ?? {}, install: !!i.install })),
          p_name: o.name,
          p_email: o.email,
          p_phone: o.phone,
          p_delivery: o.delivery,
          p_address: o.address,
          p_notes: o.notes,
        })
        if (error) throw new Error(error.message)
        if (user) await refresh()
        const r = res as { id: string; number: number; total: number | string; install_quote?: number | null }
        return { id: r.id, number: r.number, total: Number(r.total), email: o.email.trim(), installQuote: r.install_quote ?? undefined, delivery: o.delivery }
      }
      // Demo mode follows the same rules as the database.
      const d0 = dataRef.current
      if (!o.name.trim()) throw new Error('Enter your name')
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email.trim())) throw new Error('Enter a valid email address')
      if (o.phone.replace(/\D/g, '').length < 8) throw new Error('Enter a phone number we can reach you on')
      if (o.delivery !== 'pickup' && !o.address.trim()) throw new Error('Enter the delivery address')
      if (o.delivery === 'australia' && o.items.some((i) => i.install)) throw new Error('Installation is available in metro Melbourne only. Untick "Install it for me" to order with Australia-wide delivery.')
      if (o.items.length === 0) throw new Error('Your cart is empty')
      if (o.items.some((i) => i.install) && !o.address.trim()) throw new Error("Enter the address where it's to be installed")
      if (o.items.length > 30) throw new Error('Up to 30 different products per order. Please split it into two orders.')
      const trade = user?.role === 'provider' && user.status === 'active'
      const client = user?.role === 'client' && user.status === 'active'
      // The same product with the same choices is one line.
      const merged = new Map<string, { productId: string; qty: number; options: Record<string, string>; install: boolean }>()
      for (const i of o.items) {
        const options = i.options ?? {}
        const key = `${i.productId}|${JSON.stringify(Object.entries(options).sort())}|${!!i.install}`
        const had = merged.get(key)
        merged.set(key, { productId: i.productId, options, install: !!i.install, qty: (had?.qty ?? 0) + i.qty })
      }
      const bad: string[] = []
      const items: OrderItem[] = []
      for (const i of merged.values()) {
        const p = d0.products.find((x) => x.id === i.productId)
        if (!p || p.status !== 'published' || p.stock === 'out_of_stock') {
          bad.push(p?.title ?? 'an item')
          continue
        }
        const opts = p.options ?? []
        if (Object.keys(i.options).some((k) => !opts.some((g) => g.id === k))) throw new Error(`The options chosen for ${p.title} have changed. Remove it and add it again.`)
        let extra = 0
        const chosen: string[] = []
        for (const g of opts) {
          const v = g.values.find((x) => x.id === i.options[g.id])
          if (!v) throw new Error(`Choose the ${g.name.toLowerCase()} for ${p.title}`)
          if (!v.available) bad.push(`${p.title} (${v.label})`)
          extra += (trade && p.tradePrice !== undefined ? v.tradePrice : client && p.clientPrice !== undefined ? v.clientPrice : undefined) ?? v.price
          chosen.push(`${g.name}: ${v.label}`)
        }
        const base = trade && p.tradePrice !== undefined ? p.tradePrice : client && p.clientPrice !== undefined ? p.clientPrice : p.price
        items.push({ id: uid('oi'), productId: p.id, title: p.title, sku: p.sku, unitPrice: base + extra, qty: i.qty, options: chosen.join(' · ') || undefined, ...(i.install ? { install: true } : {}) })
      }
      if (bad.length) throw new Error(`No longer available: ${bad.join(', ')}`)
      const total = items.reduce((s, i) => s + i.unitPrice * i.qty, 0)
      const number = Math.max(5000, ...d0.orders.map((x) => x.number)) + 1
      const id = uid('o')
      // Items to install: a quote request in Quotes, linked to the order (as place_order does).
      const toInstall = items.filter((i) => i.install).sort((a, b) => a.title.localeCompare(b.title))
      const installQuote = toInstall.length ? Math.max(200, ...d0.projects.map((x) => x.number)) + 1 : undefined
      update((d) => {
        if (installQuote) {
          const email = o.email.trim()
          let clientId = client ? user!.id : d.users.find((u) => u.role === 'client' && !u.hasLogin && !u.passwordHash && u.email.toLowerCase() === email.toLowerCase())?.id
          if (!clientId) {
            clientId = uid('u')
            d.users.push({
              id: clientId,
              name: o.name.trim(),
              email: d.users.some((u) => u.email.toLowerCase() === email.toLowerCase()) ? '' : email,
              phone: o.phone.trim(),
              role: 'client',
              permissions: ['canSubmitRequests'],
              status: 'invited',
              createdAt: new Date().toISOString(),
              passwordHash: '',
              hasLogin: false,
            })
          }
          const address = o.address.trim()
          let propertyId = d.properties.find((x) => x.clientId === clientId && x.address.trim().toLowerCase() === address.toLowerCase())?.id
          if (!propertyId) {
            propertyId = uid('pr')
            d.properties.push({ id: propertyId, clientId, address, suburb: '', postcode: '', paintColors: { walls: '', trim: '', ceiling: '' }, skirtProfile: '', claddingType: '', accessCode: '', notes: `From store order #${number}` })
          }
          d.projects.unshift({
            id: uid('p'),
            number: installQuote,
            clientId,
            propertyId,
            title: `Install: store order #${number}`,
            description: `Installation requested with store order #${number} (supplied with the order).\n\nContact: ${o.name.trim()}, ${o.phone.trim()}, ${email}${o.notes.trim() ? `\n\nCustomer notes: ${o.notes.trim()}` : ''}`,
            type: 'renovation',
            budget: 0,
            scopeOfWorks: `Install:\n${toInstall.map((i) => `${i.qty} × ${i.title}${i.options ? ` (${i.options})` : ''}`).join('\n')}`,
            status: 'quote_requested',
            milestones: [],
            expenses: [],
            createdAt: new Date().toISOString(),
            createdBy: user?.id,
            quoteItems: [],
            quoteInclusions: '',
            quoteExclusions: '',
            orderId: id,
            variations: [],
            payments: [],
            costs: [],
            tasks: [],
            diary: [],
            defects: [],
            documents: [],
          })
        }
        d.orders.unshift({
          id,
          number,
          customerId: user?.id,
          name: o.name.trim(),
          email: o.email.trim(),
          phone: o.phone.trim(),
          delivery: o.delivery,
          address: o.address.trim(),
          notes: o.notes.trim(),
          trade,
          total,
          status: 'new',
          adminNotes: '',
          createdAt: new Date().toISOString(),
          items,
        })
        for (const a of d.users.filter((u) => u.role === 'admin' && u.status === 'active')) {
          d.inbox.unshift({
            id: uid('n'),
            userId: a.id,
            title: `New store order #${number}`,
            body: `${o.name.trim()}${trade ? ' (trade)' : ''} — ${items.reduce((s, i) => s + i.qty, 0)} item(s), ${money(total)}, ${deliveryName(o.delivery).toLowerCase()}${installQuote ? `. Installation requested: quote #${installQuote} is waiting to be priced in Quotes.` : ''}`,
            createdAt: new Date().toISOString(),
            read: false,
            requiresAck: false,
            acknowledged: false,
          })
        }
      })
      return { id, number, total, email: o.email.trim(), installQuote, delivery: o.delivery }
    },
    [update, refresh, user],
  )

  const submitLead = useCallback(
    async (l: LeadInput): Promise<{ number: number }> => {
      const email = l.email.trim()
      const phone = l.phone.trim()
      // Checked here too so a visitor's photos aren't uploaded for a request that would be refused.
      if (!(SITE_SERVICES as readonly string[]).includes(l.service)) throw new Error('Choose the service you need')
      if (l.photos.length === 0) throw new Error('Add at least one photo of the job')
      if (l.photos.length > 6) throw new Error('Up to 6 photos, please')
      if (!l.message.trim()) throw new Error('Tell us what needs doing')
      if (!l.name.trim()) throw new Error('Enter your name')
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address')
      if (phone && phone.replace(/\D/g, '').length < 8) throw new Error('Enter a valid phone number')
      if (!email && !phone) throw new Error('Leave a phone number or email so we can reply')
      if (supabase) {
        const client = supabase
        const photos = await Promise.all(l.photos.map((p) => uploadLeadPhoto(client, p)))
        const { data: res, error } = await client.rpc('submit_lead', {
          p_name: l.name,
          p_email: email,
          p_phone: phone,
          p_suburb: l.suburb,
          p_service: l.service,
          p_urgency: l.urgency,
          p_contact_by: l.contactBy,
          p_message: l.message,
          p_photos: photos,
          p_company: l.company,
        })
        if (error) throw new Error(error.message)
        return { number: (res as { number: number }).number }
      }
      // Demo mode follows the same rules as the database; photos stay in this browser.
      const contactBy = l.contactBy === 'phone' ? (phone ? 'phone' : 'email') : email ? 'email' : 'phone'
      const number = Math.max(3000, ...dataRef.current.leads.map((x) => x.number)) + 1
      update((d) => {
        d.leads.unshift({
          id: uid('l'),
          number,
          name: l.name.trim(),
          email,
          phone,
          company: l.company.trim(),
          suburb: l.suburb.trim(),
          services: [l.service],
          urgency: l.urgency,
          contactBy,
          message: l.message.trim(),
          photos: l.photos,
          status: 'new',
          notes: '',
          createdAt: new Date().toISOString(),
        })
        const office = d.users.filter((u) => u.role === 'admin' && u.status === 'active' && (u.permissions.includes('canManageProjects') || u.permissions.includes('canDispatchJobs')))
        for (const a of office) {
          d.inbox.unshift({
            id: uid('n'),
            userId: a.id,
            title: `${l.urgency === 'urgent' ? 'Urgent request' : 'New maintenance request'} #${number}: ${l.name.trim()}`,
            body: [l.service, l.suburb.trim(), `${l.photos.length} photo${l.photos.length > 1 ? 's' : ''}`, contactBy === 'phone' ? `call ${phone}` : `email ${email}`].filter(Boolean).join(' · '),
            createdAt: new Date().toISOString(),
            read: false,
            requiresAck: false,
            acknowledged: false,
          })
        }
      })
      return { number }
    },
    [update],
  )

  const logText = useCallback(
    (to: string, message: string, event: string) => {
      update((d) => {
        d.texts.unshift({ id: uid('t'), to: to.trim().slice(0, 40), message: message.slice(0, 2000), event: event.slice(0, 120), openedBy: user?.id, openedAt: new Date().toISOString() })
      })
    },
    [update, user],
  )

  const uploadProjectFile = useCallback(async (projectId: string, file: File) => {
    if (file.size > 25 * 1024 * 1024) throw new Error('Files can be up to 25 MB.')
    if (supabase) {
      const safe = file.name.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file'
      const path = `${projectId}/${crypto.randomUUID()}/${safe}`
      const { error } = await supabase.storage.from('project-docs').upload(path, file, { contentType: file.type || 'application/octet-stream' })
      if (error) throw new Error(`Upload failed: ${error.message}`)
      return { path, sizeBytes: file.size, contentType: file.type }
    }
    // Demo mode keeps the file in this browser, so only small ones fit.
    if (file.size > 1.5 * 1024 * 1024) throw new Error('In demo mode files can be up to 1.5 MB.')
    const path = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
    return { path, sizeBytes: file.size, contentType: file.type }
  }, [])

  const projectFileUrl = useCallback(async (path: string) => {
    if (!supabase || path.startsWith('data:')) return path
    const { data: link, error } = await supabase.storage.from('project-docs').createSignedUrl(path, 600)
    if (error || !link) throw new Error(error?.message ?? 'Could not open the file')
    return link.signedUrl
  }, [])

  const deleteProjectDocument = useCallback(
    (projectId: string, documentId: string) => {
      const doc = dataRef.current.projects.find((p) => p.id === projectId)?.documents.find((x) => x.id === documentId)
      const saved = updateAndSave((d) => {
        const p = d.projects.find((x) => x.id === projectId)
        if (p) p.documents = p.documents.filter((x) => x.id !== documentId)
      })
      // The file goes once the record is deleted, so a failed delete never leaves a record without its file.
      const client = supabase
      if (client && doc && !doc.path.startsWith('data:')) {
        void saved.then((ok) => {
          if (ok) void client.storage.from('project-docs').remove([doc.path])
        })
      }
    },
    [updateAndSave],
  )

  /** Viewable links for a request's photos (live: short-lived signed links; demo: the images themselves). */
  const leadPhotoUrls = useCallback(async (paths: string[]): Promise<string[]> => {
    if (!supabase || paths.length === 0) return paths
    const { data, error } = await supabase.storage.from('lead-photos').createSignedUrls(paths, 3600)
    if (error) throw new Error(error.message)
    return data.map((x) => x.signedUrl ?? '')
  }, [])

  /** Removes a request (e.g. spam) and, live, its photos. */
  const deleteLead = useCallback(
    (id: string) => {
      const photos = dataRef.current.leads.find((l) => l.id === id)?.photos ?? []
      const saved = updateAndSave((d) => {
        d.leads = d.leads.filter((l) => l.id !== id)
      })
      // The photos go once the request is deleted, so a failed delete never leaves it without them.
      const client = supabase
      if (client && photos.length) {
        void saved.then((ok) => {
          if (ok) void client.storage.from('lead-photos').remove(photos)
        })
      }
    },
    [updateAndSave],
  )

  const findProducts = useCallback(async (query: string, onProgress?: (text: string) => void, signal?: AbortSignal) => {
    if (supabase) return streamFunction<{ products: FoundProduct[]; note: string }>('store-assistant', { action: 'find', query }, onProgress, signal)
    const q = query.trim() || 'bathroom products'
    onProgress?.(`Searching: ${q}`)
    await demoWait(500, signal)
    onProgress?.('Found 3. Getting photos…')
    await demoWait(300, signal)
    const sample = (n: number, brand: string, price: string, hue: number): FoundProduct => ({
      name: `${brand} ${q} (option ${n})`,
      brand,
      supplier: `${brand} Australia`,
      url: `https://example.com/${brand.toLowerCase()}-${n}`,
      price,
      category: 'Other',
      summary: `Sample result for “${q}”. In live mode the assistant searches the web for real products sold in Australia.`,
      image: n === 3 ? '' : demoPhoto(`${brand} (sample)`, hue),
    })
    return {
      products: [sample(1, 'Aqualine', '$449 inc. GST', 200), sample(2, 'Stonebridge', '$689 inc. GST', 30), sample(3, 'Hydro', '', 140)],
      note: 'Demo mode: these are sample results.',
    }
  }, [])

  const quoteByToken = useCallback(async (token: string): Promise<QuoteLinkView | null> => {
    if (!supabase) return null
    const { data, error } = await supabase.rpc('quote_by_token', { p_token: token })
    if (error) throw new Error(error.message)
    return data ? linkView(data as Record<string, unknown>) : null
  }, [])

  const answerQuoteByToken = useCallback(async (token: string, accept: boolean, name: string): Promise<QuoteLinkView> => {
    if (!supabase) throw new Error('Quote links work in live mode only.')
    const { data, error } = await supabase.rpc('answer_quote_by_token', { p_token: token, p_accept: accept, p_name: name })
    if (error) throw new Error(error.message)
    return linkView(data as Record<string, unknown>)
  }, [])

  const retryQuoteEstimate = useCallback(
    async (projectId: string) => {
      if (!supabase) throw new Error('Estimates go to QuickBooks in live mode.')
      const { error } = await supabase.rpc('retry_quote_estimate', { p_id: projectId })
      if (error) throw new Error(error.message)
      await refresh()
    },
    [refresh],
  )

  const sendQuoteDeposit = useCallback(
    async (projectId: string) => {
      if (!supabase) throw new Error('Deposit invoices are sent through QuickBooks in live mode.')
      const { error } = await supabase.rpc('send_quote_deposit', { p_id: projectId })
      if (error) throw new Error(error.message)
      await refresh()
    },
    [refresh],
  )

  const deleteQuote = useCallback(
    async (projectId: string) => {
      if (!supabase) {
        const p = dataRef.current.projects.find((x) => x.id === projectId)
        if (!p) throw new Error('That quote wasn’t found')
        if (p.status === 'in_progress' || p.status === 'completed') throw new Error(`P-${p.number} is a job that’s under way or finished, not a quote, so it can’t be deleted here.`)
        if (dataRef.current.invoices.some((i) => i.projectId === projectId && i.status === 'paid')) throw new Error(`Money has been paid against P-${p.number}, so it can’t be deleted.`)
        update((d) => {
          d.projects = d.projects.filter((x) => x.id !== projectId)
          d.invoices = d.invoices.filter((i) => i.projectId !== projectId)
        })
        return { estimates: 0, invoices: 0 }
      }
      const { data: out, error } = await supabase.rpc('delete_quote', { p_id: projectId })
      if (error) throw new Error(error.message)
      const r = (out ?? {}) as { estimates?: number; invoices?: number; documents?: string[] }
      const files = (r.documents ?? []).filter((x) => !x.startsWith('data:'))
      if (files.length) void supabase.storage.from('project-docs').remove(files)
      // Already gone on the server: removed here without saving.
      mergeLocal((d) => {
        d.projects = d.projects.filter((x) => x.id !== projectId)
        d.invoices = d.invoices.filter((i) => i.projectId !== projectId)
      })
      return { estimates: r.estimates ?? 0, invoices: r.invoices ?? 0 }
    },
    [update, mergeLocal],
  )

  const draftQuote = useCallback(
    async (p: Pick<Project, 'id' | 'title' | 'description' | 'scopeOfWorks'>, notes: string, onProgress?: (text: string) => void, signal?: AbortSignal): Promise<QuoteDraft> => {
      if (supabase) {
        return streamFunction<QuoteDraft>('quote-assistant', { projectId: p.id, notes, title: p.title, description: p.description, scope: p.scopeOfWorks }, onProgress, signal)
      }
      onProgress?.('Drafting the quote…')
      await demoWait(500, signal)
      return {
        lines: [
          { section: 'Preparation', description: 'Protect floors and furniture, set up work area', kind: 'labour', qty: 2, unit: 'hr', rate: 75, basis: 'estimate' },
          { section: 'Repairs', description: 'Patch and sand damaged plaster', kind: 'labour', qty: 4, unit: 'hr', rate: 75, basis: 'estimate' },
          { section: 'Repairs', description: 'Plaster, compound and consumables', kind: 'materials', qty: 1, unit: 'item', rate: 120, basis: 'estimate' },
        ],
        inclusions: 'All labour and materials listed\nClean-up and removal of debris',
        exclusions: 'Painting (quoted separately)',
        assumptions: ['Demo mode: this is a sample draft. In live mode Claude reads the request, your notes and the photos, and prices from your past quotes.'],
        questions: ['Confirm the area of damage on site'],
        photosUsed: 0,
        priceBookLines: 0,
      }
    },
    [],
  )

  const draftListing = useCallback(
    async (product: FoundProduct, instructions?: string, onProgress?: (text: string) => void, signal?: AbortSignal): Promise<DraftListing> => {
      if (supabase) {
        return (await streamFunction<{ listing: DraftListing }>('store-assistant', { action: 'draft', product, instructions }, onProgress, signal)).listing
      }
      onProgress?.(`Reading ${product.supplier}…`)
      await demoWait(400, signal)
      return {
        title: product.name || 'Sample product',
        description: `${product.summary || 'A sample description.'}\n\nNext Phase Maintenance can supply and install it.`,
        specs: ['Sample spec: check the supplier page'],
        category: product.category,
        brand: product.brand,
        sku: '',
        suggested_price: product.price.replace(/[^0-9.]/g, ''),
        notes: 'Demo mode: this draft is a sample. In live mode the assistant reads the product page and writes an original description.',
        // A sample of the variants a page might offer, priced from the price shown.
        options: (() => {
          const base = Number(product.price.replace(/[^0-9.]/g, '')) || 500
          return [
            { name: 'Width', choices: [{ label: '750 mm', price: base.toFixed(2), available: true }, { label: '900 mm', price: (base + 150).toFixed(2), available: true }] },
            { name: 'Colour', choices: [{ label: 'White', price: base.toFixed(2), available: true }, { label: 'Black', price: (base + 80).toFixed(2), available: false }] },
          ]
        })(),
        optionsFrom: 'page',
      }
    },
    [],
  )

  const recreatePhotos = useCallback(async (url: string, title: string, photos: string[], onProgress?: (text: string) => void, signal?: AbortSignal, colours: string[] = []) => {
    type Made = { images: string[]; references: string[]; colourImages?: Record<string, string>; colourErrors?: string[] }
    if (supabase) return streamFunction<Made>('store-assistant', { action: 'images', url, title, photos, colours }, onProgress, signal)
    const wanted = colours.slice(0, 6)
    const total = 2 + wanted.length
    onProgress?.('Finding the supplier’s photos…')
    await demoWait(300, signal)
    onProgress?.(`Creating new photo 1 of ${total} (studio shot)…`)
    await demoWait(300, signal)
    onProgress?.(`Creating new photo 2 of ${total} (in a room)…`)
    await demoWait(300, signal)
    const colourImages: Record<string, string> = {}
    for (const [i, c] of wanted.entries()) {
      onProgress?.(`Creating new photo ${3 + i} of ${total} (${c})…`)
      await demoWait(200, signal)
      colourImages[c] = demoPhoto(`${c} (demo)`, (i * 67) % 360)
    }
    return { images: [demoPhoto('New studio photo (demo)', 210), demoPhoto('New room photo (demo)', 35)], references: [], colourImages, colourErrors: [] } as Made
  }, [])

  const colourPhoto = useCallback(async (url: string, title: string, colour: string, photos: string[], onProgress?: (text: string) => void, signal?: AbortSignal) => {
    if (supabase) return (await streamFunction<{ image: string }>('store-assistant', { action: 'colour', url, title, colour, photos }, onProgress, signal)).image
    onProgress?.(`Creating the ${colour} photo…`)
    await demoWait(200, signal)
    return demoPhoto(`${colour} (demo)`, [...colour].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0))
  }, [])

  const quickBooksFn = useCallback(async (body: object) => {
    const { data: auth } = await supabase!.auth.getSession()
    const res = await fetch(`${FUNCTIONS_URL}/quickbooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: `Bearer ${auth.session?.access_token ?? ANON_KEY}` },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || !json) throw new Error(json?.error ?? `QuickBooks couldn’t be reached (${res.status}). Try again.`)
    return json
  }, [])

  const quickBooksStatus = useCallback(async (): Promise<QuickBooksStatus> => {
    if (!supabase) return { connected: false, dailyLimit: 20, maxTotal: 5000 }
    const { data, error } = await supabase.rpc('qbo_status')
    if (error) throw new Error(error.message)
    const r = (data ?? {}) as { connected?: boolean; company?: string; connected_at?: string; last_error?: string; daily_limit?: number; max_total?: number | string }
    return {
      connected: !!r.connected,
      company: r.company || undefined,
      connectedAt: r.connected_at || undefined,
      lastError: r.last_error || undefined,
      dailyLimit: r.daily_limit ?? 20,
      maxTotal: Number(r.max_total ?? 5000),
    }
  }, [])

  const setQuickBooksLimits = useCallback(async (dailyLimit: number, maxTotal: number) => {
    if (!supabase) throw new Error('QuickBooks connects in live mode only.')
    const { error } = await supabase.rpc('qbo_set_limits', { p_daily: dailyLimit, p_max: maxTotal })
    if (error) throw new Error(error.message)
  }, [])

  const connectQuickBooks = useCallback(async () => {
    if (!supabase) throw new Error('QuickBooks connects in live mode only.')
    return ((await quickBooksFn({ action: 'connect' })) as { url: string }).url
  }, [quickBooksFn])

  const disconnectQuickBooks = useCallback(async () => {
    if (!supabase) return
    await quickBooksFn({ action: 'disconnect' })
  }, [quickBooksFn])

  const retryInvoice = useCallback(
    async (orderId: string) => {
      if (!supabase) return
      const { error } = await supabase.rpc('retry_order_invoice', { p_id: orderId })
      if (error) throw new Error(error.message)
      await refresh()
    },
    [refresh],
  )

  const confirmDelivery = useCallback(
    async (orderId: string, fee: number, note: string) => {
      if (supabase) {
        const { error } = await supabase.rpc('confirm_order_delivery', { p_id: orderId, p_fee: fee, p_note: note })
        if (error) throw new Error(error.message)
        await refresh()
        return
      }
      // Demo: recorded on the order (there's no QuickBooks to invoice).
      if (!(fee >= 0)) throw new Error('Enter the delivery cost (0 to 10,000)')
      if (!note.trim()) throw new Error('Enter the delivery date, e.g. "Same day, Tue 12 Nov" or "Earliest: Thu 14 Nov"')
      update((d) => {
        const o = d.orders.find((x) => x.id === orderId)
        if (o) Object.assign(o, { deliveryFee: Math.round(fee * 100) / 100, deliveryNote: note.trim() })
      })
    },
    [refresh, update],
  )

  const orderInvoice = useCallback(async (orderId: string, email: string) => {
    if (!supabase) return null
    const { data, error } = await supabase.rpc('order_invoice', { p_id: orderId, p_email: email })
    if (error || !data) return null
    const r = data as { status: OrderInvoiceStatus; number: string; pay_link: string }
    return { status: r.status, number: r.number, payLink: r.pay_link }
  }, [])

  const checkSupplierStock = useCallback(
    async (target: { productId: string } | { url: string }): Promise<SupplierStock> => {
      if (supabase) {
        // A product just saved is checked once it has reached the database.
        if ('productId' in target) await queue.current
        const { data: auth } = await supabase.auth.getSession()
        const res = await fetch(`${FUNCTIONS_URL}/supplier-stock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: `Bearer ${auth.session?.access_token ?? ANON_KEY}` },
          body: JSON.stringify(target),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok || !json) throw new Error(json?.error ?? `The stock check failed (${res.status}). Try again.`)
        const r = (json.reading ?? json) as { status: SupplierStock['status']; qty: number | null; price: number | null; note: string }
        const reading: SupplierStock = { status: r.status, qty: r.qty ?? undefined, price: r.price ?? undefined, note: r.note, checkedAt: new Date().toISOString() }
        // The listing may have switched too: reload what the server saved.
        if ('productId' in target) void refresh()
        return reading
      }
      // Demo mode: a sample reading for a saved product; a new link isn't read.
      if (!('productId' in target)) return { status: 'unknown', note: 'Demo mode: the supplier’s page isn’t checked.' }
      const reading: SupplierStock = { status: 'in_stock', qty: 12, note: 'Demo mode: a sample reading. In live mode the supplier’s page is checked.', checkedAt: new Date().toISOString() }
      if ('productId' in target)
        update((d) => {
          const p = d.products.find((x) => x.id === target.productId)
          if (p?.source) p.source.supplierStock = { ...reading, changedAt: p.source.supplierStock?.changedAt }
        })
      return reading
    },
    [update, refresh],
  )

  // ───────────── accounts & files ─────────────

  const uploadImage = useCallback(async (dataUrl: string) => (supabase ? uploadPhoto(supabase, dataUrl) : dataUrl), [])

  const inviteAccount = useCallback(
    async (account: UserAccount, delivery: 'email' | 'link' = 'email'): Promise<{ error?: string; code?: string; link?: string }> => {
      if (supabase) {
        try {
          const res = await invokeFunction<{ link?: string }>('invite-user', {
            action: 'invite',
            delivery,
            redirectTo: appUrl(),
            profile: {
              name: account.name,
              email: account.email,
              role: account.role,
              phone: account.phone,
              company: account.company ?? null,
              trade: account.trade ?? null,
              permissions: account.permissions,
            },
          })
          await refresh()
          return { link: res?.link }
        } catch (e) {
          return { error: (e as Error).message }
        }
      }
      const code = account.inviteCode ?? generateInviteCode()
      update((d) => {
        d.users.push({ ...account, inviteCode: code, status: 'invited', passwordHash: '' })
      })
      return { code }
    },
    [update, refresh],
  )

  const getSignInLink = useCallback(async (profileId: string): Promise<{ error?: string; link?: string }> => {
    if (!supabase) return { error: 'Not available in demo mode.' }
    try {
      const res = await invokeFunction<{ link: string }>('invite-user', { action: 'link', profileId, redirectTo: appUrl() })
      // The first link creates the login, which locks the email address in place.
      await refresh()
      return { link: res.link }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }, [refresh])

  const deleteAccount = useCallback(
    async (id: string) => {
      if (supabase) {
        try {
          await invokeFunction('invite-user', { action: 'delete', profileId: id })
          await refresh()
          return null
        } catch (e) {
          return (e as Error).message
        }
      }
      // Demo mode mirrors the database rules: job and invoice history is kept, and so is the record
      // of work done for other people (by admins).
      const d0 = dataRef.current
      const hasHistory =
        d0.requests.some((r) => r.clientId === id) || d0.projects.some((p) => p.clientId === id) || d0.invoices.some((i) => i.clientId === id)
      if (hasHistory) return 'This account has jobs or invoices on record, so it can’t be deleted. Suspend it instead.'
      const actedForOthers =
        d0.requests.some((r) => r.createdBy === id && r.clientId !== id) ||
        d0.projects.some((p) => p.clientId !== id && (p.createdBy === id || p.quoteDecidedBy === id)) ||
        d0.projects.some((p) => p.expenses.some((e) => e.createdBy === id && e.providerId !== id)) ||
        d0.inbox.some((m) => m.acknowledgedBy === id && m.userId !== id)
      if (actedForOthers) return 'This account has done work for other people on record, so it can’t be deleted. Suspend it instead.'
      update((d) => {
        d.users = d.users.filter((x) => x.id !== id)
        d.properties = d.properties.filter((p) => p.clientId !== id)
        d.inbox = d.inbox.filter((m) => m.userId !== id)
        for (const r of d.requests) if (r.assignedProviderId === id) r.assignedProviderId = undefined
        for (const p of d.projects) {
          if (p.assignedProviderId === id) p.assignedProviderId = undefined
          for (const e of p.expenses) {
            if (e.providerId === id) e.providerId = ''
            if (e.createdBy === id) e.createdBy = undefined
          }
        }
      })
      return null
    },
    [update, refresh],
  )

  const resetDemoData = useCallback(() => {
    if (DEMO) setData(createSeed())
  }, [setData])

  // Memoised so consumers (and ActingAsProvider's own memo) re-render only when something in it changes.
  const value = useMemo<StoreValue>(
    () => ({
      cloud: CLOUD,
      phase,
      data,
      user,
      actor: user,
      actingAs,
      startActingAs,
      stopActingAs,
      canAct: alwaysAllowed,
      syncError,
      authNotice,
      update,
      can,
      login,
      acceptInvite,
      sendPasswordEmail,
      setNewPassword,
      acceptLink,
      logout,
      twoStep,
      cloudUserEmail: cloudProfile?.email,
      startTwoStepSetup,
      confirmTwoStep,
      changePassword,
      notifyAdmins,
      sendSms,
      submitRequest,
      requestQuote,
      createProject,
      loadCatalog,
      placeOrder,
      submitLead,
      leadPhotoUrls,
      uploadProjectFile,
      projectFileUrl,
      deleteProjectDocument,
      logText,
      deleteLead,
      findProducts,
      draftListing,
      draftQuote,
      quoteByToken,
      answerQuoteByToken,
      sendQuoteDeposit,
      deleteQuote,
      retryQuoteEstimate,
      recreatePhotos,
      colourPhoto,
      checkSupplierStock,
      quickBooksStatus,
      connectQuickBooks,
      disconnectQuickBooks,
      setQuickBooksLimits,
      retryInvoice,
      confirmDelivery,
      orderInvoice,
      assignRequest,
      pushInbox,
      pushAdminInbox,
      uploadImage,
      inviteAccount,
      getSignInLink,
      deleteAccount,
      resetDemoData,
    }),
    [
      acceptInvite,
      acceptLink,
      actingAs,
      answerQuoteByToken,
      assignRequest,
      authNotice,
      can,
      changePassword,
      checkSupplierStock,
      cloudProfile,
      colourPhoto,
      confirmDelivery,
      confirmTwoStep,
      connectQuickBooks,
      createProject,
      data,
      deleteAccount,
      deleteLead,
      deleteProjectDocument,
      deleteQuote,
      disconnectQuickBooks,
      draftListing,
      draftQuote,
      findProducts,
      getSignInLink,
      inviteAccount,
      leadPhotoUrls,
      loadCatalog,
      logText,
      login,
      logout,
      notifyAdmins,
      orderInvoice,
      phase,
      placeOrder,
      projectFileUrl,
      pushAdminInbox,
      pushInbox,
      quickBooksStatus,
      quoteByToken,
      recreatePhotos,
      requestQuote,
      resetDemoData,
      retryInvoice,
      retryQuoteEstimate,
      sendPasswordEmail,
      sendQuoteDeposit,
      sendSms,
      setNewPassword,
      setQuickBooksLimits,
      startActingAs,
      startTwoStepSetup,
      stopActingAs,
      submitLead,
      submitRequest,
      syncError,
      twoStep,
      update,
      uploadImage,
      uploadProjectFile,
      user,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

/**
 * Wraps a client or trade portal that an admin has opened: inside it, `user` is that client or trade
 * (so the portal shows exactly their dashboard) while `actor` stays the admin, who is the one doing
 * and being recorded for everything. Outside an admin's opened dashboard it changes nothing.
 */
export function ActingAsProvider({ children }: { children: ReactNode }) {
  const outer = useStore()
  const { actingAs, user: admin, can: adminCan } = outer
  const value = useMemo<StoreValue>(
    () =>
      actingAs
        ? { ...outer, user: actingAs, actor: admin, can: (p: Permission) => adminCan(ACTING_PERMISSION[p] ?? p), canAct: adminCan }
        : outer,
    [outer, actingAs, admin, adminCan],
  )
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

/**
 * Added without a login and not invited yet (live mode: no login created; demo mode: no invite code).
 * Live mode only counts a known "no login": if the database doesn't say, the email stays locked.
 */
export function hasNoLogin(u: UserAccount): boolean {
  return u.status === 'invited' && (CLOUD ? u.hasLogin === false : !u.inviteCode)
}

/** Has never had a login, whatever the account's status (e.g. one suspended before it was invited). */
export function lacksLogin(u: UserAccount): boolean {
  return CLOUD ? u.hasLogin === false : !u.passwordHash && !u.inviteCode
}

/** Names who did something: the person themselves, or "Admin for Person" from a dashboard an admin opened. */
export function doneBy(actor: UserAccount | null, user: UserAccount | null): string {
  if (!actor || !user || actor.id === user.id) return user?.name ?? actor?.name ?? ''
  return `${actor.name} for ${user.name}`
}

/**
 * Records who accepted or rejected a quote, as the database does in live mode: accepting is moving an
 * unanswered or rejected quote on, rejecting is moving anything to rejected; other moves keep the
 * record, and it's cleared when the quote is issued again. Changes `p` in place.
 */
export function stampQuoteDecision(p: Project, before: ProjectStatus, by: string | undefined) {
  if (p.status === 'quote_requested' || p.status === 'quoted') {
    p.quoteDecidedBy = undefined
    p.quoteDecision = undefined
  } else if (p.status !== before && (p.status === 'rejected' || before === 'quote_requested' || before === 'quoted' || before === 'rejected')) {
    p.quoteDecidedBy = by
    p.quoteDecision = p.status === 'rejected' ? 'rejected' : 'approved'
  }
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used inside StoreProvider')
  return ctx
}

/** Lookup helpers bound to the current data. */
export function useLookup() {
  const { data, actor } = useStore()
  return useMemo(
    () => ({
      user: (id?: string) => data.users.find((u) => u.id === id),
      /**
       * Name for "Lodged by"-style lines. Clients and trades see office staff as the business (live
       * mode can't load admins' accounts for them; demo mode has them all, so this hides them too).
       * Admins see names, including in a dashboard they've opened.
       */
      byName: (id?: string) => {
        const u = data.users.find((x) => x.id === id)
        return u && (actor?.role === 'admin' || u.role !== 'admin') ? u.name : BRAND.name
      },
      property: (id?: string) => data.properties.find((p) => p.id === id),
      request: (id?: string) => data.requests.find((r) => r.id === id),
      project: (id?: string) => data.projects.find((p) => p.id === id),
      // Who admins can assign work to: every trade that isn't suspended, including those without a
      // login yet or with an invite pending (their work waits in their inbox).
      providers: data.users.filter((u) => u.role === 'provider' && u.status !== 'suspended'),
      clients: data.users.filter((u) => u.role === 'client'),
    }),
    [data, actor],
  )
}
