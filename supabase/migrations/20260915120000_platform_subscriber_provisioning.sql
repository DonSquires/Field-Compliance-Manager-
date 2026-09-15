-- Platform-owner boundary and subscriber provisioning
-- (owner rulings 2026-09-15, docs/canon/ORG_SERVICE_MODEL.md § "Platform-owner boundary").
--
-- 1. A Layer-1 FINANCIAL agreement (Iron Eagle -> subscriber) is a billing link only.
--    It no longer confers org_access_allowed visibility or is_master_for_org /
--    is_admin_for_org write authority in either direction. Only OPERATIONAL
--    agreements (provider delivers services to a client) carry the 0271 reach.
-- 2. is_grand_master(), org_access_allowed(), is_master_for_org() and is_admin_for_org()
--    all honour deactivated_at, so "deactivate" is fail-closed at RLS.
-- 3. 'dispatch' and 'cctv' become sellable catalog modules.
-- 4. platform_provision_subscriber(): the governed, grand_master-only path that
--    creates (or reclassifies a dependent-free CRM prospect into) an own-rooted
--    service_provider, creates the financial agreement, and seeds subscriptions +
--    operational enablement. Replaces direct organizations inserts for subscribers.
-- 5. One-off data steps for the first subscriber (no-ops where the rows are absent,
--    so the disposable oracle database applies this file cleanly):
--    - deactivate + downgrade the duplicate "Bob (AI Agent)" grand_master inside
--      First Security (ruling: only the owner and Bob …b0b0 hold grand_master);
--    - reclassify R & M Security and Investigation as a subscriber;
--    - re-home don@ironeagle.co.nz (08369a00…) as R & M's master and archive the demo
--      provider "Iron Eagle Security Ltd operations" it used to run.

-- ---------------------------------------------------------------------------
-- 1. Agreement-based reach is operational-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."org_access_allowed"(target_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    is_grand_master()
    or exists (
      select 1
      from user_profiles p
      where p.id = auth.uid() and p.deactivated_at is null
        and (
          p.organization_id = target_org_id
          or target_org_id = any(p.authorized_organization_ids)
        )
    )
    or exists (
      select 1
      from user_profiles p
      where p.id = auth.uid() and p.deactivated_at is null
        and p.role in ('grand_master', 'master', 'admin')
        and (
          target_org_id = any(get_descendant_organizations(p.organization_id))
          or (
            p.employer_organization_id is not null
            and target_org_id = any(get_descendant_organizations(p.employer_organization_id))
          )
        )
    )
    or exists (
      select 1
      from provider_client_access_grants g
      join user_profiles p on p.id = auth.uid() and p.deactivated_at is null
      where (
        p.organization_id = g.provider_organization_id
        or p.organization_id = g.client_organization_id
      )
        and (g.ends_at is null or g.ends_at > now())
        and (
          g.provider_organization_id = target_org_id
          or g.client_organization_id = target_org_id
        )
    )
    -- Agreement-based visibility (0271 Model A), OPERATIONAL agreements only.
    -- A Layer-1 financial (platform subscription) agreement is a billing link and
    -- confers no data reach in either direction (owner ruling 2026-09-15).
    or exists (
      select 1
      from service_agreements sa
      join user_profiles p on p.id = auth.uid() and p.deactivated_at is null
      where (sa.ends_on is null or sa.ends_on >= current_date)
        and sa.agreement_type = 'operational'
        and (
          (sa.client_organization_id = target_org_id
           and (p.organization_id = sa.provider_organization_id
                or p.employer_organization_id = sa.provider_organization_id))
          or
          (sa.provider_organization_id = target_org_id
           and (p.organization_id = sa.client_organization_id
                or p.employer_organization_id = sa.client_organization_id))
        )
    );
$function$;
COMMENT ON FUNCTION "public"."org_access_allowed"(target_org_id uuid) IS 'Returns true if the current user can access the target organisation. Respects grand_master, direct membership, authorized_organization_ids, master/admin ownership-tree descent (0132), provider/client access grants, and agreement-based visibility for own-rooted orgs on OPERATIONAL agreements only (0271 Model A; financial platform agreements confer no reach — owner ruling 2026-09-15).';

CREATE OR REPLACE FUNCTION "public"."is_master_for_org"(p_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select exists (
    select 1 from public.user_profiles up
    where up.id = auth.uid()
      and up.role = 'master'
      and up.deactivated_at is null
      and (
        p_org_id = any (public.get_descendant_organizations(up.employer_organization_id))
        or p_org_id = any (public.get_descendant_organizations(up.organization_id))
        or exists (
          select 1 from public.service_agreements sa
          where (sa.ends_on is null or sa.ends_on >= current_date)
            and sa.agreement_type = 'operational'
            and sa.client_organization_id = p_org_id
            and (up.organization_id = sa.provider_organization_id
                 or up.employer_organization_id = sa.provider_organization_id)
        )
      )
  );
$function$;
COMMENT ON FUNCTION "public"."is_master_for_org"(p_org_id uuid) IS 'True when the current user is an active master and p_org_id is within their authorised org tree (employer_organization_id or organization_id descendants) OR the user is a master at the provider org on an active OPERATIONAL service_agreement with p_org_id as client (0271 Model A; financial agreements excluded — owner ruling 2026-09-15). Scopes master self-management; never grants delete.';

CREATE OR REPLACE FUNCTION "public"."is_admin_for_org"(target_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from user_profiles
    where id = auth.uid()
      and deactivated_at is null
      and role in ('grand_master', 'master', 'admin')
      and (
        role = 'grand_master'
        or (role = 'master' and (
          target_org_id = any (public.get_descendant_organizations(employer_organization_id))
          or target_org_id = any (public.get_descendant_organizations(organization_id))
          or exists (
            select 1 from public.service_agreements sa
            where (sa.ends_on is null or sa.ends_on >= current_date)
              and sa.agreement_type = 'operational'
              and sa.client_organization_id = target_org_id
              and (organization_id = sa.provider_organization_id
                   or employer_organization_id = sa.provider_organization_id)
          )
        ))
        or (role = 'admin' and (
          organization_id = target_org_id
          or target_org_id = any (public.get_descendant_organizations(organization_id))
          or exists (
            select 1 from public.service_agreements sa
            where (sa.ends_on is null or sa.ends_on >= current_date)
              and sa.agreement_type = 'operational'
              and sa.client_organization_id = target_org_id
              and (organization_id = sa.provider_organization_id
                   or employer_organization_id = sa.provider_organization_id)
          )
        ))
      )
  );
$function$;
COMMENT ON FUNCTION "public"."is_admin_for_org"(target_org_id uuid) IS 'Returns true if the current active user is admin, master, or grand_master for the target org. Admin/master check the org descendant tree (via get_descendant_organizations) and agreement-based provider access on OPERATIONAL agreements only (0271 Model A; financial agreements excluded — owner ruling 2026-09-15). Grand master has unrestricted access.';

-- Tier 0 (BOB_DOCTRINE §3): the counterparty on ANY active agreement may see the other
-- party's organisations row (name, type, contact) — nothing else. This keeps the
-- platform owner's name visible to a subscriber's "Platform Subscription" view after
-- the financial agreement stops conferring data reach.
DROP POLICY IF EXISTS "organizations_select_agreement_counterparty" ON "public"."organizations";
CREATE POLICY "organizations_select_agreement_counterparty" ON "public"."organizations"
  FOR SELECT TO "authenticated"
  USING (
    exists (
      select 1
      from public.service_agreements sa
      join public.user_profiles p on p.id = auth.uid()
      where (sa.ends_on is null or sa.ends_on >= current_date)
        and (
          (sa.provider_organization_id = organizations.id
           and (p.organization_id = sa.client_organization_id or p.employer_organization_id = sa.client_organization_id))
          or
          (sa.client_organization_id = organizations.id
           and (p.organization_id = sa.provider_organization_id or p.employer_organization_id = sa.provider_organization_id))
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 2. A deactivated grand_master is not a grand_master
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."is_grand_master"()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid() and role = 'grand_master' and deactivated_at is null
  );
$function$;
COMMENT ON FUNCTION "public"."is_grand_master"() IS 'Returns true if the current user holds the grand_master role and is not deactivated.';

-- ---------------------------------------------------------------------------
-- 3. Dispatch and CCTV are sellable platform modules
-- ---------------------------------------------------------------------------
INSERT INTO public.module_catalog (module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active)
VALUES
  ('dispatch', 0, 0, 0, 'monthly', 'NZD', true),
  ('cctv', 0, 0, 0, 'monthly', 'NZD', true)
ON CONFLICT (module_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Governed subscriber provisioning (grand_master only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_provision_subscriber_internal(
  p_actor uuid,
  p_client_request_id uuid,
  p_organization_id uuid,
  p_name text,
  p_module_keys text[],
  p_starts_on date DEFAULT current_date
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
  v_org public.organizations%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_agreement_id uuid;
  v_key text;
  v_unknown text[];
  v_created boolean := false;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if p_module_keys is null or cardinality(p_module_keys) = 0 then raise exception 'At least one module key is required'; end if;

  select id into v_owner from public.organizations where organization_type = 'owner' and active order by created_at limit 1;
  if v_owner is null then raise exception 'Platform owner organisation not found'; end if;
  if (select count(*) from public.organizations where organization_type = 'owner' and active) > 1 then
    raise exception 'More than one active owner organisation; refusing to guess the platform owner';
  end if;

  select array_agg(k) into v_unknown
  from unnest(p_module_keys) k
  where not exists (select 1 from public.module_catalog m where m.module_key = k and m.active);
  if v_unknown is not null then raise exception 'Unknown or inactive module key(s): %', array_to_string(v_unknown, ', '); end if;

  -- Idempotency: the same request id returns the same receipt.
  select o.* into v_org from public.organizations o
  where o.client_request_id = p_client_request_id and o.organization_type = 'service_provider' and o.parent_organization_id is null;
  if found then
    select id into v_agreement_id from public.service_agreements
    where agreement_type = 'financial' and provider_organization_id = v_owner and client_organization_id = v_org.id
    order by created_at limit 1;
    return jsonb_build_object('organization_id', v_org.id, 'name', v_org.name, 'agreement_id', v_agreement_id, 'created', false, 'module_keys', p_module_keys, 'replayed', true);
  end if;

  if p_organization_id is not null then
    select o.* into v_org from public.organizations o where o.id = p_organization_id for update;
    if not found then raise exception 'Organisation not found'; end if;
    if v_org.organization_type = 'owner' then raise exception 'The platform owner cannot be provisioned as a subscriber'; end if;
    if v_org.organization_type <> 'service_provider' or v_org.parent_organization_id is not null then
      -- Reclassification is only allowed while nothing depends on the row.
      if exists (select 1 from public.user_profiles u where u.organization_id = v_org.id or u.employer_organization_id = v_org.id) then
        raise exception 'Organisation already has users; it cannot be reclassified as a new subscriber';
      end if;
      if exists (select 1 from public.client_sites s where s.client_organization_id = v_org.id) then
        raise exception 'Organisation already owns places; it cannot be reclassified as a new subscriber';
      end if;
      if exists (select 1 from public.service_agreements sa where sa.provider_organization_id = v_org.id or (sa.client_organization_id = v_org.id and sa.agreement_type = 'operational')) then
        raise exception 'Organisation already has service agreements; it cannot be reclassified as a new subscriber';
      end if;
      if exists (select 1 from public.organizations c where c.parent_organization_id = v_org.id) then
        raise exception 'Organisation has child organisations; it cannot be reclassified as a new subscriber';
      end if;
    end if;
    update public.organizations
       set organization_type = 'service_provider',
           parent_organization_id = null,
           active = true,
           status = 'active',
           name = coalesce(v_name, name),
           client_request_id = p_client_request_id,
           account_owner_user_id = null,
           updated_at = now()
     where id = v_org.id
     returning * into v_org;
  else
    if v_name is null or char_length(v_name) > 200 then raise exception 'Organisation name is required and must be 200 characters or fewer'; end if;
    if exists (select 1 from public.organizations o where o.parent_organization_id is null and lower(trim(o.name)) = lower(v_name)) then
      raise exception 'An own-rooted organisation with this name already exists';
    end if;
    insert into public.organizations (name, organization_type, parent_organization_id, active, status, client_request_id)
    values (v_name, 'service_provider', null, true, 'active', p_client_request_id)
    returning * into v_org;
    v_created := true;
  end if;

  select id into v_agreement_id from public.service_agreements
  where agreement_type = 'financial' and provider_organization_id = v_owner and client_organization_id = v_org.id
    and (ends_on is null or ends_on >= current_date)
  order by created_at limit 1;
  if v_agreement_id is null then
    insert into public.service_agreements (provider_organization_id, client_organization_id, name, agreement_type, starts_on, ends_on, enabled_modules, invitation_status)
    values (v_owner, v_org.id, 'Iron Eagle - ' || v_org.name || ' Platform Agreement', 'financial', coalesce(p_starts_on, current_date), null, p_module_keys, 'not_invited')
    returning id into v_agreement_id;
  else
    update public.service_agreements
       set enabled_modules = (select array_agg(distinct k) from unnest(enabled_modules || p_module_keys) k)
     where id = v_agreement_id;
  end if;

  -- Layer-1 subscription lines (what Iron Eagle bills), then operational enablement
  -- in dependency order so tg_enforce_module_dependencies is satisfied.
  for v_key in
    select k from unnest(p_module_keys) k
    order by (exists (select 1 from public.module_dependencies d where d.module_key = k)), k
  loop
    insert into public.org_module_subscriptions (organization_id, module_key, status, started_at, created_by, updated_by)
    values (v_org.id, v_key, 'active', coalesce(p_starts_on, current_date), p_actor, p_actor)
    on conflict (organization_id, module_key) do update
      set status = 'active', ended_at = null, updated_at = now(), updated_by = excluded.updated_by;
    insert into public.organization_modules (organization_id, module_key, enabled)
    values (v_org.id, v_key, true)
    on conflict (organization_id, module_key) do update set enabled = true;
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_org.id, p_actor, 'platform_subscriber_provisioned', 'organizations', v_org.id,
          jsonb_build_object('created', v_created, 'agreement_id', v_agreement_id, 'module_keys', p_module_keys, 'client_request_id', p_client_request_id, 'owner_organization_id', v_owner));

  return jsonb_build_object('organization_id', v_org.id, 'name', v_org.name, 'agreement_id', v_agreement_id, 'created', v_created, 'module_keys', p_module_keys, 'replayed', false);
end;
$function$;
REVOKE ALL ON FUNCTION public.platform_provision_subscriber_internal(uuid, uuid, uuid, text, text[], date) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.platform_provision_subscriber_internal(uuid, uuid, uuid, text, text[], date) IS 'Definer-only body of platform_provision_subscriber; callable from migrations with an explicit actor. Not granted to any API role.';

CREATE OR REPLACE FUNCTION public.platform_provision_subscriber(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_name text,
  p_module_keys text[],
  p_starts_on date DEFAULT current_date
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null or not public.is_grand_master() then raise exception 'Iron Eagle platform owner required'; end if;
  return public.platform_provision_subscriber_internal(auth.uid(), p_client_request_id, p_organization_id, p_name, p_module_keys, p_starts_on);
end;
$function$;
REVOKE ALL ON FUNCTION public.platform_provision_subscriber(uuid, uuid, text, text[], date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_provision_subscriber(uuid, uuid, text, text[], date) TO authenticated;
COMMENT ON FUNCTION public.platform_provision_subscriber(uuid, uuid, text, text[], date) IS 'Layer-1 onboarding (owner ruling 2026-09-15): grand_master creates, or reclassifies a dependent-free CRM prospect into, an own-rooted service_provider subscriber; creates the Iron Eagle financial platform agreement; seeds org_module_subscriptions and organization_modules for the purchased modules. Hand off to invite-org for the first master. Idempotent on p_client_request_id.';

-- ---------------------------------------------------------------------------
-- 5. First-subscriber data steps (each guarded; no-ops where rows are absent)
-- ---------------------------------------------------------------------------
DO $$
declare
  v_owner_actor uuid := '1b02ab97-8611-40ab-a3a0-b5c74589db58'; -- Don Squires (grand_master, Iron Eagle)
  v_dup_bob uuid := 'a1145982-b07f-4776-88b9-f476de36c802';     -- duplicate "Bob (AI Agent)" inside First Security
  v_rm uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';          -- R & M Security and Investigation
  v_rm_master uuid := '08369a00-e2df-45d6-9e6b-6b3a6bede645';   -- don@ironeagle.co.nz
  v_demo_provider uuid := '3577d7bc-326c-4b5e-806b-5e0854325be7'; -- Iron Eagle Security Ltd operations (demo)
  v_demo_branch uuid := '902fc6af-0ca9-4f02-93b4-4cbedb8a35a5';   -- Iron Eagle Nelson (demo branch)
  v_receipt jsonb;
  v_key text;
begin
  if not exists (select 1 from public.user_profiles where id = v_owner_actor and role = 'grand_master') then
    return; -- not the live project (oracle database): nothing to do
  end if;

  -- 5a. Only the owner and Bob …b0b0 hold grand_master.
  if exists (select 1 from public.user_profiles where id = v_dup_bob and role = 'grand_master' and deactivated_at is null) then
    update public.user_profiles
       set deactivated_at = now(), deactivated_by = v_owner_actor, role = 'officer'
     where id = v_dup_bob;
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    select organization_id, v_owner_actor, 'user_deactivated', 'user_profiles', id,
           jsonb_build_object('reason', 'Owner ruling 2026-09-15: grand_master is held only by the owner and Bob …b0b0 in Iron Eagle', 'previous_role', 'grand_master', 'display_name', display_name)
      from public.user_profiles where id = v_dup_bob;
  end if;

  -- 5b. R & M becomes an own-rooted subscriber with its purchased modules.
  if exists (select 1 from public.organizations where id = v_rm and organization_type <> 'service_provider') then
    v_receipt := public.platform_provision_subscriber_internal(
      v_owner_actor,
      'c0a80f5e-9e4b-4b6f-8d2e-2026091500a1'::uuid,
      v_rm,
      'R & M Security and Investigation',
      array['patrol', 'rostering', 'finance', 'invoicing', 'noise_control', 'client_reporting', 'crm', 'hr', 'dispatch', 'cctv', 'static_guarding', 'welfare', 'ptt_radio', 'bob_assistant'],
      current_date);
    raise notice 'R & M provisioned: %', v_receipt;
  end if;

  -- 5c. don@ironeagle.co.nz becomes R & M's master; the demo provider it ran is archived.
  if exists (select 1 from public.user_profiles where id = v_rm_master and organization_id = v_demo_provider)
     and exists (select 1 from public.organizations where id = v_rm and organization_type = 'service_provider') then
    update public.user_profiles
       set organization_id = v_rm, employer_organization_id = v_rm, role = 'master',
           display_name = 'Don Squires', authorized_organization_ids = '{}'
     where id = v_rm_master;
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_rm, v_owner_actor, 'user_rehomed_as_subscriber_master', 'user_profiles', v_rm_master,
            jsonb_build_object('from_organization_id', v_demo_provider, 'to_organization_id', v_rm, 'reason', 'Owner decision 2026-09-15: first R & M master'));

    -- Archive the demo provider and its branch; end its platform agreement; cancel its lines.
    for v_key in
      select om.module_key from public.organization_modules om
      where om.organization_id = v_demo_provider and om.enabled
      order by (exists (select 1 from public.module_dependencies d where d.depends_on_module_key = om.module_key)), om.module_key
    loop
      update public.organization_modules set enabled = false where organization_id = v_demo_provider and module_key = v_key;
    end loop;
    update public.org_module_subscriptions
       set status = 'cancelled', ended_at = current_date, updated_at = now(), updated_by = v_owner_actor
     where organization_id = v_demo_provider and status <> 'cancelled';
    update public.service_agreements
       set ends_on = current_date
     where agreement_type = 'financial' and client_organization_id = v_demo_provider and (ends_on is null or ends_on > current_date);
    update public.organizations
       set active = false, status = 'archived', updated_at = now()
     where id in (v_demo_provider, v_demo_branch) and status <> 'archived';
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_demo_provider, v_owner_actor, 'organization_archived', 'organizations', v_demo_provider,
            jsonb_build_object('reason', 'Demo provider superseded by the first real subscriber (R & M); owner decision 2026-09-15', 'branch_ids', jsonb_build_array(v_demo_branch)));
  end if;
end $$;
