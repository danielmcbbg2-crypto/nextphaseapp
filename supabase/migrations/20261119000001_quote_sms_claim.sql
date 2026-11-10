-- Lets send-sms "claim" the quote-request text before sending it, so two near-simultaneous calls
-- can't both send (requests already has sms_notified for the same purpose).
alter table public.projects add column if not exists quote_sms_notified boolean not null default false;
