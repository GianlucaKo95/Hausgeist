-- Beispiel: Nutzer und Konten anlegen. Werte anpassen und im SQL-Editor von Supabase ausführen.
-- ha_user_id:     Einstellungen → Personen → Benutzer öffnen, ID steht in der URL
--                 (oder in Entwicklerwerkzeuge → Ereignisse auf mobile_app_notification_action
--                 hören und context.user_id ablesen).
-- notify_service: Entwicklerwerkzeuge → Aktionen → "notify.mobile_app_…" (ohne "notify.").

insert into public.users (name, role, approval_limit_cents, ha_user_id, notify_service) values
  ('Luca',  'admin', 0,     '<ha-user-id>', 'mobile_app_<lucas_iphone>'),
  ('<Name>', 'adult', 50000, '<ha-user-id>', 'mobile_app_<geraet>');
-- Kinder: role 'child', approval_limit_cents 0, notify_service null.

insert into public.accounts (label, bank, iban, match_names, is_default) values
  ('Sparkasse Giro',     'sparkasse_duisburg', '<IBAN>', array['Köhni'],      true),
  ('Deutsche Bank Giro', 'deutsche_bank',      '<IBAN>', array[]::text[],     false),
  ('DKB Giro',           'dkb',                '<IBAN>', array['KoeVen'],     false);

insert into public.mailboxes (name, visibility, scope) values
  ('privat', 'shared', 'private');
