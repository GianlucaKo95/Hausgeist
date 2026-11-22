-- Aus dem Kalender abgeleitete Erinnerungen: Kennung gegen Dubletten.
alter table public.reminders add column if not exists source_key text;
create unique index if not exists reminders_source_key on public.reminders (source_key);
