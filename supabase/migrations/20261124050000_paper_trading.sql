-- Musterdepot für den Strategie-Agenten: nur Papier, keine echten Orders.
create table public.trading_state (
  id               int primary key default 1 check (id = 1),
  enabled          boolean not null default true,
  start_cash_eur   numeric not null,
  cash_eur         numeric not null,
  started_at       date not null default current_date,
  benchmark        text not null default 'EUNL.DE',
  benchmark_units  numeric not null default 0,
  report_time      text not null default '18:00',
  strategy         text not null,
  strategy_version int not null default 1,
  watchlist        text[] not null default '{}',
  updated_at       timestamptz not null default now()
);
create table public.trading_positions (
  symbol        text primary key,
  name          text,
  currency      text not null default 'EUR',
  qty           numeric not null check (qty >= 0),
  avg_cost_eur  numeric not null,
  opened_at     timestamptz not null default now()
);
create table public.trading_trades (
  id               uuid primary key default gen_random_uuid(),
  at               timestamptz not null default now(),
  symbol           text not null,
  name             text,
  side             text not null check (side in ('buy','sell')),
  qty              numeric not null,
  price            numeric not null,
  currency         text not null,
  price_eur        numeric not null,
  fee_eur          numeric not null,
  reason           text,
  strategy_version int not null
);
create table public.trading_reports (
  day              date primary key,
  equity_eur       numeric not null,
  cash_eur         numeric not null,
  benchmark_eur    numeric not null,
  summary          text not null,
  trades           jsonb not null default '[]',
  strategy_version int not null,
  created_at       timestamptz not null default now()
);
create table public.trading_strategy_history (
  version    int primary key,
  strategy   text not null,
  note       text,
  changed_at timestamptz not null default now()
);
alter table public.trading_state enable row level security;
alter table public.trading_positions enable row level security;
alter table public.trading_trades enable row level security;
alter table public.trading_reports enable row level security;
alter table public.trading_strategy_history enable row level security;
