-- Hilfsfunktionen für RLS aus der öffentlichen API nehmen und anon den Zugriff entziehen.
create schema if not exists private;
grant usage on schema private to authenticated;

alter function public.current_app_user() set schema private;
alter function public.is_adult_member() set schema private;
alter function public.is_member() set schema private;

revoke execute on function private.current_app_user() from public, anon;
revoke execute on function private.is_adult_member() from public, anon;
revoke execute on function private.is_member() from public, anon;
grant execute on function private.current_app_user() to authenticated;
grant execute on function private.is_adult_member() to authenticated;
grant execute on function private.is_member() to authenticated;

-- Trigger-Funktionen mit festem search_path.
alter function public.approvals_freeze() set search_path = '';
alter function public.invoices_freeze() set search_path = '';
alter function public.actions_freeze() set search_path = '';
