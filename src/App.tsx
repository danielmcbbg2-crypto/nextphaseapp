import { lazy, Suspense, useEffect } from 'react'
import { ActingAsProvider, useStore } from './lib/store'
import { navigate, useHashRoute } from './lib/router'
import { PublicHome } from './pages/PublicHome'
import { AcceptLinkScreen, SetPasswordScreen } from './components/SignInModal'
import { LogoMark } from './components/Logo'
import { ServicePage } from './pages/ServicePage'
import { LegalPage } from './pages/LegalPage'
import { isLegalPage } from './lib/legal'
import { useNoIndex } from './lib/head'
import { pageView } from './lib/analytics'

// The portals, the shop and the private-link pages load only when opened, so a visitor to the
// public home page doesn't download the whole admin portal first.
const PORTAL_CODE = {
  admin: () => import('./pages/admin/AdminPortal'),
  client: () => import('./pages/client/ClientPortal'),
  provider: () => import('./pages/provider/ProviderPortal'),
}
const AdminPortal = lazy(() => PORTAL_CODE.admin().then((m) => ({ default: m.AdminPortal })))
const ClientPortal = lazy(() => PORTAL_CODE.client().then((m) => ({ default: m.ClientPortal })))
const ProviderPortal = lazy(() => PORTAL_CODE.provider().then((m) => ({ default: m.ProviderPortal })))
const StorePage = lazy(() => import('./pages/store/Shop').then((m) => ({ default: m.StorePage })))
const LeadReply = lazy(() => import('./pages/LeadReply').then((m) => ({ default: m.LeadReply })))
const QuoteLink = lazy(() => import('./pages/QuoteLink').then((m) => ({ default: m.QuoteLink })))
const TwoStepScreen = lazy(() => import('./components/TwoStepScreen').then((m) => ({ default: m.TwoStepScreen })))

function Loading({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-sm text-slate-500">
      <LogoMark size={36} />
      {label}
    </div>
  )
}

export function App() {
  return (
    <Suspense fallback={<Loading label="Loading…" />}>
      <Routes />
    </Suspense>
  )
}

function Routes() {
  const { user, phase, cloud, actingAs, stopActingAs } = useStore()
  const route = useHashRoute()
  const [area = '', section = 'home'] = route
  const isPortal = area === 'client' || area === 'provider' || area === 'admin'
  // An admin who has opened a client's or trade's dashboard may also use that portal.
  const role = actingAs?.role ?? user?.role
  const allowed = !!user && (area === user.role || area === role)
  // The portals and sign-in links are private: kept out of search results.
  useNoIndex(isPortal || area.startsWith('accept') || area === 'reply' || area === 'quote')
  // Page views of the public site (the portals aren't tracked); after the page has set its title.
  const path = route.join('/')
  useEffect(() => {
    if (isPortal || area.startsWith('accept') || area === 'reply' || area === 'quote') return
    const t = setTimeout(pageView, 0)
    return () => clearTimeout(t)
  }, [path, isPortal, area])

  // Start downloading a portal's code while the account and its data load, not after.
  useEffect(() => {
    const r = role ?? (isPortal && phase === 'loading' ? area : null)
    if (r === 'admin' || r === 'client' || r === 'provider') void PORTAL_CODE[r]().catch(() => {})
  }, [role, isPortal, area, phase])

  // Portals are role-locked: signed-out users go home, others to their own portal.
  useEffect(() => {
    if (!isPortal || phase !== 'ready') return
    if (!user) navigate('/')
    else if (!allowed) navigate(`/${role}`)
  }, [isPortal, user, allowed, role, phase])

  // Arriving in the admin portal (Back to accounts, its tabs, the browser's back button) leaves the
  // opened dashboard. Keyed on the route alone: opening a dashboard starts it just before leaving admin.
  useEffect(() => {
    if (area === 'admin') stopActingAs()
  }, [area, stopActingAs])

  // Before the set-password check, so a half-finished setup on this browser can't take over a new link.
  if (cloud && area.startsWith('accept')) {
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
    return <AcceptLinkScreen tokenHash={q.get('token_hash') ?? ''} type={q.get('type') ?? ''} purpose={q.get('for') ?? ''} />
  }
  // A Service.com.au lead's reply page, from the link texted to the office (the link is the key).
  if (area === 'reply' && route[1]) return <LeadReply token={route[1]} />
  // A client's quote, from the private link sent with it (the link is the key).
  if (area === 'quote' && route[1]) return <QuoteLink token={route[1]} />
  if (phase === 'set-password') return <SetPasswordScreen />
  // The shop is open to everyone, signed in or not.
  if (area === 'store') return <StorePage productId={route[1]} />
  if (area === 'services') return <ServicePage slug={route[1] ?? ''} />
  // Privacy Policy and Terms of Use: public, indexed pages.
  if (isLegalPage(area)) return <LegalPage slug={area} />
  // An admin who has only entered their password: the second step, before anything else of theirs.
  if (phase === 'two-step') return <TwoStepScreen />
  if (isPortal && phase === 'loading') return <Loading label="Loading your portal…" />
  if (!isPortal || !allowed) return <PublicHome />
  if (area === 'admin') return <AdminPortal section={section} />
  return <ActingAsProvider>{area === 'client' ? <ClientPortal section={section} /> : <ProviderPortal section={section} />}</ActingAsProvider>
}
