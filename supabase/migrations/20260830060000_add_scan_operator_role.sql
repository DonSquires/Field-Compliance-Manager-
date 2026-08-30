alter table public.user_profiles
  drop constraint if exists user_profiles_role_check;

alter table public.user_profiles
  add constraint user_profiles_role_check
  check (role = any (array[
    'grand_master'::text,
    'master'::text,
    'admin'::text,
    'admin_officer'::text,
    'nzscv_monitor'::text,
    'officer'::text,
    'scan_operator'::text,
    'client_admin'::text,
    'client_officer'::text,
    'client_viewer'::text
  ]));