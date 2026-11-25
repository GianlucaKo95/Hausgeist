-- Gesprächsverlauf: Themen-Titel (statt erster Nachricht) und Bereich (nach Fach-Agent)
alter table public.conversations add column if not exists category text;
alter table public.conversations add column if not exists titled boolean not null default false;
