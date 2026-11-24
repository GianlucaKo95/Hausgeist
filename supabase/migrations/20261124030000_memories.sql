-- Langzeitgedächtnis je Person: gilt über alle Gespräche hinweg
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  text text not null,
  source_conversation uuid references public.conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists memories_user on public.memories (user_id, updated_at desc);
alter table public.memories enable row level security;
