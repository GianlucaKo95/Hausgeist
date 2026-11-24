-- Gesprächsverlauf: Gespräche je Person mit allen Nachrichten, fortsetzbar über die Agent-Sitzung.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null default 'Neues Gespräch',
  session_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_user_updated on public.conversations (user_id, updated_at desc);

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender text not null check (sender in ('me', 'ghost', 'error')),
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists conversation_messages_conv on public.conversation_messages (conversation_id, created_at);

-- Zugriff nur über den Hausgeist-Server (service_role); keine direkten Client-Zugriffe.
alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
