-- Intraday-Engine (Alpaca Paper): Regeln vom Strategie-Agenten, Ausführung durch feste Engine.
create table public.intraday_rules (
  version     int primary key,
  rules       jsonb not null,
  note        text,
  status      text not null default 'proposed' check (status in ('active','proposed','archived','rejected')),
  created_by  text not null default 'agent',
  created_at  timestamptz not null default now(),
  activated_at timestamptz
);
create table public.intraday_trades (
  id            uuid primary key default gen_random_uuid(),
  at            timestamptz not null default now(),
  symbol        text not null,
  side          text not null check (side in ('buy','sell')),
  notional_usd  numeric,
  qty           numeric,
  price         numeric,
  rule_version  int,
  reason        text not null,
  order_id      text
);
create table public.intraday_reports (
  day           date primary key,
  equity_usd    numeric not null,
  pnl_usd       numeric not null,
  spy_pct       numeric,
  trades        int not null,
  summary       text not null,
  proposal_version int,
  created_at    timestamptz not null default now()
);
alter table public.intraday_rules enable row level security;
alter table public.intraday_trades enable row level security;
alter table public.intraday_reports enable row level security;

create table public.intraday_profile (
  id         int primary key default 1 check (id = 1),
  goals      text not null default '',
  report_time text not null default '22:15',
  updated_at timestamptz not null default now()
);
alter table public.intraday_profile enable row level security;

-- Autopilot: Strategie-Agent entwirft, testet einen Tag auf Papier und passt selbst an
alter table public.intraday_profile add column if not exists lessons text not null default '';
alter table public.intraday_profile add column if not exists autopilot boolean not null default true;
insert into public.intraday_profile (id) values (1) on conflict (id) do nothing;
