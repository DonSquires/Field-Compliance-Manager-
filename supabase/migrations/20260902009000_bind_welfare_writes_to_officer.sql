drop policy if exists welfare_alerts_insert on public.welfare_alerts;
create policy welfare_alerts_insert on public.welfare_alerts
  for insert
  to authenticated
  with check (
    officer_user_id = (select auth.uid())
    and public.org_access_allowed(organization_id)
  );

drop policy if exists welfare_checks_insert on public.welfare_checks;
create policy welfare_checks_insert on public.welfare_checks
  for insert
  to authenticated
  with check (
    officer_user_id = (select auth.uid())
    and public.org_access_allowed(organization_id)
  );

comment on policy welfare_alerts_insert on public.welfare_alerts is
  'Officers may raise only their own welfare alerts inside an organization they can access; service-role automation bypasses RLS.';

comment on policy welfare_checks_insert on public.welfare_checks is
  'Officers may record only their own welfare check-ins inside an organization they can access; service-role automation bypasses RLS.';