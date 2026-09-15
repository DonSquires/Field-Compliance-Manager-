-- Owner console: subscriber lifecycle and aggregate activity; R & M default guard pay.
-- (owner rulings 2026-09-15: Iron Eagle manages the subscription — suspend, cancel,
-- reinstate, monitor activity — but never reads a subscriber's records; "we can put a
-- default pay rate of $30 per hour for a guard's pay rate".)
--
-- 1. platform_list_subscribers(): grand_master-only list of subscriber organisations
--    with their platform agreement, subscription lines, and AGGREGATE activity only
--    (user counts, last sign-in, 30-day shift/job counts). No names, no records.
-- 2. platform_set_subscriber_status(): suspend / reinstate / cancel a whole subscriber
--    in one audited act. Suspend and cancel turn every operational module off (the
--    app's module gate hides gated pages) and mark the subscription lines; reinstate
--    restores exactly the lines that were active before, from the audit receipt.
-- 3. R & M: one wildcard staff pay rule, 'Guard (default pay, per hour)' $30.00, so
--    completed jobs price their pay side until more specific rules exist.

-- ---------------------------------------------------------------------------
-- 1. Subscriber list with aggregate activity (owner only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_list_subscribers()
 RETURNS TABLE(
   organization_id uuid, name text, organization_type text, status text, active boolean, created_at timestamptz, updated_at timestamptz,
   contact_email text, agreement_id uuid, agreement_starts_on date, agreement_ends_on date,
   module_keys text[], active_module_count integer, suspended_module_count integer, cancelled_module_count integer,
   user_count integer, active_user_count integer, master_count integer, last_sign_in_at timestamptz,
   shifts_30d integer, jobs_30d integer, sites integer, branches integer
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with owner as (
    select o.id from public.organizations o where o.organization_type = 'owner' and o.active order by o.created_at limit 1
  )
  select
    o.id, o.name, o.organization_type, o.status, o.active, o.created_at, o.updated_at,
    o.contact_email,
    sa.id, sa.starts_on, sa.ends_on,
    coalesce((select array_agg(s.module_key order by s.module_key) from public.org_module_subscriptions s where s.organization_id = o.id and s.status <> 'cancelled'), '{}'::text[]),
    (select count(*)::integer from public.org_module_subscriptions s where s.organization_id = o.id and s.status = 'active'),
    (select count(*)::integer from public.org_module_subscriptions s where s.organization_id = o.id and s.status = 'suspended'),
    (select count(*)::integer from public.org_module_subscriptions s where s.organization_id = o.id and s.status = 'cancelled'),
    (select count(*)::integer from public.user_profiles u where u.organization_id = o.id),
    (select count(*)::integer from public.user_profiles u where u.organization_id = o.id and u.deactivated_at is null),
    (select count(*)::integer from public.user_profiles u where u.organization_id = o.id and u.deactivated_at is null and u.role = 'master'),
    (select max(au.last_sign_in_at) from public.user_profiles u join auth.users au on au.id = u.id where u.organization_id = o.id),
    (select count(*)::integer from public.shifts s where s.organization_id = o.id and s.scheduled_start >= now() - interval '30 days'),
    (select count(*)::integer from public.dispatch_jobs j where j.organization_id = o.id and j.created_at >= now() - interval '30 days'),
    (select count(*)::integer from public.client_sites cs where cs.organization_id = o.id),
    (select count(*)::integer from public.organizations b where b.parent_organization_id = o.id and b.organization_type = 'branch' and b.status <> 'archived')
  from public.organizations o
  cross join owner
  left join lateral (
    select a.id, a.starts_on, a.ends_on from public.service_agreements a
    where a.agreement_type = 'financial' and a.provider_organization_id = owner.id and a.client_organization_id = o.id
    order by (a.ends_on is null or a.ends_on >= current_date) desc, a.created_at desc limit 1
  ) sa on true
  where public.is_grand_master()
    and o.organization_type = 'service_provider'
    and o.parent_organization_id is null
    and o.id <> owner.id
  order by (o.status = 'active') desc, o.name;
$function$;
REVOKE ALL ON FUNCTION public.platform_list_subscribers() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_list_subscribers() TO authenticated;
COMMENT ON FUNCTION public.platform_list_subscribers() IS 'Owner console: subscriber organisations with platform agreement, subscription lines, and aggregate activity (counts and last sign-in only). Returns no rows for anyone but grand_master; exposes no operational or financial records.';

-- ---------------------------------------------------------------------------
-- 2. Subscriber lifecycle (owner only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_set_subscriber_status(
  p_organization_id uuid,
  p_status text,
  p_reason text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org public.organizations%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_key text;
  v_restore text[];
  v_affected integer := 0;
begin
  if v_actor is null or not public.is_grand_master() then raise exception 'Iron Eagle platform owner required'; end if;
  if p_status not in ('active', 'suspended', 'cancelled') then raise exception 'Unsupported subscriber status'; end if;
  select * into v_org from public.organizations where id = p_organization_id for update;
  if not found or v_org.organization_type <> 'service_provider' or v_org.parent_organization_id is not null then
    raise exception 'Subscriber organisation not found';
  end if;
  if p_status in ('suspended', 'cancelled') and v_reason is null then raise exception 'A reason is required to suspend or cancel a subscriber'; end if;

  if p_status = 'active' then
    -- Reinstate what was active before the last suspension; fall back to every non-cancelled line.
    select coalesce(array(select jsonb_array_elements_text(al.metadata->'active_modules')), '{}'::text[]) into v_restore
    from public.audit_log al where al.target_id = v_org.id and al.action in ('platform_subscriber_suspended', 'platform_subscriber_cancelled')
    order by al.created_at desc limit 1;
    if v_restore is null or cardinality(v_restore) = 0 then
      select coalesce(array_agg(module_key), '{}'::text[]) into v_restore from public.org_module_subscriptions where organization_id = v_org.id and status <> 'cancelled';
    end if;
    update public.org_module_subscriptions set status = 'active', ended_at = null, updated_at = now(), updated_by = v_actor
     where organization_id = v_org.id and module_key = any(v_restore) and status <> 'active';
    get diagnostics v_affected = row_count;
    for v_key in
      select k from unnest(v_restore) k
      order by (exists (select 1 from public.module_dependencies d where d.module_key = k)), k
    loop
      insert into public.organization_modules (organization_id, module_key, enabled) values (v_org.id, v_key, true)
      on conflict (organization_id, module_key) do update set enabled = true;
    end loop;
    update public.organizations set status = 'active', active = true, updated_at = now() where id = v_org.id returning * into v_org;
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_org.id, v_actor, 'platform_subscriber_reinstated', 'organizations', v_org.id, jsonb_build_object('reason', v_reason, 'modules_restored', v_restore, 'lines_updated', v_affected));
  else
    select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_restore
    from public.org_module_subscriptions where organization_id = v_org.id and status = 'active';
    update public.org_module_subscriptions
       set status = p_status, ended_at = case when p_status = 'cancelled' then current_date else ended_at end, updated_at = now(), updated_by = v_actor
     where organization_id = v_org.id and status = 'active';
    get diagnostics v_affected = row_count;
    for v_key in
      select om.module_key from public.organization_modules om where om.organization_id = v_org.id and om.enabled
      order by (exists (select 1 from public.module_dependencies d where d.depends_on_module_key = om.module_key)), om.module_key
    loop
      update public.organization_modules set enabled = false where organization_id = v_org.id and module_key = v_key;
    end loop;
    update public.organizations set status = case when p_status = 'cancelled' then 'archived' else 'suspended' end, active = (p_status = 'suspended'), updated_at = now()
     where id = v_org.id returning * into v_org;
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_org.id, v_actor, case when p_status = 'cancelled' then 'platform_subscriber_cancelled' else 'platform_subscriber_suspended' end, 'organizations', v_org.id,
            jsonb_build_object('reason', v_reason, 'active_modules', v_restore, 'lines_updated', v_affected));
  end if;

  return jsonb_build_object('organization_id', v_org.id, 'status', v_org.status, 'active', v_org.active, 'modules', v_restore, 'lines_updated', v_affected);
end;
$function$;
REVOKE ALL ON FUNCTION public.platform_set_subscriber_status(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_set_subscriber_status(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.platform_set_subscriber_status(uuid, text, text) IS 'Owner console: suspend, reinstate, or cancel a subscriber organisation as one audited act — subscription lines and operational module enablement move together; reinstatement restores the lines recorded at suspension. grand_master only; a reason is required to suspend or cancel.';

-- ---------------------------------------------------------------------------
-- 3. R & M default guard pay (no-op where R & M is absent, e.g. the oracle database)
-- ---------------------------------------------------------------------------
DO $$
declare
  v_rm uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_master uuid := '08369a00-e2df-45d6-9e6b-6b3a6bede645';
begin
  if not exists (select 1 from public.organizations where id = v_rm and organization_type = 'service_provider' and active)
     or not exists (select 1 from public.user_profiles where id = v_master and organization_id = v_rm and deactivated_at is null) then
    return;
  end if;
  insert into public.rate_rules (organization_id, rule_kind, name, rate_type, amount, pay_code, effective_from, priority, active, created_by, updated_by, client_request_id)
  values (v_rm, 'pay', 'Guard (default pay, per hour)', 'hourly', 30.00, 'GUARD-HOURLY', date '2025-04-01', -10, true, v_master, v_master, 'c0a80f5e-9e4b-4b6f-8d2e-2026091515a1'::uuid)
  on conflict (organization_id, client_request_id) where client_request_id is not null do nothing;
  if found then
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_rm, v_master, 'rate_rule_seeded_default_pay', 'rate_rules', v_rm,
            jsonb_build_object('name', 'Guard (default pay, per hour)', 'amount', 30.00, 'basis', 'Owner instruction in chat 2026-09-15: default guard pay $30/hour', 'note', 'wildcard rule (no service or job type) so any more specific pay rule wins'));
  end if;
end $$;
