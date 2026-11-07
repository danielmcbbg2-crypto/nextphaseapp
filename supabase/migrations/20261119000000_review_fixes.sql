-- Fixes from the backend review. Written to run again harmlessly.

-- 1. SMS outbox: rows stuck in 'sending' -------------------------------------------------------
-- A send that died part way (function timeout, crash) left its row in 'sending' for ever. Each claim
-- now first marks rows that have been 'sending' for over 10 minutes as failed, with a note. They are
-- not put back to pending: the provider may have sent the text, and a second copy is worse than a
-- missed one (the office can see the failure and send it again).
alter table public.sms_outbox add column if not exists claimed_at timestamptz;

create or replace function public.claim_sms_outbox(max_rows int default 8)
returns setof public.sms_outbox
language plpgsql security definer set search_path = '' as $$
declare stuck record;
begin
  for stuck in
    update public.sms_outbox o
       set status = 'failed',
           detail = 'Stopped while sending (no answer for over 10 minutes). It may or may not have been sent: check before sending it again.'
     where o.id in (
       select id from public.sms_outbox
        where status = 'sending' and coalesce(claimed_at, created_at) < now() - interval '10 minutes'
        for update skip locked)
    returning o.to_phone, o.message, o.event, o.detail
  loop
    insert into public.sms_log (recipient_phone, message, status, trigger_event, detail)
    values (stuck.to_phone, stuck.message, 'failed', stuck.event, stuck.detail);
  end loop;

  return query
    update public.sms_outbox o
       set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
     where o.id in (
       select id from public.sms_outbox
        where status = 'pending'
        order by created_at
        limit greatest(1, least(coalesce(max_rows, 8), 50))
        for update skip locked)
    returning o.*;
end;
$$;
revoke all on function public.claim_sms_outbox(int) from public, anon, authenticated;
grant execute on function public.claim_sms_outbox(int) to service_role;

-- The 5-minute retry also runs when a row is stuck sending, so it gets marked failed.
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and to_regnamespace('net') is not null then
    perform cron.schedule('sms-outbox-retry', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://djgacgzmpmbrftkdlqrb.supabase.co/functions/v1/process-sms-outbox',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb)
  where exists (select 1 from public.sms_outbox
                 where status = 'pending'
                    or (status = 'sending' and coalesce(claimed_at, created_at) < now() - interval '10 minutes'));
$$);
  end if;
end;
$do$;

-- 2. Clients can't accept an expired quote by updating the project directly --------------------
-- Same as before (init.sql), plus: a client moving a quote to approved after its valid-until date
-- (Melbourne) is refused, as the quote link (answer_quote_by_token) already does.
create or replace function public.guard_project_update() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_api_user() or has_perm('canManageProjects') then return new; end if;
  -- Clients may only accept or decline an issued, priced quote.
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status')
     or old.status <> 'quoted' or old.quote_amount is null or new.status not in ('approved', 'rejected') then
    raise exception 'Clients can only accept or decline an issued quote';
  end if;
  if new.status = 'approved' and old.quote_valid_until is not null
     and old.quote_valid_until < (now() at time zone 'Australia/Melbourne')::date then
    raise exception 'This quote expired on %. Contact us for an updated quote.', to_char(old.quote_valid_until, 'DD/MM/YYYY');
  end if;
  return new;
end;
$$;

-- 3. Hide projects.quote_token from the app ---------------------------------------------------
-- Anyone holding a quote's link can accept it (answer_quote_by_token), and trades can read the
-- projects they're assigned to, so the token must not be readable through the API. Table-wide
-- SELECT is replaced by SELECT on every other column. The office gets a token through
-- admin_quote_token(). quote_by_token/answer_quote_by_token, the follow-up texts and the triggers
-- that set the token are SECURITY DEFINER or only touch NEW/OLD, which column privileges don't
-- affect.
--
-- NOTE: column grants are fixed when this runs. A column added to projects later is NOT readable
-- by the app until it's granted too (grant select (new_col) on public.projects to anon,
-- authenticated). The DB test "projects: every column but quote_token is readable" fails until it is.
revoke select on public.projects from anon, authenticated;
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'projects' and column_name <> 'quote_token';
  execute format('grant select (%s) on public.projects to anon, authenticated', cols);
end;
$$;

/** The office reads a quote's private link token (null for anyone else). */
create or replace function public.admin_quote_token(p_id text) returns text
language sql stable security definer set search_path = '' as $$
  select p.quote_token from public.projects p where p.id = p_id and public.is_admin()
$$;
revoke all on function public.admin_quote_token(text) from public, anon;
grant execute on function public.admin_quote_token(text) to authenticated, service_role;

-- 4. The master admin account can't be deleted --------------------------------------------------
create or replace function public.keep_master_admin() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.id = 'u-admin' then
    raise exception 'The master admin account can''t be deleted' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
revoke execute on function public.keep_master_admin() from public, anon, authenticated;
-- Named to fire before keep_account_history (triggers fire in name order), so this message wins.
drop trigger if exists guard_master_admin_delete on public.profiles;
create trigger guard_master_admin_delete before delete on public.profiles
  for each row execute function public.keep_master_admin();

-- 5. Supplier import policies: evaluate the access check once per query, not per row (advisor
-- auth_rls_initplan), through is_admin()/has_perm() so the admin two-step rule applies too.
drop policy if exists "store managers read imports" on public.supplier_imports;
create policy "store managers read imports" on public.supplier_imports for select
  using ((select public.is_admin()) and (select public.has_perm('canManageStore')));
drop policy if exists "store managers read import items" on public.supplier_import_items;
create policy "store managers read import items" on public.supplier_import_items for select
  using ((select public.is_admin()) and (select public.has_perm('canManageStore')));

-- 6. A diary entry's default date is today in Melbourne, not in UTC (before 10/11am it was
-- yesterday). project_documents.path needs no new index: its unique constraint already gives one
-- (project_documents_path_key), which the project_docs_read storage policy uses.
alter table public.project_diary alter column date set default ((now() at time zone 'Australia/Melbourne')::date);
