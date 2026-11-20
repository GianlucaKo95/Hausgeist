-- Login der Hausgeist-App: Supabase-Auth-Konto wird beim ersten Login über die E-Mail verknüpft.
alter table public.users add column if not exists email text;
create unique index if not exists users_email_unique on public.users (lower(email));
