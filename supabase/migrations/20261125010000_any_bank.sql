-- Jede Bank: Konten verweisen auf einen beliebigen Bankzugang (z. B. blz_35050000), nicht mehr nur drei feste.
do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.accounts'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%sparkasse_duisburg%';
  if c is not null then execute format('alter table public.accounts drop constraint %I', c); end if;
end $$;
alter table public.accounts add constraint accounts_bank_key check (bank ~ '^[a-z0-9_]{2,40}$');
