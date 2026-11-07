-- Applied to the live project as `supplier_catalogue_import` (2026-11-06); added to the repo so a
-- fresh database matches. A queue for importing a supplier's catalogue into the store, worked by the
-- supplier-import edge function every 2 minutes while an import is running.
create table if not exists public.supplier_imports (
  id uuid primary key default gen_random_uuid(),
  supplier text not null,
  base_url text not null,
  status text not null default 'listing' check (status in ('listing','processing','done','failed','paused')),
  page integer not null default 1,
  publish boolean not null default true,
  note text not null default '',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create table if not exists public.supplier_import_items (
  id bigserial primary key,
  import_id uuid not null references public.supplier_imports(id) on delete cascade,
  handle text not null,
  data jsonb not null,
  state text not null default 'pending' check (state in ('pending','working','added','skipped','failed')),
  product_id text,
  note text not null default '',
  updated_at timestamptz not null default now(),
  unique (import_id, handle)
);
create index if not exists supplier_import_items_import_id_state_idx on public.supplier_import_items (import_id, state);
alter table public.supplier_imports enable row level security;
alter table public.supplier_import_items enable row level security;
drop policy if exists "store managers read imports" on public.supplier_imports;
create policy "store managers read imports" on public.supplier_imports for select using (exists (select 1 from public.profiles p where p.auth_id = auth.uid() and p.role='admin' and p.status='active' and 'canManageStore' = any (p.permissions)));
drop policy if exists "store managers read import items" on public.supplier_import_items;
create policy "store managers read import items" on public.supplier_import_items for select using (exists (select 1 from public.profiles p where p.auth_id = auth.uid() and p.role='admin' and p.status='active' and 'canManageStore' = any (p.permissions)));

-- Where pg_cron and pg_net are installed (not in the local test database).
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and to_regnamespace('net') is not null then
    perform cron.schedule('supplier-import', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://djgacgzmpmbrftkdlqrb.supabase.co/functions/v1/supplier-import',
    body := '{"run":true}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 300000)
  where exists (select 1 from public.supplier_imports where status in ('listing','processing'));
$$);
  end if;
end;
$do$;
