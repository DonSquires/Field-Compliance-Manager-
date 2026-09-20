-- Quote visibility follows organisation reach (owner walk 2026-09-20).
-- quotes_select / quotes_write / quote_lines_* keyed on the caller's HOME organisation only. A First Security
-- administrator who raised a quote for the Nelson branch (operating provider) could not read it back: the pricing
-- dialog showed "No quoted modules are available for coverage", no lines, and no schedules — while the governed RPCs
-- kept writing. Every child table (proposal modules, scopes, schedules, places) joins quotes inside its policy, so
-- RLS on quotes hid them too. Reach is now the platform's standard: org_access_allowed (home org, its branches,
-- branches the caller is authorised at) to read; is_admin_for_org at the quote's provider (or admin_officer at their
-- own organisation) to write. Client organisations still do not read provider quotes here.

drop policy if exists quotes_select on public.quotes;
create policy quotes_select on public.quotes for select
  using (public.is_grand_master() or public.org_access_allowed(provider_org_id));

drop policy if exists quotes_write on public.quotes;
create policy quotes_write on public.quotes
  using (public.is_grand_master() or public.is_admin_for_org(provider_org_id)
    or (provider_org_id in (select up.organization_id from public.user_profiles up where up.id = auth.uid() and up.role = 'admin_officer')))
  with check (public.is_grand_master() or public.is_admin_for_org(provider_org_id)
    or (provider_org_id in (select up.organization_id from public.user_profiles up where up.id = auth.uid() and up.role = 'admin_officer')));

drop policy if exists quote_lines_select on public.quote_lines;
create policy quote_lines_select on public.quote_lines for select
  using (exists (select 1 from public.quotes q where q.id = quote_lines.quote_id and (public.is_grand_master() or public.org_access_allowed(q.provider_org_id))));

drop policy if exists quote_lines_write on public.quote_lines;
create policy quote_lines_write on public.quote_lines
  using (exists (select 1 from public.quotes q where q.id = quote_lines.quote_id and (public.is_grand_master() or public.is_admin_for_org(q.provider_org_id)
    or (q.provider_org_id in (select up.organization_id from public.user_profiles up where up.id = auth.uid() and up.role = 'admin_officer')))))
  with check (exists (select 1 from public.quotes q where q.id = quote_lines.quote_id and (public.is_grand_master() or public.is_admin_for_org(q.provider_org_id)
    or (q.provider_org_id in (select up.organization_id from public.user_profiles up where up.id = auth.uid() and up.role = 'admin_officer')))));
