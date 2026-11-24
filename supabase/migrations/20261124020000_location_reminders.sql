-- Ortsbezogene Erinnerungen: beim Verlassen oder Erreichen einer Home-Assistant-Zone
create table if not exists public.location_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  zone text not null,
  event text not null check (event in ('enter', 'leave')),
  message text not null,
  repeat boolean not null default false,
  active boolean not null default true,
  last_state text,
  fired_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists location_reminders_active on public.location_reminders (active) where active;
alter table public.location_reminders enable row level security;
