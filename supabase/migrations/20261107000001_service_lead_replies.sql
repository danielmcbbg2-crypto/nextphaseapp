-- Leads from Service.com.au, answered with one tap.
--
-- A script in the office's Gmail sends each Service.com.au job alert to the service-leads server
-- function, which reads it with Claude, adds it here as a lead (source 'service.com.au'), drafts a
-- reply and texts the office a private link. The link opens the reply page, where the reply is
-- checked, copied and posted on Service.com.au. Nothing is sent to the customer without that tap.

alter table public.leads add column if not exists source text not null default 'website';
-- The alert's Gmail message id, so an alert is never added twice.
alter table public.leads add column if not exists external_id text unique;
-- The job on the lead site, if the alert linked to it.
alter table public.leads add column if not exists job_url text not null default '';

create table if not exists public.lead_replies (
  lead_id    text primary key references public.leads (id) on delete cascade,
  -- The secret in the texted link (the reply page needs no sign-in).
  token      text not null unique,
  draft      text not null,
  -- Claude's read of the job against what Next Phase does: good, check or skip.
  fit        text not null default 'check' check (fit in ('good', 'check', 'skip')),
  fit_reason text not null default '',
  summary    text not null default '',
  -- The job in a few words, for texts.
  headline   text not null default '',
  status     text not null default 'awaiting' check (status in ('awaiting', 'approved', 'skipped')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- Only the server functions (service role) write here; the office can read.
alter table public.lead_replies enable row level security;
revoke all on public.lead_replies from anon, authenticated;
grant select on public.lead_replies to authenticated;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'lead_replies' and policyname = 'lead_replies_select') then
    create policy lead_replies_select on public.lead_replies for select to authenticated
      using ((select has_perm('canManageProjects')) or (select has_perm('canDispatchJobs')));
  end if;
end;
$$;

-- Keys for outside services calling in (the Gmail script's is 'lead_intake'). Nobody but the
-- server functions can read them. The value itself is set on the live project, never committed.
create table if not exists public.integration_keys (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
alter table public.integration_keys enable row level security;
revoke all on public.integration_keys from anon, authenticated;
