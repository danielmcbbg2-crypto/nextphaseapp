import { useState } from 'react'
import { Field } from '../../components/ui'
import { checkListing, needsWatermark, needsWels, toSpec } from '../../lib/listingCheck'
import type { Product, ProductCompliance } from '../../lib/types'
import { cx } from '../../lib/utils'

const counter = (n: number, low: number, high: number) => (
  <span className={cx('num ml-1 font-normal', n >= low && n <= high ? 'text-emerald-700' : 'text-slate-400')}>({n}/{high})</span>
)

/**
 * The listing's details beyond its title and description, in the product editor: selling points,
 * specifications, what search results show, photo descriptions, barcode and the compliance details
 * Australian rules ask for. Shows the listing's score and what to fix as it's edited.
 */
export function ListingDetails({ p, price, set }: { p: Product; price: number; set: (patch: Partial<Product>) => void }) {
  // Edited as lines; kept as typed so a half-written line isn't tidied away.
  const [specText, setSpecText] = useState(() => (p.specs ?? []).map((s) => `${s.label}: ${s.value}`).join('\n'))
  const [highlightText, setHighlightText] = useState(() => (p.highlights ?? []).join('\n'))
  const [standardsText, setStandardsText] = useState(() => (p.compliance?.standards ?? []).join('\n'))
  const c = p.compliance ?? {}
  const setC = (patch: Partial<ProductCompliance>) => set({ compliance: { ...c, ...patch } })
  const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)
  const { score, issues } = checkListing({ ...p, price })
  const wels = needsWels(p)
  const watermark = needsWatermark(p)

  return (
    <>
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 sm:col-span-2" aria-live="polite">
        <p className="flex items-center justify-between text-sm font-semibold">
          Listing quality
          <span className={cx('num text-base', score >= 90 ? 'text-emerald-700' : score >= 70 ? 'text-amber-700' : 'text-red-700')}>{score}/100</span>
        </p>
        {issues.length ? (
          <ul className="mt-2 space-y-1 text-xs">
            {issues.map((i) => (
              <li key={i.message} className={i.level === 'must' ? 'text-red-700' : 'text-slate-600'}>
                {i.level === 'must' ? 'Required: ' : ''}
                {i.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-emerald-700">Complete: ready for the shop, Google and Facebook.</p>
        )}
      </div>

      <Field label="Selling points (one per line, 3 to 6)" className="sm:col-span-2">
        <textarea
          className="input min-h-[90px]"
          value={highlightText}
          onChange={(e) => {
            setHighlightText(e.target.value)
            set({ highlights: lines(e.target.value).slice(0, 6) })
          }}
        />
      </Field>
      <Field label="Specifications (one per line, “Label: value”)" className="sm:col-span-2">
        <textarea
          className="input min-h-[140px] font-mono text-xs"
          placeholder={'Dimensions: 750 W x 460 D x 550 H mm\nMaterial: Moisture-resistant MDF'}
          value={specText}
          onChange={(e) => {
            setSpecText(e.target.value)
            set({ specs: lines(e.target.value).map(toSpec) })
          }}
        />
      </Field>

      <fieldset className="grid gap-4 rounded-md border border-slate-200 p-4 sm:col-span-2 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">Australian compliance</legend>
        {wels && (
          <>
            <Field label="WELS star rating">
              <input className="input num" type="number" min={0} max={6} step={0.5} value={c.welsStars ?? ''} onChange={(e) => setC({ welsStars: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
            <Field label="WELS water use (as labelled)">
              <input className="input" placeholder="6.0 L/min or 4.5/3 L flush" value={c.welsWater ?? ''} onChange={(e) => setC({ welsWater: e.target.value })} />
            </Field>
            <Field label="WELS registration number">
              <input className="input" placeholder="T31433" value={c.welsReg ?? ''} onChange={(e) => setC({ welsReg: e.target.value })} />
            </Field>
          </>
        )}
        {(watermark || c.watermark) && (
          <Field label="WaterMark licence">
            <input className="input" placeholder="WMK 25123 (AS/NZS 3718)" value={c.watermark ?? ''} onChange={(e) => setC({ watermark: e.target.value })} />
          </Field>
        )}
        <Field label="Standards met (one per line)">
          <textarea
            className="input min-h-[60px]"
            placeholder="AS/NZS 2208 Grade A safety glass"
            value={standardsText}
            onChange={(e) => {
              setStandardsText(e.target.value)
              setC({ standards: lines(e.target.value) })
            }}
          />
        </Field>
        <Field label="Manufacturer’s warranty">
          <input className="input" placeholder="5 years on the cartridge, 1 year on parts" value={c.warranty ?? ''} onChange={(e) => setC({ warranty: e.target.value })} />
        </Field>
        <p className="text-xs text-slate-500 sm:col-span-2">
          Only enter what the maker states. The shop adds “plus your rights under the Australian Consumer Law” next to any warranty.
        </p>
      </fieldset>

      <fieldset className="grid gap-4 rounded-md border border-slate-200 p-4 sm:col-span-2 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">Search and link previews</legend>
        <label className="block sm:col-span-2">
          <span className="label">Search title {counter((p.seoTitle ?? '').length, 30, 60)}</span>
          <input className="input" maxLength={70} placeholder={p.title} value={p.seoTitle ?? ''} onChange={(e) => set({ seoTitle: e.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="label">Search description {counter((p.metaDescription ?? '').length, 120, 160)}</span>
          <textarea className="input min-h-[60px]" maxLength={180} value={p.metaDescription ?? ''} onChange={(e) => set({ metaDescription: e.target.value })} />
        </label>
        <Field label="Barcode (GTIN/EAN, if any)">
          <input className="input num" inputMode="numeric" maxLength={14} value={p.gtin ?? ''} onChange={(e) => set({ gtin: e.target.value.replace(/\D/g, '') })} />
        </Field>
        {p.images.map((src, i) => (
          <label key={src} className="flex items-start gap-3 sm:col-span-2">
            <img src={src} alt="" loading="lazy" decoding="async" className="h-12 w-12 shrink-0 object-cover" />
            <span className="block flex-1">
              <span className="label">Photo {i + 1} description</span>
              <input
                className="input"
                placeholder="e.g. 750 mm oak wall-hung vanity with white basin, front view"
                value={p.imageAlt?.[i] ?? ''}
                onChange={(e) => {
                  const imageAlt = p.images.map((_, k) => p.imageAlt?.[k] ?? '')
                  imageAlt[i] = e.target.value
                  set({ imageAlt })
                }}
              />
            </span>
          </label>
        ))}
      </fieldset>
    </>
  )
}
