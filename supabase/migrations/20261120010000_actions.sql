-- Hausgeist – Phase 2: allgemeine Freigaben für Stufe-2-Aktionen außer Zahlungen
-- (Mail senden, Bestellung, sicherheitsrelevante Home-Assistant-Dienste, Termine für andere).

create table public.actions (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('send_mail', 'order', 'ha_service', 'calendar_event')),
  agent         text not null,
  summary       text not null,                 -- Text für die Push-Nachricht
  payload       jsonb not null,                -- eingefroren, wird exakt so ausgeführt
  amount_cents  integer,                       -- bei Bestellungen
  requested_by  uuid references public.users (id),
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'done', 'failed', 'expired')),
  decided_by    uuid references public.users (id),
  decided_at    timestamptz,
  result        text,
  created_at    timestamptz not null default now()
);
create index actions_status on public.actions (status);

create function public.actions_freeze() returns trigger language plpgsql as $$
begin
  if new.payload is distinct from old.payload
     or new.kind is distinct from old.kind
     or new.amount_cents is distinct from old.amount_cents then
    raise exception 'Aktionswerte sind unveränderlich';
  end if;
  if old.status in ('rejected', 'done', 'failed', 'expired') and new.status is distinct from old.status then
    raise exception 'Aktion ist bereits abgeschlossen';
  end if;
  if old.status = 'approved' and new.status not in ('approved', 'done', 'failed') then
    raise exception 'Freigegebene Aktion kann nur noch ausgeführt werden';
  end if;
  return new;
end $$;
create trigger actions_freeze before update on public.actions
  for each row execute function public.actions_freeze();

alter table public.actions enable row level security;
create policy actions_read_adults on public.actions for select to authenticated using (public.is_adult_member());

-- Haushaltsaufgaben: erledigt-Markierung für Wiederholungen
alter table public.chores add column if not exists notes text;

-- Rechercheergebnisse und Entscheidungsvorlagen
create table public.research_notes (
  id          uuid primary key default gen_random_uuid(),
  topic       text not null,
  summary     text not null,
  sources     jsonb not null default '[]',
  requested_by uuid references public.users (id),
  created_at  timestamptz not null default now()
);
alter table public.research_notes enable row level security;
create policy research_notes_read on public.research_notes for select to authenticated using (public.is_member());
