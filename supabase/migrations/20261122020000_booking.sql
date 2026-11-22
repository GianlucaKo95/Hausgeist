-- Buchungen (Hotel/Reise) als freigabepflichtige Aktion.
alter table public.actions drop constraint if exists actions_kind_check;
alter table public.actions add constraint actions_kind_check
  check (kind in ('send_mail', 'order', 'ha_service', 'calendar_event', 'booking'));
