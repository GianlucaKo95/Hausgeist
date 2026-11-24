-- Gemeinsamer Familienaccount für den Familienplaner: ohne Freigaben, Finanzen, Mail und IT.
alter type public.user_role add value if not exists 'family';
