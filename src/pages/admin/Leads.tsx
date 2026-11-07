import { useEffect, useState } from 'react'
import { Camera, ExternalLink, Mail, Phone, Trash2, UserPlus } from 'lucide-react'
import { Empty, Field, Modal, PageHeader, Sep, Tabs } from '../../components/ui'
import { TextButton } from '../../components/TextMessage'
import { useStore } from '../../lib/store'
import { navigate } from '../../lib/router'
import { DEFAULT_PERMISSIONS, LEAD_STATUS_LABEL, LEAD_URGENCY_LABEL, type Lead, type LeadStatus, type UserAccount } from '../../lib/types'
import { fmtDateTime, uid } from '../../lib/utils'

const digits = (s: string) => s.replace(/\D/g, '')

/** A request's photos, as thumbnails that open full size. Live photos are private, so links are made on demand. */
function LeadPhotos({ paths }: { paths: string[] }) {
  const { leadPhotoUrls } = useStore()
  const [urls, setUrls] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = paths.join('|')
  useEffect(() => {
    let live = true
    leadPhotoUrls(key ? key.split('|') : [])
      .then((u) => live && setUrls(u))
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [key, leadPhotoUrls])
  if (!paths.length) return null
  if (error) return <p className="text-xs text-red-600">Photos couldn’t be loaded: {error}</p>
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {(urls ?? paths.map(() => '')).map((u, i) =>
        u ? (
          <a key={i} href={u} target="_blank" rel="noreferrer" className="block aspect-square overflow-hidden border border-slate-200 hover:opacity-90">
            <img src={u} alt={`Photo ${i + 1}`} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          </a>
        ) : (
          <div key={i} className="aspect-square animate-pulse bg-slate-100" />
        ),
      )}
    </div>
  )
}

function UrgencyTag({ l }: { l: Lead }) {
  if (l.urgency === 'urgent') return <span className="bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">Urgent</span>
  return <span className="text-xs text-slate-500">{LEAD_URGENCY_LABEL[l.urgency]}</span>
}

/** Admin: enquiries from the website's quote form, from people without an account. */
export function Leads() {
  const { data } = useStore()
  const [tab, setTab] = useState<'new' | 'contacted' | 'closed'>('new')
  const [openId, setOpenId] = useState<string | null>(null)
  const groups = {
    new: data.leads.filter((l) => l.status === 'new'),
    contacted: data.leads.filter((l) => l.status === 'contacted'),
    closed: data.leads.filter((l) => l.status === 'won' || l.status === 'lost'),
  }
  const list = groups[tab]
  const open = data.leads.find((l) => l.id === openId)

  return (
    <>
      <PageHeader title="Enquiries" subtitle="Maintenance requests from the website, with photos, from people without an account. Follow them up and add them as clients." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'new', label: 'New', count: groups.new.length },
          { value: 'contacted', label: 'Contacted', count: groups.contacted.length },
          { value: 'closed', label: 'Closed', count: groups.closed.length },
        ]}
      />
      {list.length === 0 ? (
        <Empty title={tab === 'new' ? 'No new enquiries' : 'Nothing here'}>
          {tab === 'new' ? 'Requests from the “Request maintenance” pop-up on the home page show up here, and in your inbox.' : undefined}
        </Empty>
      ) : (
        <ul className="card divide-y divide-slate-100">
          {list.map((l) => (
            <li key={l.id}>
              <button type="button" className="flex w-full flex-wrap items-start gap-x-6 gap-y-2 px-5 py-4 text-left hover:bg-slate-50" onClick={() => setOpenId(l.id)}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="num text-xs text-slate-500">#{l.number}</span>
                    <UrgencyTag l={l} />
                    {l.source === 'service.com.au' && <span className="bg-sky-100 px-1.5 py-0.5 text-[11px] font-semibold text-sky-800">Service.com.au</span>}
                    {l.status === 'won' || l.status === 'lost' ? <span className="text-xs text-slate-500">· {LEAD_STATUS_LABEL[l.status]}</span> : null}
                  </div>
                  <p className="mt-0.5 font-semibold">
                    {l.name}
                    {l.company && <span className="font-normal text-slate-500"> · {l.company}</span>}
                  </p>
                  <p className="truncate text-sm text-slate-600">{l.message || 'No details given.'}</p>
                  {l.services.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {l.services.map((s) => (
                        <span key={s} className="border border-slate-200 px-2 py-0.5 text-xs text-slate-600">{s}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="text-right text-sm">
                  <p className="num text-xs text-slate-500">{fmtDateTime(l.createdAt)}</p>
                  {l.suburb && <p className="text-slate-600">{l.suburb}</p>}
                  <p className="text-xs text-slate-500">Prefers {l.contactBy === 'phone' ? 'a call' : 'email'}</p>
                  {l.photos.length > 0 && (
                    <p className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500">
                      <Camera size={13} aria-hidden="true" /> {l.photos.length} photo{l.photos.length > 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <LeadDetail key={open.id} lead={open} onClose={() => setOpenId(null)} />}
    </>
  )
}

function LeadDetail({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const { data, update, can, deleteLead } = useStore()
  const [notes, setNotes] = useState(lead.notes)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const change = (patch: Partial<Lead>) =>
    update((d) => {
      const l = d.leads.find((x) => x.id === lead.id)
      if (l) Object.assign(l, patch)
    })
  const client = lead.clientId ? data.users.find((u) => u.id === lead.clientId) : undefined
  // Someone already on the books with the same email or phone.
  const match = !client
    ? data.users.find(
        (u) =>
          (lead.email && u.email && u.email.toLowerCase() === lead.email.toLowerCase()) ||
          (digits(lead.phone).length >= 8 && digits(u.phone) === digits(lead.phone)),
      )
    : undefined

  const addClient = () => {
    const id = uid('u')
    const account: UserAccount = {
      id,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      company: lead.company || undefined,
      role: 'client',
      permissions: DEFAULT_PERMISSIONS.client,
      createdAt: new Date().toISOString(),
      status: 'invited',
      passwordHash: '',
      hasLogin: false,
    }
    update((d) => {
      d.users.push(account)
      const l = d.leads.find((x) => x.id === lead.id)
      if (l) {
        l.clientId = id
        if (l.status === 'new' || l.status === 'contacted') l.status = 'won'
      }
    })
  }

  return (
    <Modal open onClose={onClose} title={`Request #${lead.number} · ${lead.name}`} width="max-w-2xl">
      <div className="space-y-5 text-sm">
        <p className="text-slate-600">
          {fmtDateTime(lead.createdAt)}
          <Sep />
          {LEAD_URGENCY_LABEL[lead.urgency]}
          {lead.suburb && (
            <>
              <Sep />
              {lead.suburb}
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {lead.jobUrl && (
            <a className="btn-ghost" href={lead.jobUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={15} /> Open on Service.com.au
            </a>
          )}
          {lead.phone && (
            <a className={lead.contactBy === 'phone' ? 'btn-primary' : 'btn-ghost'} href={`tel:${digits(lead.phone)}`}>
              <Phone size={15} /> {lead.phone}
            </a>
          )}
          {lead.phone && (
            <TextButton
              phone={lead.phone}
              event={`Website request #${lead.number}`}
              label="Text"
              className={lead.contactBy === 'phone' ? 'btn-primary' : 'btn-ghost'}
              message={`Hi ${lead.name.split(' ')[0]}, it's Next Phase Maintenance about your ${lead.services[0]?.replace(/ Services$/, '').toLowerCase() ?? 'maintenance'} request (#${lead.number}). `}
            />
          )}
          {lead.email && (
            <a className={lead.contactBy === 'email' ? 'btn-primary' : 'btn-ghost'} href={`mailto:${lead.email}?subject=${encodeURIComponent(`Your maintenance request #${lead.number} with Next Phase Maintenance`)}`}>
              <Mail size={15} /> {lead.email}
            </a>
          )}
        </div>
        <p className="text-xs text-slate-500">Prefers {lead.contactBy === 'phone' ? 'a phone call' : 'email'}{lead.company ? ` · ${lead.company}` : ''}</p>
        {lead.services.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {lead.services.map((s) => (
              <span key={s} className="border border-slate-200 px-2 py-0.5 text-xs text-slate-600">{s}</span>
            ))}
          </div>
        )}
        <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-slate-800">{lead.message || 'No details given.'}</p>
        <LeadPhotos paths={lead.photos} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status">
            <select className="input" value={lead.status} onChange={(e) => change({ status: e.target.value as LeadStatus })}>
              {(Object.keys(LEAD_STATUS_LABEL) as LeadStatus[]).map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
            </select>
          </Field>
          <div>
            <span className="label">Client account</span>
            {client ? (
              <p className="py-2">
                {client.name}{' '}
                <button type="button" className="text-xs text-slate-500 underline" onClick={() => navigate('/admin/projects')}>Set up a project</button>
              </p>
            ) : match ? (
              <div className="py-1">
                <p>Already on the books: <span className="font-semibold">{match.name}</span></p>
                <button type="button" className="btn-ghost mt-1 px-2.5 py-1 text-xs" onClick={() => change({ clientId: match.id })}>Link to {match.name.split(' ')[0]}</button>
              </div>
            ) : can('canEditPermissions') ? (
              <button type="button" className="btn-ghost mt-0.5" onClick={addClient} title="Adds them as a client without a login; invite them from Accounts when they need access">
                <UserPlus size={15} /> Add as client
              </button>
            ) : (
              <p className="py-2 text-xs text-slate-500">Someone with “Edit accounts” can add them as a client.</p>
            )}
          </div>
        </div>
        <Field label="Notes (office only)">
          <textarea className="input min-h-[80px]" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== lead.notes && change({ notes })} placeholder="e.g. Called, booked a site visit for Thursday" />
        </Field>
        <div className="flex items-center justify-between border-t border-slate-100 pt-4">
          {confirmDelete ? (
            <span className="flex items-center gap-2">
              Delete this request and its photos?
              <button
                type="button"
                className="btn-ghost px-2.5 py-1 text-xs text-red-600"
                onClick={() => {
                  deleteLead(lead.id)
                  onClose()
                }}
              >
                Delete
              </button>
              <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setConfirmDelete(false)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-red-600" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} /> Delete (spam)
            </button>
          )}
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              if (notes !== lead.notes) change({ notes })
              onClose()
            }}
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  )
}
