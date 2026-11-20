-- Hausgeist – Grundschema
-- Schreibzugriffe erfolgen nur über das Add-on (Service-Role). Angemeldete
-- Haushaltsmitglieder (spätere eigene App) dürfen lesen, was sie sehen dürfen.

create extension if not exists pgcrypto;

-- ── Nutzer, Rollen, Präferenzen ──────────────────────────────────────────
create type public.user_role as enum ('admin', 'adult', 'child');

create table public.users (
  id                    uuid primary key default gen_random_uuid(),
  auth_user_id          uuid unique references auth.users (id) on delete set null,
  name                  text not null,
  role                  public.user_role not null,
  approval_limit_cents  integer not null default 50000 check (approval_limit_cents >= 0),
  ha_user_id            text unique,          -- Home-Assistant-Benutzer-ID (aus Freigabe-Events)
  notify_service        text,                 -- z. B. mobile_app_lucas_iphone
  created_at            timestamptz not null default now()
);

create table public.preferences (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users (id) on delete cascade, -- null = ganzer Haushalt
  key         text not null,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  unique nulls not distinct (user_id, key)
);

create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null,
  title       text not null,
  status      text not null default 'open' check (status in ('open', 'waiting', 'done', 'failed')),
  data        jsonb not null default '{}',
  created_by  uuid references public.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Postfächer (nur Metadaten, Zugangsdaten bleiben im Add-on) ─────────────
create table public.mailboxes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,               -- = name in der Add-on-Konfiguration
  owner_id    uuid references public.users (id),
  visibility  text not null default 'shared' check (visibility in ('private', 'shared')),
  scope       text not null default 'private' check (scope in ('private', 'business'))
);

-- ── Finanzen ──────────────────────────────────────────────────────────────
create table public.accounts (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,                      -- z. B. "Sparkasse Giro"
  bank         text not null check (bank in ('sparkasse_duisburg', 'deutsche_bank', 'dkb')),
  iban         text not null unique,
  holder_id    uuid references public.users (id),
  match_names  text[] not null default '{}',       -- Namen auf Rechnungen, die zu diesem Konto gehören
  is_default   boolean not null default false
);
create unique index accounts_one_default on public.accounts (is_default) where is_default;

create table public.payees (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,
  ibans               text[] not null default '{}', -- bestätigte IBANs; nur der Admin ergänzt sie
  default_account_id  uuid references public.accounts (id),
  created_at          timestamptz not null default now()
);

create table public.budgets (
  id            uuid primary key default gen_random_uuid(),
  category      text not null unique,
  monthly_cents integer not null check (monthly_cents >= 0)
);

create type public.invoice_status as enum (
  'pending_approval', 'approved', 'rejected', 'paying', 'paid', 'failed', 'needs_review'
);

create table public.invoices (
  id                    uuid primary key default gen_random_uuid(),
  mailbox               text not null,
  message_id            text,
  source_sha256         text not null unique,       -- Hash des PDFs, verhindert Doppelverarbeitung
  duplicate_key         text not null,
  issuer                text not null,
  recipient_name        text,
  invoice_number        text,
  invoice_date          date,
  due_date              date,
  amount_cents          integer not null check (amount_cents > 0),
  currency              text not null default 'EUR',
  iban                  text not null,
  bic                   text,
  reference             text,                        -- Verwendungszweck
  category              text,
  payee_id              uuid references public.payees (id),
  payee_status          text not null check (payee_status in ('known', 'new', 'iban_changed')),
  suggested_account_id  uuid references public.accounts (id),
  status                public.invoice_status not null default 'pending_approval',
  review_note           text,
  paperless_task_id     text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index invoices_duplicate_key on public.invoices (duplicate_key);
create index invoices_status on public.invoices (status);

-- Freigaben frieren die Werte ein. Der Ausführer zahlt ausschließlich mit diesen Werten.
create table public.approvals (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices (id) on delete cascade,
  amount_cents  integer not null,
  iban          text not null,
  reference     text,
  account_id    uuid references public.accounts (id),
  payee_status  text not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_by    uuid references public.users (id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create unique index approvals_one_pending on public.approvals (invoice_id) where status = 'pending';

-- Eingefrorene Felder einer Freigabe dürfen nie geändert werden.
create function public.approvals_freeze() returns trigger language plpgsql as $$
begin
  if new.amount_cents is distinct from old.amount_cents
     or new.iban is distinct from old.iban
     or new.reference is distinct from old.reference
     or new.account_id is distinct from old.account_id
     or new.invoice_id is distinct from old.invoice_id then
    raise exception 'Freigabewerte sind unveränderlich';
  end if;
  if old.status <> 'pending' and new.status is distinct from old.status then
    raise exception 'Entscheidung ist bereits gefallen';
  end if;
  return new;
end $$;
create trigger approvals_freeze before update on public.approvals
  for each row execute function public.approvals_freeze();

-- Zahlungsrelevante Rechnungsfelder sind nach dem Anlegen unveränderlich.
create function public.invoices_freeze() returns trigger language plpgsql as $$
begin
  if new.amount_cents is distinct from old.amount_cents
     or new.iban is distinct from old.iban
     or new.reference is distinct from old.reference then
    raise exception 'Zahlungsdaten einer Rechnung sind unveränderlich';
  end if;
  new.updated_at = now();
  return new;
end $$;
create trigger invoices_freeze before update on public.invoices
  for each row execute function public.invoices_freeze();

-- ── Dokumente und Verträge ────────────────────────────────────────────────
create table public.contracts (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  provider            text not null,
  monthly_cents       integer,
  start_date          date,
  end_date            date,
  notice_period_days  integer,
  auto_renew_months   integer,
  paperless_doc_id    integer,
  owner_id            uuid references public.users (id),
  created_at          timestamptz not null default now()
);

create table public.deadlines (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid references public.contracts (id) on delete cascade,
  title        text not null,
  due_date     date not null,
  done         boolean not null default false
);

-- ── Einkauf, Haushalt, Familie ────────────────────────────────────────────
create table public.shopping_lists (
  id          uuid primary key default gen_random_uuid(),
  item        text not null,
  quantity    text,
  added_by    uuid references public.users (id),
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.orders (
  id            uuid primary key default gen_random_uuid(),
  shop          text not null,
  items         jsonb not null,
  total_cents   integer not null,
  status        text not null default 'draft' check (status in ('draft', 'pending_approval', 'ordered', 'rejected')),
  created_at    timestamptz not null default now()
);

create table public.chores (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  interval_days  integer,
  next_due       date,
  assignee_id    uuid references public.users (id),
  last_done      date
);

create table public.family_tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  shared       boolean not null default true,
  owner_id     uuid references public.users (id),
  due_at       timestamptz,
  done         boolean not null default false
);

-- ── Protokoll ─────────────────────────────────────────────────────────────
create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  agent       text not null,
  action      text not null,
  level       smallint not null check (level between 0 and 3),
  user_id     uuid references public.users (id),
  ref_table   text,
  ref_id      uuid,
  result      text not null,
  detail      jsonb
);

-- ── Row Level Security ────────────────────────────────────────────────────
create function public.current_app_user() returns public.users
  language sql stable security definer set search_path = public as $$
  select * from public.users where auth_user_id = auth.uid()
$$;

create function public.is_adult_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where auth_user_id = auth.uid() and role in ('admin', 'adult'))
$$;

create function public.is_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where auth_user_id = auth.uid())
$$;

do $$
declare t text;
begin
  foreach t in array array['users','preferences','tasks','mailboxes','accounts','payees','budgets',
                           'invoices','approvals','contracts','deadlines','shopping_lists','orders',
                           'chores','family_tasks','audit_log']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Erwachsene sehen Finanzen, Verträge und Protokoll.
do $$
declare t text;
begin
  foreach t in array array['accounts','payees','budgets','invoices','approvals','contracts','deadlines','orders','audit_log','mailboxes','tasks']
  loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_adult_member())', t || '_read_adults', t);
  end loop;
end $$;

-- Alle Mitglieder sehen Haushalt, Einkauf und Nutzerliste.
do $$
declare t text;
begin
  foreach t in array array['users','shopping_lists','chores']
  loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member())', t || '_read_members', t);
  end loop;
end $$;

-- Familienaufgaben: gemeinsame für alle, private nur für den Besitzer.
create policy family_tasks_read on public.family_tasks for select to authenticated
  using (public.is_member() and (shared or owner_id = (public.current_app_user()).id));

-- Präferenzen: eigene und die des Haushalts.
create policy preferences_read on public.preferences for select to authenticated
  using (public.is_member() and (user_id is null or user_id = (public.current_app_user()).id));
