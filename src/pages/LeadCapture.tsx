import { useRef, useState, type ComponentType, type DragEvent, type FormEvent, type ReactNode, type SVGProps } from 'react'
import { track } from '../lib/analytics'
import { ArrowRight, CalendarCheck, Camera, Check, CheckCircle2, Clock3, FileText, Hammer, ImagePlus, Paintbrush, ShieldCheck, Wrench, X, Zap } from 'lucide-react'
import { Modal } from '../components/ui'
import { Trowel, TwinGears, Worker } from '../components/ServiceIcons'
import { BRAND, SITE_SERVICES } from '../lib/brand'
import { useStore, type LeadInput } from '../lib/store'
import { LEAD_URGENCY_LABEL, type LeadUrgency } from '../lib/types'
import { imageToDataUrl } from '../lib/utils'

type ServiceIcon = ComponentType<Pick<SVGProps<SVGSVGElement>, 'className' | 'strokeWidth' | 'aria-hidden'>>

export const SERVICE_ICONS: Record<(typeof SITE_SERVICES)[number], ServiceIcon> = {
  'Plumbing Services': Wrench,
  'Electrical Services': Zap,
  'Painting and Decorating': Paintbrush,
  'Handyman Services': Worker,
  'Carpentry Services': Hammer,
  'Plastering Services': Trowel,
  'Emergency Repairs': TwinGears,
  'Subscription Packages': CalendarCheck,
}

/** What a visitor can ask us to come and do (a subscription is arranged with the office instead). */
export const REQUEST_SERVICES = SITE_SERVICES.filter((s) => s !== 'Subscription Packages')
const shortName = (s: string) => s.replace(/ Services$/, '')

const PROMISES = [
  { icon: Clock3, title: 'A reply within one business day', body: 'A real person from our Melbourne office, not an auto-responder.' },
  { icon: FileText, title: 'Clear, itemised quotes', body: 'Every line priced, GST shown, no surprises once work starts.' },
  { icon: ShieldCheck, title: 'Licensed & insured trades', body: 'Plumbers, electricians and carpenters we know and stand behind.' },
]

const STEPS = [
  { icon: Wrench, title: 'Pick the service', body: 'Plumbing, electrical, carpentry and more.' },
  { icon: Camera, title: 'Add a few photos', body: 'So the right tradesperson turns up with the right gear.' },
  { icon: Clock3, title: 'We call you back', body: 'With a time and a price, within one business day.' },
]

const URGENCIES: LeadUrgency[] = ['urgent', 'soon', 'flexible']
const MAX_PHOTOS = 6

const blank = (service = '', message = ''): LeadInput & { website: string } => ({
  service,
  photos: [],
  name: '',
  email: '',
  phone: '',
  company: '',
  suburb: '',
  urgency: 'soon',
  contactBy: 'phone',
  message,
  website: '',
})

/** A button that acts like a radio button, styled to sit in a row of options. */
function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border px-3.5 py-2 text-sm transition-colors ${
        on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-900'
      }`}
    >
      {on && <Check size={14} aria-hidden="true" />}
      {children}
    </button>
  )
}

function StepTitle({ n, children, hint }: { n: number; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="num text-xs font-semibold text-accent-ink">{String(n).padStart(2, '0')}</span>
      <span className="font-semibold">{children}</span>
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </div>
  )
}

/** Photos picked (or dropped) from the visitor's device, shrunk in the browser before upload. */
function PhotoPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  // The photos as they are now: shrinking new ones takes a moment, and one may be removed meanwhile.
  const latest = useRef(value)
  latest.current = value
  const add = async (files: FileList | null) => {
    const images = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    setBusy(true)
    setError(null)
    try {
      const room = MAX_PHOTOS - value.length
      if (images.length > room) setError(`Up to ${MAX_PHOTOS} photos: the first ${room} were added.`)
      const added = await Promise.all(images.slice(0, room).map((f) => imageToDataUrl(f)))
      const now = latest.current
      onChange([...now, ...added.filter((src) => !now.includes(src))].slice(0, MAX_PHOTOS))
    } catch {
      setError('One of those photos couldn’t be read. Try a JPEG or PNG.')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    void add(e.dataTransfer.files)
  }
  return (
    <div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {value.map((src, i) => (
          <div key={src} className="relative aspect-square overflow-hidden border border-slate-200">
            <img src={src} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x !== src))}
              className="absolute right-1 top-1 bg-white/90 p-0.5 text-slate-700 shadow-sm hover:bg-white"
              aria-label={`Remove photo ${i + 1}`}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {value.length < MAX_PHOTOS && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
            disabled={busy}
            className={`flex flex-col items-center justify-center gap-1 border border-dashed text-xs transition-colors ${
              over ? 'border-accent bg-accent/5 text-slate-900' : 'border-slate-300 text-slate-500 hover:border-slate-900 hover:text-slate-900'
            } ${value.length === 0 ? 'col-span-3 py-8 sm:col-span-6' : 'aspect-square'}`}
          >
            <ImagePlus size={value.length === 0 ? 28 : 20} strokeWidth={1.5} aria-hidden="true" />
            {busy ? 'Adding…' : value.length === 0 ? 'Add photos of the job (tap, or drop them here)' : 'Add more'}
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*" multiple className="hidden" aria-label="Photos of the job" onChange={(e) => void add(e.target.files)} />
      {error && <p className="mt-2 text-xs text-amber-700">{error}</p>}
    </div>
  )
}

/** The pop-up: a maintenance request from someone without an account, with photos, sent to the office. */
/** `message` starts the description off, e.g. the product to supply and install. */
export function RequestMaintenanceModal({ open, service, message, onClose }: { open: boolean; service?: string; message?: string; onClose: () => void }) {
  const { submitLead } = useStore()
  const [f, setF] = useState(() => blank(service, message))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<{ number: number; name: string; contact: string } | null>(null)
  const set = (patch: Partial<typeof f>) => {
    setF((cur) => ({ ...cur, ...patch }))
    setError(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    // A filled-in hidden field means a bot: look as if it worked and send nothing.
    if (f.website) return setSent({ number: 0, name: '', contact: '' })
    const missing = !f.service
      ? 'Choose the service you need.'
      : f.photos.length === 0
        ? 'Add at least one photo of the job.'
        : !f.message.trim()
          ? 'Tell us what needs doing.'
          : !f.name.trim()
            ? 'Enter your name.'
            : !f.phone.trim() && !f.email.trim()
              ? 'Leave a phone number or email so we can reply.'
              : null
    if (missing) return setError(missing)
    setBusy(true)
    setError(null)
    try {
      const contactBy = f.contactBy === 'phone' && !f.phone.trim() ? 'email' : f.contactBy === 'email' && !f.email.trim() ? 'phone' : f.contactBy
      const { number } = await submitLead({
        service: f.service,
        photos: f.photos,
        name: f.name,
        email: f.email,
        phone: f.phone,
        company: f.company,
        suburb: f.suburb,
        urgency: f.urgency,
        contactBy,
        message: f.message,
      })
      track('generate_lead', { service: f.service })
      setSent({ number, name: f.name.trim().split(/\s+/)[0], contact: contactBy === 'phone' ? `call you on ${f.phone.trim()}` : `email you at ${f.email.trim()}` })
      setF(blank())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={sent ? 'Request sent' : 'Request maintenance'} width="max-w-3xl">
      {sent ? (
        <div className="flex flex-col items-start py-6" role="status">
          <CheckCircle2 size={44} strokeWidth={1.25} className="text-accent" aria-hidden="true" />
          <h3 className="mt-6 text-2xl font-bold">Thanks{sent.name ? `, ${sent.name}` : ''}. We've got it.</h3>
          {sent.number > 0 && <p className="num mt-2 text-sm text-slate-500">Request #{sent.number}</p>}
          <p className="mt-4 max-w-md font-light leading-[1.8]">
            {sent.contact ? `We'll ${sent.contact} within one business day.` : "We'll be in touch within one business day."}
            {BRAND.phone && (
              <>
                {' '}For anything urgent, call us on{' '}
                <a className="font-normal underline underline-offset-4" href={`tel:${BRAND.phone.replace(/\s/g, '')}`}>{BRAND.phone}</a>.
              </>
            )}
          </p>
          <button type="button" className="btn-primary mt-8" onClick={onClose}>Done</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-8" noValidate>
          <p className="-mt-1 text-sm text-slate-600">No account needed. Takes about two minutes.</p>
          <section>
            <StepTitle n={1}>Which service do you need?</StepTitle>
            <div role="radiogroup" aria-label="Service" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {REQUEST_SERVICES.map((s) => {
                const Icon = SERVICE_ICONS[s]
                const on = f.service === s
                return (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ service: s })}
                    className={`relative flex flex-col items-start gap-3 border p-3 text-left text-sm transition-colors ${
                      on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-800 hover:border-slate-900'
                    }`}
                  >
                    <Icon strokeWidth={1.25} className={`h-7 w-7 ${on ? 'text-white' : 'text-accent'}`} aria-hidden="true" />
                    <span className="leading-snug">{shortName(s)}</span>
                    {on && <Check size={14} className="absolute right-2 top-2" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          </section>

          <section>
            <StepTitle n={2} hint={`At least one, up to ${MAX_PHOTOS}`}>Photos of the job</StepTitle>
            <PhotoPicker value={f.photos} onChange={(photos) => set({ photos })} />
          </section>

          <section>
            <StepTitle n={3}>What needs doing?</StepTitle>
            <textarea
              className="input min-h-[100px]"
              aria-label="What needs doing"
              maxLength={2000}
              value={f.message}
              onChange={(e) => set({ message: e.target.value })}
              placeholder="e.g. Kitchen tap leaking at the base; access via the side gate"
            />
            <div role="radiogroup" aria-label="How soon" className="mt-3 flex flex-wrap gap-2">
              {URGENCIES.map((u) => (
                <Choice key={u} on={f.urgency === u} onClick={() => set({ urgency: u })}>
                  {LEAD_URGENCY_LABEL[u]}
                </Choice>
              ))}
            </div>
          </section>

          <section>
            <StepTitle n={4}>Your details</StepTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="label">Your name</span>
                <input className="input" autoComplete="name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Company (optional)</span>
                <input className="input" autoComplete="organization" value={f.company} onChange={(e) => set({ company: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Mobile</span>
                <input className="input num" type="tel" autoComplete="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Email</span>
                <input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Suburb</span>
                <input className="input" autoComplete="address-level2" value={f.suburb} onChange={(e) => set({ suburb: e.target.value })} placeholder="e.g. Carlton" />
              </label>
              <div>
                <span className="label">Best way to reach you</span>
                <div role="radiogroup" aria-label="Best way to reach you" className="flex gap-2">
                  <Choice on={f.contactBy === 'phone'} onClick={() => set({ contactBy: 'phone' })}>Phone</Choice>
                  <Choice on={f.contactBy === 'email'} onClick={() => set({ contactBy: 'email' })}>Email</Choice>
                </div>
              </div>
              {/* Hidden from people; bots fill it in. */}
              <label className="hidden" aria-hidden="true">
                Website
                <input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set({ website: e.target.value })} />
              </label>
            </div>
          </section>

          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <div className="flex flex-col gap-4 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-relaxed text-slate-500 sm:max-w-xs">Your photos and details only go to our office, to reply to this request.</p>
            <button className="btn-accent shrink-0 px-7 py-3.5 text-base font-normal" disabled={busy}>
              {busy ? (f.photos.length ? 'Uploading photos…' : 'Sending…') : 'Send request'} {!busy && <ArrowRight size={16} />}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}

/** Home page section: what happens when you ask us for maintenance, and the button that opens the pop-up. */
export function LeadCapture({ onRequest, onSignIn }: { onRequest: () => void; onSignIn: () => void }) {
  return (
    <section id="quote" className="scroll-mt-16 bg-slate-900 text-white" aria-labelledby="quote-title">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[5fr_7fr] lg:gap-16">
        <div className="lg:pt-6">
          <p className="text-sm uppercase tracking-[0.2em] text-accent">Maintenance requests · No account needed</p>
          <h2 id="quote-title" className="mt-4 text-4xl font-bold leading-[1.15] sm:text-[42px]">Something need fixing?</h2>
          <p className="mt-6 max-w-md text-base font-light leading-[1.8] text-white/80">
            Tell us which service you need and send a few photos. We'll come back to you with a time and a price.
          </p>
          <ul className="mt-10 space-y-6">
            {PROMISES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center border border-white/20">
                  <Icon size={20} strokeWidth={1.5} className="text-accent" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-semibold">{title}</p>
                  <p className="mt-0.5 text-sm font-light leading-relaxed text-white/70">{body}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-10 text-sm text-white/60">
            Already a client?{' '}
            <button type="button" className="text-white underline underline-offset-4 hover:text-accent" onClick={onSignIn}>
              Sign in to lodge a request
            </button>
          </p>
        </div>

        <div className="self-start bg-white p-6 text-slate-900 shadow-2xl sm:p-10">
          <ol className="space-y-7">
            {STEPS.map(({ icon: Icon, title, body }, i) => (
              <li key={title} className="flex gap-5">
                <span className="num w-6 shrink-0 pt-0.5 text-sm font-semibold text-accent-ink">{String(i + 1).padStart(2, '0')}</span>
                <div className="flex-1 border-b border-slate-100 pb-6">
                  <p className="flex items-center gap-2 text-lg font-bold">
                    <Icon size={18} strokeWidth={1.5} className="text-accent" aria-hidden="true" />
                    {title}
                  </p>
                  <p className="mt-1 font-light text-slate-600">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" className="btn-accent mt-8 w-full px-7 py-4 text-base font-normal" onClick={onRequest}>
            Request maintenance <ArrowRight size={16} />
          </button>
          <p className="mt-3 text-center text-xs text-slate-500">Takes about two minutes. Have your photos ready.</p>
        </div>
      </div>
    </section>
  )
}
