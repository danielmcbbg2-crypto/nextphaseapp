import { useEffect, useState, type MouseEvent } from 'react'
import { ArrowRight, Mail, MapPin, Menu, Phone, X } from 'lucide-react'
import { Logo } from '../components/Logo'
import { SignInModal } from '../components/SignInModal'
import { BRAND, SITE_COPY, SITE_SERVICES } from '../lib/brand'
import { useStore } from '../lib/store'
import { navigate } from '../lib/router'
import { LeadCapture, REQUEST_SERVICES, RequestMaintenanceModal, SERVICE_ICONS } from './LeadCapture'
import { SITE_URL, usePageMeta } from '../lib/head'
import { HOME_META } from '../lib/seo'
import { serviceByName, servicePath } from '../lib/services'
import { ServiceLinks } from './ServicePage'
import interiorPhoto from '../assets/photos/interior.webp'
import residentialPhoto from '../assets/photos/residential.webp'
import commercialPhoto from '../assets/photos/commercial.webp'
import conciergePhoto from '../assets/photos/concierge.webp'
import { PaymentSafety } from '../components/PaymentSafety'

const [EMAIL_LOCAL, EMAIL_DOMAIN] = BRAND.email.split('@')

function jump(id: string) {
  return (e: MouseEvent) => {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }
}

const NAV = [
  ['about', 'About'],
  ['services', 'Services'],
  ['quote', 'Request maintenance'],
  ['portal', 'Client portal'],
  ['coverage', 'Coverage'],
  ['contact', 'Contact'],
] as const

/** Text-and-photo block in the website's alternating, uneven layout. */
function Feature({ title, body, photo, alt, flip }: { title: string; body: string; photo: string; alt: string; flip?: boolean }) {
  return (
    <div className={`grid items-start gap-10 md:gap-16 ${flip ? 'md:grid-cols-[7fr_5fr]' : 'md:grid-cols-[5fr_7fr]'}`}>
      <div className={`md:pt-12 ${flip ? 'md:order-2' : ''}`}>
        <h2 className="rule-above text-2xl font-bold sm:text-[28px]">{title}</h2>
        <p className="mt-6 max-w-md text-base font-light leading-[1.8] text-slate-900">{body}</p>
      </div>
      <img src={photo} alt={alt} className={`aspect-[16/13] w-full object-cover md:aspect-[17/16] ${flip ? 'md:order-1' : ''}`} loading="lazy" />
    </div>
  )
}

export function PublicHome() {
  const { user, authNotice } = useStore()
  const [signIn, setSignIn] = useState(false)
  // The maintenance-request pop-up; a fresh form each time it opens (with the service tapped, if any).
  const [request, setRequest] = useState<{ key: number; service?: string } | null>(null)
  const openRequest = (service?: string) => (user ? navigate(`/${user.role}`) : setRequest({ key: Date.now(), service }))
  const [menuOpen, setMenuOpen] = useState(false)
  usePageMeta(HOME_META(SITE_URL))
  const openPortal = () => (user ? navigate(`/${user.role}`) : setSignIn(true))

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-5 text-[15px] text-slate-900 md:flex lg:gap-7">
            {NAV.map(([id, label]) => (
              <a key={id} href={`#${id}`} onClick={jump(id)} className="hover:text-accent-ink">
                {label}
              </a>
            ))}
            <a href="/store" className="font-semibold hover:text-accent-ink">
              Shop
            </a>
          </nav>
          <div className="flex items-center gap-2">
            {user ? (
              <button className="btn-accent text-[15px] font-normal" onClick={() => navigate(`/${user.role}`)}>
                Open portal <ArrowRight size={16} />
              </button>
            ) : (
              <button className="btn-accent text-[15px] font-normal" onClick={() => setSignIn(true)}>
                Sign in
              </button>
            )}
            <button
              type="button"
              className="-mr-2 inline-flex h-10 w-10 items-center justify-center text-slate-900 hover:text-accent-ink md:hidden"
              aria-label="Menu"
              aria-expanded={menuOpen}
              aria-controls="site-menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <X size={22} strokeWidth={1.75} /> : <Menu size={22} strokeWidth={1.75} />}
            </button>
          </div>
        </div>
        {/* Overlays the page instead of pushing it down, so the scroll target doesn't move when it closes. */}
        <div id="site-menu" hidden={!menuOpen} className="absolute inset-x-0 top-full border-b border-slate-200 bg-white md:hidden">
          <nav className="mx-auto max-w-7xl px-4 py-2 sm:px-6">
            {NAV.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                onClick={(e) => {
                  jump(id)(e)
                  setMenuOpen(false)
                }}
                className="block border-b border-slate-100 py-3.5 text-base text-slate-900 last:border-b-0 hover:text-accent-ink"
              >
                {label}
              </a>
            ))}
            <a href="/store" className="block py-3.5 text-base font-semibold text-slate-900 hover:text-accent-ink">
              Shop
            </a>
          </nav>
        </div>
      </header>

      {authNotice && !user && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-center text-sm text-red-700">{authNotice}</div>
      )}

      {/* Hero: full-bleed interior photo with the website's headline */}
      <section className="relative isolate overflow-hidden bg-[#3d342d]">
        <img src={interiorPhoto} alt="" fetchPriority="high" decoding="async" className="absolute inset-0 -z-10 h-full w-full object-cover object-[70%_50%]" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-black/45 via-black/20 to-transparent" />
        {/* Below lg the text sits over the bright sofa, so darken the whole photo a little more. */}
        <div className="absolute inset-0 -z-10 bg-black/25 lg:hidden" />
        <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 sm:py-32 lg:py-40">
          <h1 className="max-w-[40rem] text-[2.75rem] font-bold leading-[1.12] text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.35)] sm:text-6xl sm:leading-[1.12] lg:text-[5.5rem] lg:leading-[1.15]">
            {SITE_COPY.heroTitle}
          </h1>
          <p className="mt-6 text-xl font-light text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.35)] sm:text-2xl lg:text-[30px]">
            {SITE_COPY.heroSubtitle}
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <a href="#about" onClick={jump('about')} className="btn-accent w-full border border-transparent px-6 py-3.5 text-base font-normal sm:w-52">
              Learn More About Us
            </a>
            <button
              type="button"
              onClick={() => openRequest()}
              className="btn w-full border border-white px-6 py-3.5 text-base font-normal text-white hover:bg-white hover:text-slate-900 sm:w-52"
            >
              Request Maintenance
            </button>
          </div>
          <p className="mt-10 text-sm text-white/80">
            Melbourne, VIC <span className="mx-2 text-white/40">/</span> ABN {BRAND.abn}
          </p>
        </div>
      </section>

      {/* Residential, commercial and specialised services, as on the website */}
      <section id="about" className="scroll-mt-16">
        <div className="mx-auto grid max-w-[88rem] gap-20 px-4 py-20 sm:px-6 sm:py-28">
          <Feature title={SITE_COPY.residential.title} body={SITE_COPY.residential.body} photo={residentialPhoto} alt="Open-plan home with timber stairs and dining area" />
          <Feature title={SITE_COPY.commercial.title} body={SITE_COPY.commercial.body} photo={commercialPhoto} alt="Team meeting in a glass-walled office" flip />
          {/* The website pairs this with a Sydney skyline photo, left out on purpose; only its inset photo is kept. */}
          <div>
            <h2 className="rule-above text-2xl font-bold sm:text-[28px]">{SITE_COPY.specialized.title}</h2>
            <img src={conciergePhoto} alt="Hotel concierge at a reception desk" className="mt-8 w-full max-w-[460px]" loading="lazy" />
            <p className="mt-8 max-w-md text-base font-light leading-[1.8] text-slate-900">{SITE_COPY.specialized.body}</p>
          </div>
        </div>
      </section>

      <section id="services" className="scroll-mt-16 border-t border-slate-200">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-lg text-slate-900">{SITE_COPY.servicesEyebrow}</p>
              <h2 className="mt-2 text-4xl font-bold leading-[1.15] text-accent-heading sm:text-[42px] sm:leading-[1.2]">{SITE_COPY.servicesTitle}</h2>
              <p className="mt-6 max-w-lg text-base font-light leading-[1.8]">{SITE_COPY.servicesIntro}</p>
            </div>
            {/* Signed-in clients lodge it in their portal; everyone else gets the request pop-up. */}
            <button className="btn-accent shrink-0 self-start px-7 py-3.5 text-base font-normal" onClick={() => openRequest()}>
              Request a Service
            </button>
          </div>
          <ul className="mt-12 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {SITE_SERVICES.map((name) => {
              const Icon = SERVICE_ICONS[name]
              const requestable = (REQUEST_SERVICES as readonly string[]).includes(name)
              const tile = (
                <>
                  <Icon strokeWidth={1.25} className="h-10 w-10 text-accent sm:h-[52px] sm:w-[52px]" aria-hidden="true" />
                  <span className="mt-4 text-base leading-snug text-slate-900 sm:mt-6 sm:text-[22px]">{name}</span>
                  <span className="mt-auto flex items-center gap-1.5 pt-4 text-sm text-slate-500 transition-colors group-hover:text-accent-ink">
                    {requestable ? 'Request' : 'Ask us'} <ArrowRight size={14} aria-hidden="true" />
                  </span>
                </>
              )
              const cls = 'group flex h-full min-h-[150px] w-full flex-col bg-white p-5 text-left transition-shadow hover:shadow-lg sm:min-h-[220px] sm:p-10'
              const page = serviceByName(name)
              return (
                <li key={name} className="flex flex-col">
                  {requestable ? (
                    <button type="button" className={cls} onClick={() => openRequest(name)} aria-label={`Request ${name}`}>
                      {tile}
                    </button>
                  ) : (
                    <a href="#contact" onClick={jump('contact')} className={cls} aria-label={`Ask us about ${name}`}>
                      {tile}
                    </a>
                  )}
                  {page && (
                    <a href={servicePath(page)} className="bg-white px-5 pb-4 text-sm text-slate-600 underline-offset-2 hover:text-accent-ink hover:underline sm:px-10">
                      More about {name.replace(/ Services$/, '').toLowerCase()}
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </section>

      <LeadCapture onRequest={() => openRequest()} onSignIn={() => setSignIn(true)} />

      <section id="portal" className="scroll-mt-16 bg-white">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-3">
          <div>
            <h2 className="rule-above text-2xl font-bold sm:text-[28px]">One portal for every job</h2>
            <p className="mt-6 text-base font-light leading-[1.8]">
              Clients, trades and our office work from the same live record, from the first photo to the final invoice.
            </p>
            <button className="btn-accent mt-8 px-7 py-3.5 text-base font-normal" onClick={openPortal}>
              {user ? 'Open your portal' : 'Client & trade sign in'}
            </button>
          </div>
          <ol className="grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:col-span-2">
            {[
              ['Lodge a request', 'Submit jobs with photos from the client portal. Urgent jobs alert our team by SMS straight away.'],
              ['We triage & dispatch', 'We assign the right licensed tradesperson, confirm the visit and keep you updated.'],
              ['Track it live', 'Follow progress, completion photos and project milestones in your Maintenance Hub.'],
              ['Invoiced & recorded', 'Invoices are issued through QuickBooks, and paint colours and finishes are kept on your property record.'],
            ].map(([title, body], i) => (
              <li key={title} className="border-t-2 border-slate-900 pt-5">
                <span className="text-sm text-accent-ink">Step {i + 1}</span>
                <h3 className="mt-1 text-xl font-bold">{title}</h3>
                <p className="mt-2 font-light leading-relaxed">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-slate-900 text-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-bold sm:text-[28px]">Shop bathroom & kitchen fixtures</h2>
            <p className="mt-3 max-w-xl text-base font-light leading-[1.8] text-white/80">
              Vanities, shower screens, tapware and more, from the brands we install. Order online; we confirm, invoice and deliver or fit.
            </p>
          </div>
          <a href="/store" className="btn-accent shrink-0 px-7 py-3.5 text-base font-normal">
            Visit the shop <ArrowRight size={16} />
          </a>
        </div>
      </section>

      <section id="coverage" className="scroll-mt-16">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24">
          <h2 className="rule-above text-2xl font-bold sm:text-[28px]">Melbourne coverage</h2>
          <p className="mt-6 max-w-xl text-base font-light leading-[1.8]">Metropolitan Melbourne. Ask us about properties outside these areas.</p>
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {BRAND.coverage.map((c) => (
              <div key={c.region} className="bg-white p-7">
                <MapPin size={28} strokeWidth={1.25} className="text-accent" aria-hidden="true" />
                <h3 className="mt-4 text-lg font-bold">{c.region}</h3>
                <p className="mt-2 font-light leading-relaxed">{c.suburbs}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="contact" className="scroll-mt-16 bg-white">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 md:grid-cols-2">
          <div>
            <h2 className="rule-above text-2xl font-bold sm:text-[28px]">Get in Touch</h2>
            <p className="mt-6 text-base font-light leading-[1.8]">Quotes, subscription maintenance plans and urgent repairs.</p>
            <ul className="mt-6 space-y-4 text-base sm:text-lg">
              {BRAND.phone && (
                <li className="flex items-center gap-3">
                  <Phone size={20} strokeWidth={1.5} className="shrink-0 text-accent" aria-hidden="true" />
                  <a href={`tel:${BRAND.phone.replace(/\s/g, '')}`} className="hover:text-accent-ink">
                    {BRAND.phone}
                  </a>
                </li>
              )}
              <li className="flex items-center gap-3">
                <Mail size={20} strokeWidth={1.5} className="shrink-0 text-accent" aria-hidden="true" />
                {/* <wbr> lets a narrow screen wrap the address only after the @. */}
                <a href={`mailto:${BRAND.email}`} className="min-w-0 hover:text-accent-ink">
                  {EMAIL_LOCAL}@<wbr />
                  {EMAIL_DOMAIN}
                </a>
              </li>
              <li className="flex items-center gap-3">
                <MapPin size={20} strokeWidth={1.5} className="shrink-0 text-accent" aria-hidden="true" />
                <span>{BRAND.city}</span>
              </li>
            </ul>
          </div>
          <div className="self-start bg-slate-50">
            <p className="border-b border-slate-200 px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-500">Business hours</p>
            {BRAND.hours.map((h) => (
              <div key={h.days} className="flex justify-between gap-4 border-b border-slate-200 px-6 py-4 last:border-b-0">
                <span className="font-semibold">{h.days}</span>
                <span className="text-right font-light">{h.time}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="bg-slate-900 text-white">
        <ServiceLinks className="mx-auto max-w-7xl px-4 pt-12 text-white/80 sm:px-6" />
        <PaymentSafety inverted className="mx-auto max-w-7xl px-4 pt-8 sm:px-6" />
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-12 sm:flex-row sm:items-end sm:justify-between sm:px-6">
          <Logo inverted />
          <div className="text-sm text-white/70 sm:text-right">
            <nav aria-label="Legal" className="mb-2 flex gap-4 sm:justify-end">
              <a href="/privacy" className="hover:text-white hover:underline">Privacy Policy</a>
              <a href="/terms" className="hover:text-white hover:underline">Terms of Use</a>
            </nav>
            <p>
              © {new Date().getFullYear()} {BRAND.name} · {BRAND.city}
            </p>
            <p className="mt-1">
              ABN <span className="text-white">{BRAND.abn}</span>
            </p>
          </div>
        </div>
      </footer>

      <SignInModal open={signIn} onClose={() => setSignIn(false)} />
      {request && <RequestMaintenanceModal key={request.key} open service={request.service} onClose={() => setRequest(null)} />}
    </div>
  )
}
