-- Applied to the live project as `supplier_import_top_sellers` (2026-11-06); added to the repo so a
-- fresh database matches. Imports can be limited to a supplier's top N sellers (ranked first).
alter table public.supplier_imports add column if not exists top_n integer check (top_n > 0);
alter table public.supplier_imports drop constraint if exists supplier_imports_status_check;
alter table public.supplier_imports add constraint supplier_imports_status_check check (status in ('listing','ranking','processing','done','failed','paused'));
alter table public.supplier_import_items add column if not exists rank integer;

do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and to_regnamespace('net') is not null then
    if exists (select 1 from cron.job where jobname = 'supplier-import') then
      perform cron.unschedule('supplier-import');
    end if;
    perform cron.schedule('supplier-import', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://djgacgzmpmbrftkdlqrb.supabase.co/functions/v1/supplier-import',
    body := '{"run":true}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 300000)
  where exists (select 1 from public.supplier_imports where status in ('listing','ranking','processing'));
$$);
  end if;
end;
$do$;
