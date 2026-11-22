-- Hausgeist – Phase 3: Erinnerungen, Notizen, Shopping-Erweiterungen, Gerätealarme,
-- Nachfassen bei liegengebliebenen Freigaben.

-- ── Erinnerungen ──────────────────────────────────────────────────────────
create table public.reminders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade, -- wer erinnert wird
  message     text not null,
  due_at      timestamptz not null,
  repeat      text not null default 'none' check (repeat in ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  created_by  uuid references public.users (id),
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index reminders_due on public.reminders (due_at) where not done;

-- ── Haushaltswissen ───────────────────────────────────────────────────────
create table public.notes (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  content     text not null,
  private     boolean not null default false,
  owner_id    uuid references public.users (id),
  updated_at  timestamptz not null default now()
);

-- ── Einkauf ───────────────────────────────────────────────────────────────
alter table public.shopping_lists add column if not exists store text;
alter table public.shopping_lists add column if not exists category text;

create table public.recurring_items (
  id             uuid primary key default gen_random_uuid(),
  item           text not null,
  quantity       text,
  store          text,
  interval_days  integer not null check (interval_days > 0),
  next_due       date not null,
  active         boolean not null default true
);

create table public.price_watches (
  id                uuid primary key default gen_random_uuid(),
  product           text not null,
  url               text,
  target_cents      integer not null check (target_cents > 0),
  last_price_cents  integer,
  last_shop         text,
  last_url          text,
  last_checked      timestamptz,
  notified_at       timestamptz,
  active            boolean not null default true,
  created_by        uuid references public.users (id),
  created_at        timestamptz not null default now()
);

create table public.wishlist (
  id           uuid primary key default gen_random_uuid(),
  for_user     uuid not null references public.users (id) on delete cascade,
  item         text not null,
  url          text,
  price_cents  integer,
  occasion     text,                    -- z. B. Geburtstag, Weihnachten
  reserved_by  uuid references public.users (id),
  done         boolean not null default false,
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now()
);

-- ── Gerätealarme ──────────────────────────────────────────────────────────
create table public.alerts (
  id            uuid primary key default gen_random_uuid(),
  entity_id     text not null,
  condition     text not null check (condition in ('below', 'above', 'equals', 'unavailable')),
  value         text,                   -- Schwelle oder Zustand; bei unavailable leer
  for_minutes   integer not null default 0 check (for_minutes >= 0),
  message       text not null,
  notify        text[] not null default '{}', -- Namen; leer = alle Erwachsenen
  active        boolean not null default true,
  triggered     boolean not null default false,
  since         timestamptz,            -- seit wann die Bedingung erfüllt ist
  last_fired    timestamptz,
  created_by    uuid references public.users (id),
  created_at    timestamptz not null default now()
);

-- ── Nachfassen bei Freigaben ──────────────────────────────────────────────
alter table public.approvals add column if not exists reminded_at timestamptz;
alter table public.actions add column if not exists reminded_at timestamptz;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.reminders enable row level security;
alter table public.notes enable row level security;
alter table public.recurring_items enable row level security;
alter table public.price_watches enable row level security;
alter table public.wishlist enable row level security;
alter table public.alerts enable row level security;

create policy reminders_own on public.reminders for select to authenticated
  using (user_id = (private.current_app_user()).id);
create policy notes_read on public.notes for select to authenticated
  using (private.is_member() and (not private or owner_id = (private.current_app_user()).id));
create policy recurring_items_read on public.recurring_items for select to authenticated using (private.is_member());
create policy price_watches_read on public.price_watches for select to authenticated using (private.is_member());
-- Wunschliste: eigene Wünsche ohne Reservierungsinfo gibt es nur über die API; direkt lesen dürfen Erwachsene.
create policy wishlist_read on public.wishlist for select to authenticated using (private.is_adult_member());
create policy alerts_read on public.alerts for select to authenticated using (private.is_adult_member());

-- ── Gerätesteuerung: geplante Schaltungen und Alarme mit Aktion ──────────
create table public.scheduled_actions (
  id          uuid primary key default gen_random_uuid(),
  run_at      timestamptz not null,
  repeat      text not null default 'none' check (repeat in ('none', 'daily', 'weekdays', 'weekly')),
  domain      text not null,
  service     text not null,
  entity_id   text not null,
  data        jsonb not null default '{}',
  label       text,
  active      boolean not null default true,
  last_run    timestamptz,
  last_result text,
  created_by  uuid references public.users (id),
  created_at  timestamptz not null default now()
);
create index scheduled_actions_due on public.scheduled_actions (run_at) where active;
alter table public.scheduled_actions enable row level security;
create policy scheduled_actions_read on public.scheduled_actions for select to authenticated using (private.is_adult_member());

-- Optional: Alarm löst zusätzlich eine (nicht sicherheitsrelevante) Schaltung aus,
-- z. B. "Speicher über 95 % → Waschmaschine an".
alter table public.alerts add column if not exists action jsonb;
