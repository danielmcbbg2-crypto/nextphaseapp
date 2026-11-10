-- Public request-photo uploads: a limit on how fast and how much anonymous visitors can add, plus a
-- daily clean-up of photos nobody used (the purge-lead-photos function).

-- Only the database sees the counts; visitors call it through the upload policy below.
create or replace function public.lead_photo_upload_ok() returns boolean
language sql security definer stable set search_path = '' as $$
  select (select count(*) from storage.objects
           where bucket_id = 'lead-photos' and created_at > now() - interval '10 minutes') < 300
     and (select count(*) from storage.objects
           where bucket_id = 'lead-photos' and name like 'incoming/%') < 3000;
$$;
revoke execute on function public.lead_photo_upload_ok() from public;
grant execute on function public.lead_photo_upload_ok() to anon, authenticated;

drop policy if exists lead_photos_upload on storage.objects;
create policy lead_photos_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'lead-photos' and name ~ '^incoming/[0-9a-f-]{36}\.jpg$' and public.lead_photo_upload_ok());

-- Clean up unused uploads once a day (where pg_cron and pg_net are installed).
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and to_regnamespace('net') is not null then
    perform cron.schedule('purge-lead-photos', '23 16 * * *', $$
  select net.http_post(
    url := 'https://djgacgzmpmbrftkdlqrb.supabase.co/functions/v1/purge-lead-photos',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb);
$$);
  end if;
end;
$do$;
