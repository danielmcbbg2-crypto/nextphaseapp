-- Applied to the live project as `photo_jobs` (2026-11-07); added to the repo so a fresh database
-- matches.
-- A work queue for making product photos with Gemini (server-only): each job is one photo, made
-- from reference photos (supplier links or earlier jobs' results) and a prompt.
create table if not exists public.photo_jobs (
  id text primary key,
  product_id text not null,
  key text not null,
  deps text[] not null default '{}',
  refs jsonb not null default '[]',
  prompt text not null,
  status text not null default 'pending' check (status in ('pending', 'working', 'done', 'failed')),
  url text,
  error text,
  attempts int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.photo_jobs enable row level security;
revoke all on public.photo_jobs from public, anon, authenticated;

create table if not exists public.photo_job_keys (key text primary key, created_at timestamptz not null default now());
alter table public.photo_job_keys enable row level security;
revoke all on public.photo_job_keys from public, anon, authenticated;
-- (Live used extensions.gen_random_bytes; gen_random_uuid is core Postgres and also strongly random.)
insert into public.photo_job_keys (key)
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
   where not exists (select 1 from public.photo_job_keys);

-- Claim one pending job whose dependencies are done (or one stuck working for 5 minutes).
create or replace function public.claim_photo_job() returns setof public.photo_jobs
language plpgsql security definer set search_path = '' as $$
declare j public.photo_jobs;
begin
  select * into j from public.photo_jobs p
   where (p.status = 'pending' or (p.status = 'working' and p.updated_at < now() - interval '5 minutes'))
     and p.attempts < 3
     and not exists (select 1 from unnest(p.deps) d left join public.photo_jobs x on x.id = d where x.status is distinct from 'done')
   order by p.updated_at, p.id
   limit 1
   for update skip locked;
  if not found then return; end if;
  update public.photo_jobs set status = 'working', attempts = attempts + 1, updated_at = now() where id = j.id returning * into j;
  return next j;
end;
$$;
revoke all on function public.claim_photo_job() from public, anon, authenticated;
grant execute on function public.claim_photo_job() to service_role;
