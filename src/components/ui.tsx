import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { cx, imageToDataUrl } from '../lib/utils'
import { useStore } from '../lib/store'

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="rule-above text-3xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 sm:shrink-0">{actions}</div>}
    </div>
  )
}

/**
 * Status markers differ by shape as well as colour, so they stay distinct for colour-blind users:
 * orange square = needs action, hollow square = booked/issued, black square = under way,
 * grey square = waiting, green circle = done, red diamond = rejected/failed.
 */
const TONES = {
  orange: 'bg-accent',
  outline: 'bg-white ring-1 ring-inset ring-slate-900',
  dark: 'bg-slate-900',
  slate: 'bg-slate-400',
  green: 'rounded-full bg-emerald-600',
  red: 'rotate-45 scale-90 bg-red-600',
} as const
export type Tone = keyof typeof TONES

/** Quiet status label: a small marker and text, no pill. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 whitespace-nowrap">
      <span className={cx('h-2 w-2 shrink-0', TONES[tone])} aria-hidden="true" />
      {children}
    </span>
  )
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: string; count?: number }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-offset-[-2px]',
            value === t.value ? 'border-accent text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-900',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="num ml-1.5 text-xs text-slate-500">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card px-6 py-12 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    // Auto margins centre the dialog but, unlike align-items: center, keep its top reachable when it's taller than the screen.
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4" onMouseDown={onClose}>
      <div className={cx('card w-full shadow-xl sm:my-auto', width)} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <h2 className="text-base font-bold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

export function PhotoInput({ value, onChange, max = 6 }: { value: string[]; onChange: (v: string[]) => void; max?: number }) {
  const { uploadImage } = useStore()
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async (files: FileList | null) => {
    if (!files) return
    setBusy(true)
    setError(null)
    try {
      const urls = await Promise.all(
        Array.from(files)
          .slice(0, max - value.length)
          .map(async (f) => uploadImage(await imageToDataUrl(f))),
      )
      onChange([...value, ...urls])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      if (ref.current) ref.current.value = ''
    }
  }
  return (
    <div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {value.map((src, i) => (
          <div key={i} className="group relative aspect-square overflow-hidden rounded-md border border-slate-200">
            <img src={src} alt={`Attachment ${i + 1}`} loading="lazy" decoding="async" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="absolute right-1 top-1 rounded bg-white/90 p-0.5 text-slate-700 shadow-sm hover:bg-white"
              aria-label="Remove photo"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {value.length < max && (
          <button
            type="button"
            onClick={() => ref.current?.click()}
            disabled={busy}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border border-dashed border-slate-300 text-xs text-slate-500 hover:border-slate-400 hover:bg-slate-50"
          >
            <ImagePlus size={20} />
            {busy ? 'Uploading…' : 'Add photo'}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <input ref={ref} type="file" accept="image/*" multiple hidden onChange={(e) => add(e.target.files)} />
    </div>
  )
}

export function PhotoStrip({ photos }: { photos: string[] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (photos.length === 0) return null
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {photos.map((src, i) => (
          <button key={i} onClick={() => setOpen(src)} className="h-16 w-16 overflow-hidden rounded border border-slate-200 hover:opacity-90">
            <img src={src} alt={`Photo ${i + 1}`} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/80 p-4" onClick={() => setOpen(null)}>
          <img src={open} alt="Enlarged photo" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="num mt-1 font-display text-xl font-bold text-slate-900 sm:text-2xl">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

export function Sep() {
  return <span className="mx-1.5 text-slate-300">·</span>
}
