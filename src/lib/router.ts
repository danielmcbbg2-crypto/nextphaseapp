import { useEffect, useState } from 'react'

/**
 * Routing. The public website has real addresses search engines can index ("/store",
 * "/store/<id>/<name>", "/services/<name>"); the signed-in portals keep hash addresses
 * ("#/client/hub"), which are never indexed and which links already sent out (invites) use.
 * An old public hash address ("#/store") is moved to its real one.
 */
const PUBLIC = /^\/?(store|services|privacy|terms)(\/|$)/

const isPublicPath = (path: string) => path === '/' || path === '' || PUBLIC.test(path)

/** The route as segments: "#/client/hub" -> ["client", "hub"]; "/store/sp-1/vanity" -> ["store", "sp-1", "vanity"]. */
function current(): string[] {
  const hash = window.location.hash.replace(/^#\/?/, '')
  // A hash route wins (the portals), unless it's a public page under its old address.
  if (hash && !/^[?&]/.test(hash)) {
    const path = `/${hash.split('?')[0]}`
    if (PUBLIC.test(path)) {
      window.history.replaceState(null, '', path + window.location.search)
      return path.split('/').filter(Boolean)
    }
    // "#/admin/store?quickbooks=connected": the part after "?" is a message for the page, not the route.
    return hash.split('?')[0].split('/').filter(Boolean)
  }
  return window.location.pathname.split('/').filter(Boolean)
}

export const ROUTE_EVENT = 'npm:route'

export function useHashRoute(): string[] {
  const [route, setRoute] = useState(current)
  useEffect(() => {
    const onChange = () => {
      setRoute(current())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    window.addEventListener('popstate', onChange)
    window.addEventListener(ROUTE_EVENT, onChange)
    return () => {
      window.removeEventListener('hashchange', onChange)
      window.removeEventListener('popstate', onChange)
      window.removeEventListener(ROUTE_EVENT, onChange)
    }
  }, [])
  return route
}

/** Goes to a page: public pages by their real address, portal pages by hash (on the site's root). */
export function navigate(path: string) {
  const p = path.startsWith('/') ? path : `/${path}`
  const url = isPublicPath(p.split(/[?#]/)[0]) ? p : `/#${p}`
  if (url === window.location.pathname + window.location.search + window.location.hash) return
  window.history.pushState(null, '', url)
  window.dispatchEvent(new Event(ROUTE_EVENT))
}

/**
 * Plain links to public pages (<a href="/store">) open without reloading the app. Installed once,
 * at start-up; links that open a new tab, or are modified clicks, are left to the browser.
 */
export function interceptLinks() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as Element | null)?.closest?.('a')
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return
    const href = a.getAttribute('href') ?? ''
    if (!href.startsWith('/') || href.startsWith('//')) return
    if (!isPublicPath(href.split(/[?#]/)[0])) return
    e.preventDefault()
    navigate(href)
  })
}
