-- Applied to the live project as `integration_keys` (2026-11-04); added to the repo so a fresh
-- database matches. Keys used by edge functions (e.g. the Service.com.au lead intake secret read by
-- the service-leads function). Locked: only the service role reaches it.
create table if not exists public.integration_keys (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
alter table public.integration_keys enable row level security;
revoke all on public.integration_keys from anon, authenticated;
-- The live value is a secret and is not kept in the repo: a fresh database gets a random one, and an
-- existing value is left alone.
insert into public.integration_keys (name, value)
  values ('lead_intake', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;
