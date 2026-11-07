import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { track } from '../../lib/analytics'
import { ArrowLeft, BadgeCheck, CheckCircle2, Minus, Phone, Plus, Receipt, Search, ShieldCheck, ShoppingCart, Trash2, Truck, Wrench } from 'lucide-react'
import { Empty, Field, PageHeader, Status, type Tone } from '../../components/ui'
import { Logo } from '../../components/Logo'
import { BRAND } from '../../lib/brand'
import { SignInModal } from '../../components/SignInModal'
import { useStore, type PlacedOrder } from '../../lib/store'
import { lineKey, useCart } from '../../lib/cart'
import { navigate, ROUTE_EVENT } from '../../lib/router'
import { SITE_URL, usePageMeta } from '../../lib/head'
import { productMeta, productPath, STORE_META } from '../../lib/seo'
import { ORDER_STATUS_LABEL, STORE_CATEGORIES, type OrderInvoiceStatus, type OrderStatus, type Product, type UserAccount } from '../../lib/types'
import { ProductCard, ProductView } from './ProductView'
import { StoreFooter, StoreInfo } from './StoreInfo'
import { DELIVERY_METHODS, isStoreInfo, STORE_POLICY, type DeliveryMethod } from '../../lib/storePolicy'
import { cheapestChoice, choicePhoto, choiceText, defaultChoice, ProductImage, unitPrice, useCatalog, type Choice } from './shopping'
import { cx, fmtDate, money } from '../../lib/utils'
import { PaymentSafety } from '../../components/PaymentSafety'

const ORDER_TONE: Record<OrderStatus, Tone> = { new: 'orange', confirmed: 'outline', paid: 'dark', fulfilled: 'green', cancelled: 'red' }

/**
 * The shop: browse, product details, cart and checkout. Used on the public store page and in the
 * client and service provider portals.
 */
export function Shop({
  portal,
  productId,
  cart: shared,
  view: sharedView,
  onView,
}: {
  portal?: boolean
  productId?: string
  /** The public store page keeps the cart and the cart view itself, so its header can show them. */
  cart?: ReturnType<typeof useCart>
  view?: ShopView
  onView?: (v: ShopView) => void
}) {
  const { user, actingAs } = useStore()
  const { products, loading, error } = useCatalog()
  const own = useCart()
  const cart = shared ?? own
  const [ownView, setOwnView] = useState<ShopView>('browse')
  const view = sharedView ?? ownView
  const setView = onView ?? setOwnView
  // The category is kept in the address (?category=Tapware) on the public shop, so it can be shared.
  const [category, setCategoryState] = useState(() => (portal ? 'All' : new URLSearchParams(window.location.search).get('category') ?? 'All'))
  const setCategory = (c: string) => {
    setCategoryState(c)
    if (portal) return
    const url = new URL(window.location.href)
    if (c === 'All') url.searchParams.delete('category')
    else url.searchParams.set('category', c)
    window.history.replaceState(null, '', url)
  }
  // Back and forward (and links) can change the address's category while the shop stays open.
  useEffect(() => {
    if (portal || productId) return
    const read = () => setCategoryState(new URLSearchParams(window.location.search).get('category') ?? 'All')
    read()
    // A link to another category (/store?category=…) changes only the address, not productId.
    window.addEventListener('popstate', read)
    window.addEventListener(ROUTE_EVENT, read)
    return () => {
      window.removeEventListener('popstate', read)
      window.removeEventListener(ROUTE_EVENT, read)
    }
  }, [portal, productId])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('featured')
  // On the public shop each product has its own address (/store/<id>/<name>), so the open product
  // follows the address; in the portals it's just opened in place.
  const routed = !portal
  const [local, setLocal] = useState<Product | null>(null)
  const open = routed ? (products.find((p) => p.id === productId) ?? null) : local
  const [choice, setChoice] = useState<Choice>({})
  const openId = open?.id
  useEffect(() => {
    if (open) setChoice(defaultChoice(open))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId])
  const setOpen = (p: Product | null) => {
    setView('browse')
    if (routed) navigate(p ? productPath(p) : category === 'All' ? '/store' : `/store?category=${encodeURIComponent(category)}`)
    else {
      setLocal(p)
      window.scrollTo(0, 0)
    }
  }
  usePageMeta(!routed || loading ? null : open ? productMeta(open, SITE_URL) : STORE_META(SITE_URL))
  const [placed, setPlaced] = useState<PlacedOrder | null>(null)

  const categories = useMemo(() => STORE_CATEGORIES.filter((c) => products.some((p) => p.category === c)), [products])
  const q = query.trim().toLowerCase()
  const shown = sortProducts(
    products.filter((p) => (category === 'All' || p.category === category) && (!q || `${p.title} ${p.brand} ${p.sku} ${p.description} ${(p.highlights ?? []).join(' ')}`.toLowerCase().includes(q))),
    sort,
    user,
  )
  const addToCart = (p: Product, qty = 1, chosen?: Choice, install = false) => {
    cart.add(p.id, qty, chosen, install)
    track('add_to_cart', { currency: 'AUD', items: [{ item_id: p.id, item_name: p.title, quantity: qty }] })
  }

  if (placed) return <OrderPlaced placed={placed} onDone={() => { setPlaced(null); setView('browse') }} />

  const cartButton = routed ? null : (
    <button className={cx('ml-auto', cart.count ? 'btn-primary' : 'btn-ghost')} onClick={() => setView('cart')}>
      <ShoppingCart size={16} /> Cart{cart.count ? <span className="num">({cart.count})</span> : null}
    </button>
  )

  if (loading) return <p className="text-sm text-slate-500">Loading products…</p>
  if (error) return <Empty title="The shop couldn't load">{error}</Empty>

  if (view === 'cart') {
    return (
      <>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-bold sm:text-3xl">
            Your cart{cart.count ? <span className="num ml-2 text-base font-normal text-slate-500">{cart.count} {cart.count === 1 ? 'item' : 'items'}</span> : null}
          </h1>
          <button className="btn-ghost" onClick={() => setView('browse')}>
            <ArrowLeft size={16} /> {open ? 'Back to the product' : 'Continue shopping'}
          </button>
        </div>
        <Checkout cart={cart} products={products} portal={portal} acting={!!actingAs} onPlaced={(r) => { track('purchase', { transaction_id: String(r.number), value: r.total, currency: 'AUD' }); cart.clear(); setPlaced(r) }} />
      </>
    )
  }

  if (open) {
    return (
      <>
        {cartButton && <div className="mb-4 flex justify-end">{cartButton}</div>}
        <ProductView
          key={open.id}
          p={open}
          user={user}
          choice={choice}
          setChoice={setChoice}
          related={products.filter((r) => r.category === open.category && r.id !== open.id).slice(0, 4)}
          onBack={() => setOpen(null)}
          onAdd={(qty, install) => addToCart(open, qty, (open.options ?? []).length ? choice : undefined, install)}
          onViewCart={() => setView('cart')}
          onOpen={(r) => setOpen(r)}
        />
      </>
    )
  }

  return (
    <>
      {routed && <StoreIntro products={products} categories={categories} onCategory={setCategory} />}
      <div id="products" className="mb-4 flex scroll-mt-20 flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input className="input pl-9" type="search" placeholder="Search products" aria-label="Search products" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select className="input w-auto" aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {(Object.keys(SORT_LABEL) as Sort[]).map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
        </select>
        {cartButton}
      </div>
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Category">
        {['All', ...categories].map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            aria-pressed={category === c}
            className={cx('border px-3 py-1.5 text-sm', category === c ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white hover:border-slate-900')}
          >
            {c} <span className={cx('num', category === c ? 'text-white/70' : 'text-slate-500')}>{c === 'All' ? products.length : products.filter((p) => p.category === c).length}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <Empty title={products.length ? 'Nothing matches' : 'No products yet'}>{products.length ? 'Try another search or category.' : 'Check back soon.'}</Empty>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-500" aria-live="polite"><span className="num">{shown.length}</span> {shown.length === 1 ? 'product' : 'products'}</p>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {shown.map((p) => (
              <ProductCard key={p.id} p={p} user={user} routed={routed} onOpen={() => setOpen(p)} onAdd={() => addToCart(p)} />
            ))}
          </div>
        </>
      )}
    </>
  )
}

export type ShopView = 'browse' | 'cart'

type Sort = 'featured' | 'price-low' | 'price-high' | 'name'
const SORT_LABEL: Record<Sort, string> = { featured: 'Featured', 'price-low': 'Price: low to high', 'price-high': 'Price: high to low', name: 'Name' }
function sortProducts(list: Product[], sort: Sort, user: UserAccount | null): Product[] {
  const from = (p: Product) => unitPrice(p, user, cheapestChoice(p, user))
  if (sort === 'price-low') return [...list].sort((a, b) => from(a) - from(b))
  if (sort === 'price-high') return [...list].sort((a, b) => from(b) - from(a))
  if (sort === 'name') return [...list].sort((a, b) => a.title.localeCompare(b.title))
  // Featured: by category, in the shop's order, then the most complete listings first.
  const order = (p: Product) => STORE_CATEGORIES.indexOf(p.category as (typeof STORE_CATEGORIES)[number])
  return [...list].sort((a, b) => order(a) - order(b) || (b.highlights?.length ?? 0) - (a.highlights?.length ?? 0) || a.title.localeCompare(b.title))
}

/** The top of the public shop: what it is, why buy here, and its categories. */
function StoreIntro({ products, categories, onCategory }: { products: Product[]; categories: string[]; onCategory: (c: string) => void }) {
  const pick = (c: string) => {
    onCategory(c)
    document.getElementById('products')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  // One photo from each of up to three categories, for the banner.
  const showcase = categories
    .map((c) => products.find((p) => p.category === c && p.images.length))
    .filter((p): p is Product => !!p)
    .slice(0, 3)
  return (
    <div className="mb-10 space-y-8">
      <section className={cx('grid overflow-hidden bg-slate-900 text-white', showcase.length > 0 && 'lg:grid-cols-[1.1fr_1fr]')}>
        <div className="px-6 py-9 sm:px-10 sm:py-14">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Next Phase Maintenance shop</p>
          <h1 className="mt-3 max-w-2xl font-display text-3xl font-bold leading-tight text-balance sm:text-5xl">Quality bathroom fixtures at honest prices</h1>
          <p className="mt-4 max-w-xl text-base font-light text-white/80 sm:text-lg">
            Vanities, shower screens, toilets and tapware for Melbourne homes and rentals. Buy on its own, or have our team supply and install it.
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <button className="btn-accent px-6 py-3 text-base" onClick={() => pick('All')}>Shop all products</button>
            <a href="/store/delivery" className="btn border border-white px-6 py-3 text-base text-white hover:bg-white hover:text-slate-900">Delivery and installation</a>
          </div>
          <dl className="mt-8 grid max-w-lg grid-cols-3 gap-4 border-t border-white/15 pt-5 text-sm">
            <div><dt className="text-white/60">Delivery</dt><dd className="num mt-0.5 font-semibold">From ${STORE_POLICY.melbourneDeliveryFrom}</dd></div>
            <div><dt className="text-white/60">Pickup</dt><dd className="mt-0.5 font-semibold">Free</dd></div>
            <div><dt className="text-white/60">Returns</dt><dd className="num mt-0.5 font-semibold">{STORE_POLICY.changeOfMindDays} days</dd></div>
          </dl>
        </div>
        {showcase.length > 0 && (
          <div className={cx('hidden gap-1 bg-slate-900 p-1 lg:grid', showcase.length > 1 && 'grid-cols-2 grid-rows-2')} aria-hidden="true">
            {showcase.map((p, i) => (
              <ProductImage key={p.id} p={p} src={p.images[0]} className={cx('h-full min-h-0 w-full', i === 0 && showcase.length > 1 && 'row-span-2', showcase.length === 2 && 'row-span-2')} />
            ))}
          </div>
        )}
      </section>
      <ul className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {[
          { icon: BadgeCheck, title: 'Australian standards', body: 'WELS ratings and WaterMark details on every tap and toilet.' },
          { icon: Receipt, title: 'Prices include GST', body: 'The price you see is the price you pay for the product.' },
          { icon: Wrench, title: 'Supply and install', body: 'Licensed and insured trades to supply and fit it, across metro Melbourne.' },
          { icon: ShieldCheck, title: 'Your rights protected', body: 'Australian Consumer Law guarantees on everything we sell.' },
        ].map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-3 border border-slate-200 bg-white p-4">
            <Icon size={22} className="shrink-0 text-accent-ink" aria-hidden="true" />
            <span>
              <span className="block font-semibold text-slate-900">{title}</span>
              <span className="text-slate-600">{body}</span>
            </span>
          </li>
        ))}
      </ul>
      <section aria-labelledby="shop-categories">
        <h2 id="shop-categories" className="rule-above font-display text-xl font-bold">Shop by category</h2>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {categories.map((c) => {
            const items = products.filter((p) => p.category === c)
            const cover = items.find((p) => p.images.length) ?? items[0]
            return (
              <button key={c} onClick={() => pick(c)} className="group overflow-hidden border border-slate-200 bg-white text-left">
                {cover && <ProductImage p={cover} src={cover.images[1] ?? cover.images[0]} className="aspect-[4/3] w-full transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none" />}
                <span className="flex items-center justify-between gap-2 p-3">
                  <span className="font-semibold">{c}</span>
                  <span className="num text-sm text-slate-500">{items.length}</span>
                </span>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function Checkout({
  cart,
  products,
  portal,
  acting,
  onPlaced,
}: {
  cart: ReturnType<typeof useCart>
  products: Product[]
  portal?: boolean
  acting: boolean
  onPlaced: (r: PlacedOrder) => void
}) {
  const { user, placeOrder } = useStore()
  const [form, setForm] = useState(() => ({
    name: user?.name ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    delivery: 'pickup' as DeliveryMethod,
    address: '',
    notes: '',
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lines = cart.lines
    .map((l) => {
      const found = products.find((p) => p.id === l.productId)
      const chosen = found ? choiceText(found, l.options) : null
      // A product whose options changed since it went in the cart is treated as gone.
      return { ...l, key: lineKey(l), p: chosen === null ? undefined : found, chosen, title: found?.title }
    })
    .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))
  const total = lines.reduce((s, l) => s + (l.p ? unitPrice(l.p, user, l.options) * l.qty : 0), 0)
  const missing = lines.filter((l) => !l.p)
  const installing = lines.some((l) => l.p && l.install)
  const needsAddress = form.delivery !== 'pickup' || installing
  // Installation is offered in Melbourne only.
  const installTooFar = installing && form.delivery === 'australia'
  const tooMany = lines.length - missing.length > 30

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (acting) return
    setBusy(true)
    setError(null)
    try {
      onPlaced(
        await placeOrder({
          ...form,
          address: needsAddress ? form.address : '',
          items: lines.filter((l) => l.p).map((l) => ({ productId: l.productId, qty: l.qty, options: l.options, install: !!l.install })),
        }),
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (lines.length === 0) return <Empty title="Your cart is empty">Add products to get started.</Empty>
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
      <section className="card divide-y divide-slate-100" aria-label="Cart">
        {lines.map((l) => (
          <div key={l.key} className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap">
            {l.p ? <ProductImage p={l.p} src={choicePhoto(l.p, l.options)} className="aspect-square w-16 shrink-0" /> : null}
            <div className="min-w-0 flex-1 basis-40">
              <p className="font-semibold leading-snug">{l.p ? l.p.title : l.title ? `${l.title}: options no longer available` : 'No longer available'}</p>
              {l.chosen && <p className="text-xs text-slate-600">{l.chosen}</p>}
              {l.p && <p className="num text-xs text-slate-500">{money(unitPrice(l.p, user, l.options))} each</p>}
              {l.p && (
                <label className="mt-1.5 inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700">
                  <input type="checkbox" className="accent-slate-900" checked={!!l.install} onChange={(e) => cart.setInstall(l, e.target.checked)} />
                  Install it for me <span className="text-slate-500">(quoted after you order)</span>
                </label>
              )}
            </div>
            {l.p && (
              <div className="flex items-center gap-1">
                <button type="button" className="btn-ghost px-2 py-1" aria-label={`One less ${l.p.title}`} onClick={() => cart.setQty(l, l.qty - 1)}><Minus size={14} /></button>
                <span className="num w-8 text-center" aria-label="Quantity">{l.qty}</span>
                <button type="button" className="btn-ghost px-2 py-1" aria-label={`One more ${l.p.title}`} onClick={() => cart.setQty(l, l.qty + 1)}><Plus size={14} /></button>
              </div>
            )}
            <button type="button" className="text-slate-500 hover:text-red-600" aria-label="Remove" onClick={() => cart.setQty(l, 0)}><Trash2 size={16} /></button>
          </div>
        ))}
        <div className="flex items-center justify-between p-4">
          <span className="font-semibold">Total (inc. GST){installing && <span className="block text-xs font-normal text-slate-500">Installation quoted separately</span>}</span>
          <span className="num text-lg font-bold">{money(total)}</span>
        </div>
        {missing.length > 0 && <p className="p-4 text-sm text-red-600">Some items are no longer available; remove them to continue.</p>}
        {tooMany && <p className="p-4 text-sm text-red-600">Up to 30 different products per order. Please split it into two orders.</p>}
      </section>
      <form className="card space-y-4 p-5" onSubmit={submit}>
        <h2 className="font-bold">Your details</h2>
        <Field label="Name"><input className="input" required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Email"><input className="input" type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Phone"><input className="input num" type="tel" required autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <fieldset>
          <legend className="label">Pickup or delivery</legend>
          <div className="grid gap-2">
            {DELIVERY_METHODS.map((d) => (
              <label key={d.id} className={cx('flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm', form.delivery === d.id ? 'border-slate-900 bg-slate-50' : 'border-slate-200')}>
                <input type="radio" name="delivery" className="mt-0.5 accent-slate-900" checked={form.delivery === d.id} onChange={() => setForm({ ...form, delivery: d.id })} />
                <span>
                  <span className="block font-medium">{d.name}</span>
                  <span className="block text-xs text-slate-500">{d.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {installTooFar && (
          <p className="text-sm text-red-600">Installation is available in metro Melbourne only. Untick “Install it for me” to order with Australia-wide delivery, or choose a Melbourne option.</p>
        )}
        {needsAddress && (
          <Field label={form.delivery !== 'pickup' && installing ? 'Delivery and installation address' : installing ? 'Installation address (metro Melbourne)' : 'Delivery address'}>
            <input className="input" required autoComplete="street-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
        )}
        <Field label="Notes (optional)">
          <textarea className="input min-h-[70px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Colour, sizes, install needed, best time to call…" />
        </Field>
        <p className="text-xs text-slate-500">
          No payment now.{' '}
          {form.delivery !== 'pickup'
            ? "We'll confirm the delivery cost and date first, then email your invoice: you only pay once you've agreed them."
            : "We'll email your invoice with ways to pay, and confirm availability."}
          {installing && " Installation is quoted separately after you order: we'll send you the price, and you only pay for it if you accept."}
          {user?.role === 'provider' && user.status === 'active' && ' Trade prices apply to your account.'}
        </p>
        <PaymentSafety />
        {acting && <p className="text-sm text-red-600">Orders can't be placed from someone else's dashboard.</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-accent w-full py-3 text-base" disabled={busy || acting || missing.length > 0 || tooMany || installTooFar}>
          {busy ? 'Placing order…' : `Place order · ${money(total)}`}
        </button>
        {!portal && !user && <p className="text-xs text-slate-500">Already a client or trade? Sign in to see your orders and trade prices.</p>}
      </form>
    </div>
  )
}

/** A signed-in client's or service provider's orders. */
export function MyOrders() {
  const { data, user } = useStore()
  const mine = data.orders.filter((o) => o.customerId === user?.id)
  if (mine.length === 0) return null
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-lg font-bold">Your orders</h2>
      <div className="card divide-y divide-slate-100">
        {mine.map((o) => (
          <div key={o.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-semibold">
                Order <span className="num">#{o.number}</span> <span className="text-sm font-normal text-slate-500">· {fmtDate(o.createdAt)}</span>
              </p>
              <p className="mt-1 text-sm text-slate-600">{o.items.map((i) => `${i.qty} × ${i.title}${i.options ? ` (${i.options})` : ''}`).join(', ')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
              <span className="num font-semibold">{money(o.total)}</span>
              <Status tone={ORDER_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Status>
              {o.invoice?.status === 'sent' && o.status !== 'cancelled' && o.invoice.payLink && (
                <a className="text-sm font-semibold text-slate-900 underline" href={o.invoice.payLink} target="_blank" rel="noreferrer">
                  Pay invoice #{o.invoice.number}
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The store inside a client or service provider portal. */
export function PortalStore() {
  return (
    <>
      <PageHeader title="Store" subtitle="Vanities, shower screens, tapware and more, supplied (and installed) by Next Phase Maintenance." />
      <Shop portal />
      <MyOrders />
    </>
  )
}

/** The public store page, open to anyone from the home page. */
export function StorePage({ productId }: { productId?: string }) {
  const { user, can } = useStore()
  const manage = user?.role === 'admin' && can('canManageStore')
  const [signIn, setSignIn] = useState(false)
  const cart = useCart()
  const [view, setView] = useState<ShopView>('browse')
  const info = isStoreInfo(productId)
  const openCart = () => {
    if (info) navigate('/store')
    setView('cart')
    window.scrollTo(0, 0)
  }
  const links = [
    { href: '/store/delivery', label: 'Delivery' },
    { href: '/store/returns', label: 'Returns' },
    { href: '/store/contact', label: 'Contact' },
  ]
  const tel = BRAND.phone.replace(/\s/g, '')
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-slate-900 text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-center gap-x-5 gap-y-1 px-4 py-2 text-xs sm:justify-between sm:px-6">
          <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center">
            <span className="inline-flex items-center gap-1.5"><Truck size={14} className="text-accent" aria-hidden="true" /><span>Melbourne delivery from <span className="num">${STORE_POLICY.melbourneDeliveryFrom}</span></span></span>
            <span className="hidden sm:inline">Free pickup</span>
            <span className="hidden md:inline"><span className="num">{STORE_POLICY.changeOfMindDays}</span>-day returns on unopened items</span>
          </p>
          {BRAND.phone && (
            <a href={`tel:${tel}`} className="num hidden items-center gap-1.5 text-white/90 hover:text-white sm:inline-flex">
              <Phone size={13} aria-hidden="true" /> {BRAND.phone}
            </a>
          )}
        </div>
      </div>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:gap-4 sm:px-6">
          <div className="shrink-0"><Logo sub="Store" /></div>
          <nav aria-label="Shop" className="ml-auto hidden items-center gap-6 text-sm md:flex">
            <a href="/store" className="font-medium text-slate-900 hover:text-accent-ink">Shop</a>
            {links.map((l) => <a key={l.href} href={l.href} className="text-slate-600 hover:text-slate-900">{l.label}</a>)}
            <a href="/" className="text-slate-600 hover:text-slate-900">Maintenance services</a>
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-4">
            {user ? (
              <button
                className="btn-ghost hidden text-sm sm:inline-flex"
                onClick={() => navigate(manage ? '/admin/store' : user.role === 'admin' ? '/admin' : `/${user.role}/store`)}
              >
                {manage ? 'Manage store' : 'Your portal'}
              </button>
            ) : (
              <button className="btn-ghost text-sm" onClick={() => setSignIn(true)}>Sign in</button>
            )}
            <button className="btn-accent relative gap-2 px-3.5" onClick={openCart} aria-label={cart.count ? `Cart, ${cart.count} ${cart.count === 1 ? 'item' : 'items'}` : 'Cart, empty'}>
              <ShoppingCart size={18} aria-hidden="true" />
              <span className="hidden sm:inline">Cart</span>
              {cart.count > 0 && (
                <span className="num inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1.5 text-xs font-bold text-slate-900" aria-hidden="true">{cart.count}</span>
              )}
            </button>
          </div>
        </div>
        <nav aria-label="Shop help" className="border-t border-slate-100 md:hidden">
          <div className="mx-auto flex max-w-7xl gap-5 overflow-x-auto px-4 py-2 text-sm">
            <a href="/store" className="font-medium text-slate-900">Shop</a>
            {links.map((l) => <a key={l.href} href={l.href} className="shrink-0 text-slate-600">{l.label}</a>)}
            {BRAND.phone && <a href={`tel:${tel}`} className="num ml-auto shrink-0 text-slate-600">{BRAND.phone}</a>}
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        {info ? <StoreInfo slug={productId} /> : <Shop productId={productId} cart={cart} view={view} onView={setView} />}
      </main>
      <StoreFooter />
      <SignInModal open={signIn} onClose={() => setSignIn(false)} />
    </div>
  )
}

/**
 * The order's confirmation. Its QuickBooks invoice is created and emailed within moments of the
 * order, so the screen waits a little for it and, once it's there, offers its pay link straight away.
 */
function OrderPlaced({ placed, onDone }: { placed: PlacedOrder; onDone: () => void }) {
  const { orderInvoice, cloud } = useStore()
  const [invoice, setInvoice] = useState<{ status: OrderInvoiceStatus; number: string; payLink: string } | null>(null)
  useEffect(() => {
    // Delivery orders are invoiced once the delivery cost and date are confirmed, not straight away.
    if (!cloud || placed.delivery !== 'pickup') return
    let live = true
    let timer = 0
    const started = Date.now()
    const check = async () => {
      const r = await orderInvoice(placed.id, placed.email).catch(() => null)
      if (!live) return
      if (r && (r.status === 'sent' || r.status === 'paid')) return setInvoice(r)
      if (Date.now() - started < 45_000) timer = window.setTimeout(() => void check(), 3000)
    }
    timer = window.setTimeout(() => void check(), 1500)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [cloud, orderInvoice, placed.id, placed.email, placed.delivery])
  return (
    <div className="card mx-auto max-w-lg px-6 py-10 text-center">
      <CheckCircle2 size={36} className="mx-auto text-emerald-600" />
      <h2 className="mt-3 text-xl font-bold">Order #{placed.number} received</h2>
      {invoice ? (
        <>
          <p className="mt-2 text-sm text-slate-600">
            Total <span className="num font-semibold text-slate-900">{money(placed.total)}</span> inc. GST. Invoice{' '}
            <span className="num font-semibold text-slate-900">#{invoice.number}</span> has been emailed to {placed.email}
            {invoice.payLink ? ': pay it now to lock in your order.' : ' with payment options.'} We'll confirm availability and delivery with you.
          </p>
          {invoice.payLink && (
            <a className="btn-primary mt-5 inline-flex" href={invoice.payLink} target="_blank" rel="noreferrer">
              Pay now
            </a>
          )}
        </>
      ) : placed.delivery !== 'pickup' ? (
        <p className="mt-2 text-sm text-slate-600">
          Products total <span className="num font-semibold text-slate-900">{money(placed.total)}</span> inc. GST. Nothing has been charged.
          {placed.delivery === 'same_day'
            ? " We'll confirm whether same-day delivery is possible (or offer the earliest date) and the delivery cost,"
            : " We'll confirm the delivery cost and date,"}{' '}
          then email your invoice to {placed.email}. You only pay once you've agreed them.
        </p>
      ) : (
        <p className="mt-2 text-sm text-slate-600">
          Total <span className="num font-semibold text-slate-900">{money(placed.total)}</span> inc. GST. Nothing has been charged: we'll check
          availability and email you an invoice with payment details.
        </p>
      )}
      {placed.installQuote && (
        <p className="mt-3 text-sm text-slate-600">
          We'll also price the installation you asked for (quote <span className="num">#{placed.installQuote}</span>) and send it to you. You only pay for
          installation if you accept the quote.
        </p>
      )}
      <PaymentSafety className="mx-auto mt-5 max-w-sm text-left" />
      <div className="mt-6 flex justify-center gap-2">
        <button className={invoice?.payLink ? 'btn-ghost' : 'btn-primary'} onClick={onDone}>Keep shopping</button>
      </div>
    </div>
  )
}
