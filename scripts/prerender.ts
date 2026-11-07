// Runs after `vite build`: writes each public page (home, shop, services, every published product)
// into dist/ as its own index.html with its title, description, canonical address, link preview and
// structured data already in the <head>, plus its words and links in the page, so search engines
// and link previews (Facebook, WhatsApp, Messages) read it without running the app. Then writes
// sitemap.xml, robots.txt and Netlify's _redirects (everything else loads the app).
//
// Products come from the database with the public (anon) key, as visitors see them. Without the
// Supabase settings (or if it can't be reached) the products are left out and the rest still built.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BRAND } from '../src/lib/brand'
import { complianceFacts, DEFAULT_SITE_URL, HOME_META, pageTitle, productMeta, productPath, STORE_META, breadcrumbJsonLd, businessJsonLd, type PageMeta, type ProductForSeo } from '../src/lib/seo'
import { SERVICE_PAGES, servicePath } from '../src/lib/services'
import { STORE_INFO_PAGES, storeInfoSections } from '../src/lib/storePolicy'
import { LEGAL_LINKS, LEGAL_PAGES, legalSections } from '../src/lib/legal'

const DIST = 'dist'
const SITE = (process.env.VITE_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '')
const template = readFileSync(join(DIST, 'index.html'), 'utf8')
const VERIFY = (process.env.GOOGLE_SITE_VERIFICATION ?? '').trim().replace(/^.*content="([^"]+)".*$/s, '$1')

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// JSON inside <script>: no closing tags or HTML comments can sneak out.
const ldJson = (o: object) => JSON.stringify(o).replace(/</g, '\\u003c')

async function products(): Promise<ProductForSeo[]> {
  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    console.log('prerender: no Supabase settings, so no product pages')
    return []
  }
  try {
    const get = (cols: string) =>
      fetch(`${url.replace(/\/+$/, '')}/rest/v1/products?status=eq.published&select=${cols}&order=title`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20000),
      })
    const basic = 'id,title,description,category,brand,sku,price,images,stock,options'
    let res = await get(`${basic},specs,highlights,seo_title,meta_description,image_alt,gtin,compliance`)
    // A database without the listing details yet (migration 20261107000000 not applied): the basics still build.
    if (res.status === 400) res = await get(basic)
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    type Row = ProductForSeo & { price: number | string; seo_title?: string; meta_description?: string; image_alt?: string[] }
    const rows = (await res.json()) as Row[]
    return rows.map(({ seo_title, meta_description, image_alt, ...r }) => ({
      ...r,
      seoTitle: seo_title ?? '',
      metaDescription: meta_description ?? '',
      imageAlt: image_alt ?? [],
      price: Number(r.price),
      images: r.images ?? [],
      options: (r.options ?? []).map((g) => ({ values: g.values.map((v) => ({ price: Number(v.price), available: v.available !== false })) })),
    }))
  } catch (e) {
    console.warn(`prerender: couldn't load products (${(e as Error).message}); building without them`)
    return []
  }
}

/** The page's own <head> tags, and its words and links for crawlers (the app replaces them when it starts). */
function render(m: PageMeta, body: string, extraHead: string[] = []): string {
  const url = `${SITE}${m.path}`
  const title = pageTitle(m.title)
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(m.description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:site_name" content="${esc(BRAND.name)}" />`,
    `<meta property="og:locale" content="en_AU" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(m.description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:type" content="${m.type ?? 'website'}" />`,
    ...(m.image ? [`<meta property="og:image" content="${esc(m.image)}" />`] : []),
    ...(m.image && m.imageAlt ? [`<meta property="og:image:alt" content="${esc(m.imageAlt)}" />`] : []),
    `<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}" />`,
    // Proves to Google Search Console that the site is ours (its "HTML tag" method).
    ...(VERIFY ? [`<meta name="google-site-verification" content="${esc(VERIFY)}" />`] : []),
    ...(m.jsonLd ?? []).map((ld) => `<script type="application/ld+json" data-page-ld>${ldJson(ld)}</script>`),
    ...extraHead,
  ].join('\n    ')
  return template
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/<meta name="description"[^>]*>/, '')
    .replace('</head>', `    ${head}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${body}</div>`)
}

function write(path: string, html: string) {
  const file = join(DIST, path === '/' ? 'index.html' : join(path.replace(/^\//, ''), 'index.html'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, html)
}

/** A product's specs and compliance details, as table rows. */
const specRows = (p: ProductForSeo) => [...(p.specs ?? []).map((s) => ({ name: s.label, value: s.value })), ...complianceFacts(p)]

const link = (href: string, text: string) => `<a href="${esc(href)}">${esc(text)}</a>`
const list = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`
const nav = `<nav>${link('/', 'Home')} · ${link('/store', 'Shop')} · ${SERVICE_PAGES.map((s) => link(servicePath(s), s.name)).join(' · ')}</nav>`

const all = await products()
const pages: { path: string; lastmod?: string }[] = []

// Home
const home = HOME_META(SITE)
// The hero photo is the largest thing on the home page; the app only asks for it once its code has
// run, so tell the browser about it straight away.
const hero = readdirSync(join(DIST, 'assets')).find((f) => /^interior-.*\.webp$/.test(f))
const heroPreload = hero ? [`<link rel="preload" as="image" type="image/webp" href="/assets/${hero}" fetchpriority="high" />`] : []
write('/', render(home, `<main><h1>${esc(BRAND.name)}</h1><p>${esc(home.description)}</p>${nav}</main>`, heroPreload))
pages.push({ path: '/' })

// Shop
const store = STORE_META(SITE)
write(
  '/store',
  render(
    { ...store, jsonLd: [...(store.jsonLd ?? []), { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: all.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}${productPath(p)}`, name: p.title })) }] },
    `<main><h1>Shop</h1><p>${esc(store.description)}</p>${list(all.map((p) => link(productPath(p), p.title)))}${nav}</main>`,
  ),
)
pages.push({ path: '/store' })

// The shop's information pages (delivery, returns, privacy, contact)
for (const info of STORE_INFO_PAGES) {
  const path = `/store/${info.slug}`
  write(
    path,
    render(
      { title: info.title, description: info.description, path, jsonLd: [breadcrumbJsonLd(SITE, [{ name: 'Home', path: '/' }, { name: 'Shop', path: '/store' }, { name: info.name, path }])] },
      `<main><h1>${esc(info.title)}</h1>${storeInfoSections(info.slug)
        .map((sec) => `<h2>${esc(sec.title)}</h2>${sec.paragraphs.map((t) => `<p>${esc(t).replaceAll('{email}', link(`mailto:${BRAND.email}`, BRAND.email)).replaceAll('{phone}', esc(BRAND.phone))}</p>`).join('')}`)
        .join('')}${link('/store', 'Back to the shop')}${nav}</main>`,
    ),
  )
  pages.push({ path })
}

// Legal pages (Privacy Policy, Terms of Use). {tokens} in the wording become links.
const legalText = (t: string) =>
  t
    .split(/(\{[a-z]+\})/)
    .map((part) => {
      const l = /^\{[a-z]+\}$/.test(part) && LEGAL_LINKS[part.slice(1, -1)]
      if (!l) return esc(part)
      const ext = /^https?:\/\//.test(l.href)
      return `<a href="${esc(l.href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(l.label)}</a>`
    })
    .join('')
for (const lp of LEGAL_PAGES) {
  const path = `/${lp.slug}`
  write(
    path,
    render(
      { title: lp.title, description: lp.description, path, jsonLd: [breadcrumbJsonLd(SITE, [{ name: 'Home', path: '/' }, { name: lp.name, path }])] },
      `<main><h1>${esc(lp.title)}</h1>${legalSections(lp.slug)
        .map((sec) => `<h2>${esc(sec.title)}</h2>${sec.paragraphs.map((t) => `<p>${legalText(t)}</p>`).join('')}`)
        .join('')}${nav}</main>`,
    ),
  )
  pages.push({ path })
}

// Services
for (const s of SERVICE_PAGES) {
  const meta: PageMeta = {
    title: s.title,
    description: s.description,
    path: servicePath(s),
    jsonLd: [
      { '@context': 'https://schema.org', '@type': 'Service', name: s.title, serviceType: s.name, description: s.description, url: `${SITE}${servicePath(s)}`, provider: businessJsonLd(SITE), areaServed: { '@type': 'City', name: 'Melbourne' } },
      breadcrumbJsonLd(SITE, [
        { name: 'Home', path: '/' },
        { name: s.name, path: servicePath(s) },
      ]),
    ],
  }
  write(
    servicePath(s),
    render(meta, `<main><h1>${esc(s.title)}</h1><p>${esc(s.intro)}</p>${list(s.jobs.map(esc))}${s.details.map((d) => `<h2>${esc(d.heading)}</h2><p>${esc(d.body)}</p>`).join('')}${nav}</main>`),
  )
  pages.push({ path: servicePath(s) })
}

// Products
for (const p of all) {
  const meta = productMeta(p, SITE)
  write(
    productPath(p),
    render(
      meta,
      `<main><h1>${esc(p.title)}</h1><p>${esc(meta.description)}</p>${p.images.map((src, i) => `<img src="${esc(src)}" alt="${esc(p.imageAlt?.[i] || p.title)}" />`).join('')}<p>${esc(p.description)}</p>` +
        ((p.highlights ?? []).length ? list((p.highlights ?? []).map(esc)) : '') +
        (specRows(p).length ? `<h2>Specifications</h2><table>${specRows(p).map((r) => `<tr><th>${esc(r.name)}</th><td>${esc(r.value)}</td></tr>`).join('')}</table>` : '') +
        `${link('/store', 'Back to the shop')}${nav}</main>`,
    ),
  )
  pages.push({ path: productPath(p) })
}

const today = new Date().toISOString().slice(0, 10)
writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${esc(`${SITE}${p.path}`)}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`,
)
writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`)
// Netlify: pages written above are served as they are; any other address loads the app.
writeFileSync(join(DIST, '_redirects'), '/*  /index.html  200\n')
console.log(`prerender: ${pages.length} pages (${all.length} products) for ${SITE}`)
