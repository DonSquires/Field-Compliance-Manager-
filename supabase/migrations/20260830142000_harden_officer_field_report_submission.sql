drop policy if exists officer_insert_field_reports on public.officer_field_reports;
drop policy if exists officer_update_field_reports on public.officer_field_reports;

revoke insert, update, delete, truncate on public.officer_field_reports from public, anon, authenticated;

comment on table public.officer_field_reports is
  'Officer field evidence. Authenticated creation and review are owned by governed RPCs; direct client mutations are revoked.';