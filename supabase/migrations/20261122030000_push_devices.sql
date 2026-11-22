-- Push direkt über die Hausgeist-App (APNs): Geräte-Tokens pro Person.
create table if not exists public.push_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  token        text not null unique,
  environment  text not null default 'production' check (environment in ('sandbox', 'production')),
  platform     text not null default 'ios',
  updated_at   timestamptz not null default now()
);
create index if not exists push_devices_user on public.push_devices (user_id);
alter table public.push_devices enable row level security;
create policy push_devices_own on public.push_devices for select to authenticated
  using (user_id = (private.current_app_user()).id);
