-- Admin officer parity (owner ruling 2026-10-27).
--
-- An admin_officer is an admin person who also works in the field and holds exactly the same
-- access as an admin. identity_role_level already ranks admin_officer equal to admin; these
-- functions still granted something to 'admin' alone, so an admin_officer was silently refused
-- admin work (org entitlement, approvals, payroll setup, identity management, hazard review,
-- leave review, invitations and the admin notification inbox).
--
-- Every CREATE OR REPLACE below is the live definition (verified identical to
-- pg_get_functiondef before authoring) with 'admin_officer' added wherever 'admin' is granted.
-- Nothing else changes. role_at_branch lists are branch-scoped role vocabularies, not the
-- profile role, and are left untouched.
--
-- Field ticks (NZTA vehicle-owner and person search) remain per-person authorisations; this
-- migration does not grant or revoke them.
CREATE OR REPLACE FUNCTION "public"."_entitled_org_ids_for"(p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- CLAUSE 1: grand_master sees ALL orgs.
  select o.id
  from public.organizations o
  where exists (
    select 1 from public.user_profiles p
    where p.id = p_user_id and p.role = 'grand_master'
  )

  union

  -- CLAUSE 2: own org + authorized_organization_ids.
  select target.id
  from public.organizations target
  join public.user_profiles p on p.id = p_user_id
  where target.id = p.organization_id
     or target.id = any(p.authorized_organization_ids)

  union

  -- CLAUSE 3: master/admin ownership-tree descent (org + employer anchors).
  select d.org_id
  from public.user_profiles p
  cross join lateral (
    select unnest(
      public.get_descendant_organizations(p.organization_id)
      || case
           when p.employer_organization_id is not null
           then public.get_descendant_organizations(p.employer_organization_id)
           else array[]::uuid[]
         end
    ) as org_id
  ) d
  where p.id = p_user_id
    and p.role in ('grand_master', 'master', 'admin', 'admin_officer')

  union

  -- CLAUSE 4: provider_client_access_grants (active).
  select g_target.org_id
  from public.provider_client_access_grants g
  join public.user_profiles p on p.id = p_user_id
  cross join lateral (
    values (g.provider_organization_id), (g.client_organization_id)
  ) as g_target(org_id)
  where (
      p.organization_id = g.provider_organization_id
      or p.organization_id = g.client_organization_id
    )
    and (g.ends_at is null or g.ends_at > now())

  union

  -- CLAUSE 5 (0271): agreement-based, bidirectional.
  select sa_target.org_id
  from public.service_agreements sa
  join public.user_profiles p on p.id = p_user_id
  cross join lateral (
    values
      (case when (p.organization_id = sa.provider_organization_id
                  or p.employer_organization_id = sa.provider_organization_id)
            then sa.client_organization_id end),
      (case when (p.organization_id = sa.client_organization_id
                  or p.employer_organization_id = sa.client_organization_id)
            then sa.provider_organization_id end)
  ) as sa_target(org_id)
  where (sa.ends_on is null or sa.ends_on >= current_date)
    and sa_target.org_id is not null;
$function$;

CREATE OR REPLACE FUNCTION "public"."accept_client_invitation"()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_client_name text;
  v_accepted integer := 0;
  v_row record;
  v_inviter uuid;
begin
  select * into v_profile from public.user_profiles where id = v_actor and deactivated_at is null;
  if not found then raise exception 'Active user required'; end if;
  select name into v_client_name from public.organizations where id = v_profile.organization_id;

  for v_row in
    update public.service_agreements a
    set invitation_status = 'accepted'
    where a.client_organization_id = v_profile.organization_id
      and a.invitation_status = 'invited'
    returning a.id, a.name, a.agreement_type, a.provider_organization_id
  loop
    v_accepted := v_accepted + 1;
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_row.provider_organization_id, v_actor, 'client_invitation_accepted', 'service_agreements', v_row.id,
      jsonb_build_object('client_organization_id', v_profile.organization_id, 'agreement_name', v_row.name, 'agreement_type', v_row.agreement_type, 'accepted_by_role', v_profile.role));

    -- whoever prepared the invitation hears first, by name; the agreement holder's administrators as a role
    select l.actor_user_id into v_inviter
    from public.audit_log l
    where l.action = 'crm_client_invitation_prepared' and l.target_id = v_row.id
    order by l.created_at desc limit 1;
    if v_inviter is not null then
      perform public.enqueue_notification(
        p_organization_id => v_row.provider_organization_id, p_category => 'crm_client',
        p_title => coalesce(v_client_name, 'The client') || ' has accepted your invitation',
        p_body => coalesce(v_profile.display_name, 'Their administrator') || ' set their password and can sign in to the client portal. Finish the provider setup, then activate the account.',
        p_severity => 'info', p_recipient_user_id => v_inviter, p_recipient_role => null, p_link_page => 'crm',
        p_link_payload => jsonb_build_object('account_organization_id', v_profile.organization_id, 'agreement_id', v_row.id),
        p_dedup_key => 'crm_client_accepted:' || v_row.id::text || ':' || v_inviter::text);
    end if;
    -- the inviter already has their own row; an admin inviter would otherwise read the same news twice
    if v_inviter is null or not exists (select 1 from public.user_profiles p where p.id = v_inviter and p.role IN ('admin', 'admin_officer')) then
    perform public.enqueue_notification(
      p_organization_id => v_row.provider_organization_id, p_category => 'crm_client',
      p_title => coalesce(v_client_name, 'A client') || ' has accepted the invitation',
      p_body => coalesce(v_profile.display_name, 'Their administrator') || ' can now sign in to the client portal.',
      p_severity => 'info', p_recipient_user_id => null, p_recipient_role => 'admin', p_link_page => 'crm',
      p_link_payload => jsonb_build_object('account_organization_id', v_profile.organization_id, 'agreement_id', v_row.id),
      p_dedup_key => 'crm_client_accepted:' || v_row.id::text || ':admin');
    end if;
  end loop;
  return jsonb_build_object('accepted', v_accepted, 'organization_id', v_profile.organization_id);
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."apply_bob_tentative_roster_block"(p_action_id uuid)
 RETURNS TABLE(slots_created integer, quote_id uuid, first_slot_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action public.bob_agentic_actions%rowtype;
  v_payload jsonb;
  v_approver public.user_profiles%rowtype;
  v_site jsonb;
  v_shift jsonb;
  v_line jsonb;
  v_unit public.roster_work_units%rowtype;
  v_units jsonb := '{}'::jsonb;
  v_quote public.quotes%rowtype;
  v_client_org uuid;
  v_slot_id uuid;
  v_first uuid;
  v_created integer := 0;
  v_index integer := 0;
  v_rows integer;
  v_gst numeric;
begin
  select a.* into v_action from public.bob_agentic_actions a where a.id = p_action_id for update;
  if not found then raise exception 'Bob action not found'; end if;
  if v_action.action_type <> 'apply_tentative_roster_block' or v_action.status <> 'approved' then
    raise exception 'Only approved apply_tentative_roster_block actions can be executed';
  end if;

  select * into v_approver from public.user_profiles where id = v_action.approved_by and deactivated_at is null;
  if not found or v_approver.role not in ('grand_master', 'master', 'admin', 'admin_officer')
     or (v_approver.role <> 'grand_master' and v_approver.organization_id <> v_action.organization_id
         and not (v_action.organization_id = any(coalesce(v_approver.authorized_organization_ids, '{}')))) then
    raise exception 'An active administrator approval is required';
  end if;

  v_payload := coalesce(v_action.amended_payload, v_action.proposed_payload);
  if jsonb_typeof(v_payload->'sites') <> 'array' or jsonb_typeof(v_payload->'shifts') <> 'array'
     or jsonb_array_length(v_payload->'shifts') = 0 or jsonb_array_length(v_payload->'shifts') > 1500 then
    raise exception 'Tentative roster block requires 1 to 1500 shifts and a site list';
  end if;

  for v_site in select value from jsonb_array_elements(v_payload->'sites') loop
    select u.* into v_unit from public.roster_work_units u
    where u.id = (v_site->>'work_unit_id')::uuid and u.organization_id = v_action.organization_id and u.active;
    if not found then raise exception 'Work unit for site % is unavailable', coalesce(v_site->>'label', v_site->>'key'); end if;
    v_units := v_units || jsonb_build_object(v_site->>'key', v_unit.id::text);
  end loop;

  for v_shift in select value from jsonb_array_elements(v_payload->'shifts') loop
    v_index := v_index + 1;
    if not (v_units ? (v_shift->>'site_key')) then raise exception 'Shift % references an unknown site', v_index; end if;
    if (v_shift->>'scheduled_end')::timestamptz <= (v_shift->>'scheduled_start')::timestamptz
       or (v_shift->>'scheduled_end')::timestamptz - (v_shift->>'scheduled_start')::timestamptz > interval '24 hours' then
      raise exception 'Shift % has an invalid time range', v_index;
    end if;
    insert into public.roster_slots(organization_id, work_unit_id, staff_id, scheduled_start, scheduled_end, status,
                                    client_request_id, notes, created_by, external_refs)
    values (v_action.organization_id, (v_units->>(v_shift->>'site_key'))::uuid, null,
            (v_shift->>'scheduled_start')::timestamptz, (v_shift->>'scheduled_end')::timestamptz, 'draft',
            md5(v_action.id::text || ':' || v_index::text)::uuid,
            nullif(trim(v_shift->>'block'), ''), v_action.approved_by,
            jsonb_build_object('source', 'bob_tentative_roster_block', 'action_id', v_action.id,
                               'unpaid_break_minutes', coalesce((v_shift->>'unpaid_break_minutes')::integer, 0)))
    on conflict (organization_id, client_request_id) do nothing
    returning id into v_slot_id;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then v_created := v_created + 1; v_first := coalesce(v_first, v_slot_id); end if;
  end loop;

  v_client_org := nullif(v_payload#>>'{quote,client_org_id}', '')::uuid;
  if v_client_org is not null and jsonb_typeof(v_payload#>'{quote,lines}') = 'array' then
    if not exists (select 1 from public.organizations o where o.id = v_client_org and o.active) then
      raise exception 'Quote client organisation is unavailable';
    end if;
    v_gst := coalesce((v_payload#>>'{quote,gst_rate}')::numeric, 0.15);
    insert into public.quotes(provider_org_id, client_org_id, title, status, gst_rate, notes, created_by, client_request_id)
    values (v_action.organization_id, v_client_org,
            coalesce(nullif(trim(v_payload#>>'{quote,title}'), ''), 'Static guard roster block'), 'draft', v_gst,
            'Generated by Bob from an approved tentative roster block; unpaid breaks excluded from charged hours.',
            v_action.approved_by, md5('quote:' || v_action.id::text)::uuid)
    returning * into v_quote;
    v_index := 0;
    for v_line in select value from jsonb_array_elements(v_payload#>'{quote,lines}') loop
      v_index := v_index + 1;
      insert into public.quote_lines(quote_id, kind, description, quantity, unit_cost, unit_charge, line_order, client_request_id)
      values (v_quote.id, 'labour', left(v_line->>'description', 500), (v_line->>'quantity')::numeric,
              (v_line->>'unit_cost')::numeric, (v_line->>'unit_charge')::numeric, v_index,
              md5('quote-line:' || v_action.id::text || ':' || v_index::text)::uuid);
    end loop;
    update public.quotes q set
      total_cost = t.cost,
      subtotal_charge = t.charge,
      gst_amount = round(t.charge * q.gst_rate, 2),
      total_charge = t.charge + round(t.charge * q.gst_rate, 2)
    from (select coalesce(sum(round(l.quantity * l.unit_cost, 2)), 0) cost, coalesce(sum(round(l.quantity * l.unit_charge, 2)), 0) charge
          from public.quote_lines l where l.quote_id = v_quote.id) t
    where q.id = v_quote.id
    returning q.* into v_quote;
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_action.organization_id, v_action.approved_by, 'bob_tentative_roster_block_applied', 'bob_agentic_actions', v_action.id,
          jsonb_build_object('slots_created', v_created, 'quote_id', v_quote.id));

  return query select v_created, v_quote.id, v_first;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."can_approve_action"(p_user_id uuid, p_action_org_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
BEGIN
  SELECT up.role INTO v_role
  FROM user_profiles up
  WHERE up.id = p_user_id;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- grand_master can approve anything
  IF v_role = 'grand_master' THEN
    RETURN true;
  END IF;

  -- master/admin: check tree-based access
  IF v_role IN ('master', 'admin', 'admin_officer') THEN
    -- Use a direct check mirroring is_admin_for_org but parameterized by user
    RETURN EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = p_user_id
        AND (
          -- master: descendant tree
          (up.role = 'master' AND (
            p_action_org_id = ANY(get_descendant_organizations(up.employer_organization_id))
            OR p_action_org_id = ANY(get_descendant_organizations(up.organization_id))
            -- Agreement-based (0271 Model A)
            OR EXISTS (
              SELECT 1 FROM service_agreements sa
              WHERE (sa.ends_on IS NULL OR sa.ends_on >= current_date)
                AND sa.client_organization_id = p_action_org_id
                AND (up.organization_id = sa.provider_organization_id
                     OR up.employer_organization_id = sa.provider_organization_id)
            )
          ))
          OR
          -- admin: direct org or descendant tree
          (up.role IN ('admin', 'admin_officer') AND (
            up.organization_id = p_action_org_id
            OR p_action_org_id = ANY(get_descendant_organizations(up.organization_id))
            -- Agreement-based (0271 Model A)
            OR EXISTS (
              SELECT 1 FROM service_agreements sa
              WHERE (sa.ends_on IS NULL OR sa.ends_on >= current_date)
                AND sa.client_organization_id = p_action_org_id
                AND (up.organization_id = sa.provider_organization_id
                     OR up.employer_organization_id = sa.provider_organization_id)
            )
          ))
        )
    );
  END IF;

  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."can_manage_r_and_m_identity"()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles actor
    WHERE actor.id = (SELECT auth.uid())
      AND actor.deactivated_at IS NULL
      AND actor.role IN ('admin', 'admin_officer', 'master', 'grand_master')
      AND (
        actor.role = 'grand_master'
        OR actor.organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
        OR actor.organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
        OR actor.employer_organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
      )
  );
$function$;

CREATE OR REPLACE FUNCTION "public"."file_restricted_access_allowed"(p_organization_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS(
    SELECT 1 FROM public.user_profiles actor
    WHERE actor.id=auth.uid() AND actor.deactivated_at IS NULL
      AND actor.role IN('grand_master','master','admin', 'admin_officer')
      AND (
        actor.organization_id=p_organization_id
        OR actor.employer_organization_id=p_organization_id
        OR p_organization_id=ANY(public.get_descendant_organizations(coalesce(actor.employer_organization_id,actor.organization_id)))
      )
  );
$function$;

CREATE OR REPLACE FUNCTION "public"."get_agreement_service_delivery"(p_agreement_id uuid, p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_profile public.user_profiles%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end or p_period_end - p_period_start > 92 then
    raise exception 'Choose a period of up to 92 days';
  end if;
  select * into v_agreement from public.service_agreements a where a.id = p_agreement_id;
  if not found then raise exception 'Service agreement not found'; end if;
  select * into v_profile from public.user_profiles p where p.id = v_actor and p.deactivated_at is null;
  if not found then raise exception 'Active profile required'; end if;

  -- The client sees delivery for its own agreement when the portal is switched on; provider administrators and branch managers always can.
  if not (
    public.is_admin_for_org(v_agreement.provider_organization_id)
    or exists (
      select 1 from public.staff_branch_authorisations a
      where a.user_id = v_actor and a.status = 'active' and a.branch_org_id = v_agreement.provider_organization_id
        and a.role_at_branch in ('branch_manager', 'admin', 'master')
    )
    or (v_profile.organization_id = v_agreement.client_organization_id
        and v_profile.role in ('client_admin', 'client_officer', 'client_viewer', 'master', 'admin', 'admin_officer')
        and v_agreement.client_portal_access_mode in ('transparency_only', 'full_modules'))
  ) then
    raise exception 'Not authorised to view delivery for this agreement';
  end if;

  return public.agreement_service_delivery(p_agreement_id, p_period_start, p_period_end);
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_approvals_activity"(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_statuses text[] DEFAULT NULL::text[], p_action_types text[] DEFAULT NULL::text[])
 RETURNS TABLE(id uuid, action_type text, status text, bob_reasoning text, confidence_score real, context_table text, context_summary text, created_at timestamp with time zone, applied_at timestamp with time zone, approved_at timestamp with time zone, proposed_payload jsonb, amended_payload jsonb, organization_id uuid, org_name text, triggered_by uuid, triggered_by_name text, user_id uuid, user_name text, approved_by uuid, approved_by_name text, rejection_reason text, error_message text, result_table text, result_record_id uuid, assigned_approver_id uuid, assigned_approver_name text, can_decide boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid:=auth.uid();
  v_role text;
  v_org_id uuid;
begin
  if v_user_id is null then return; end if;
  select up.role,up.organization_id into v_role,v_org_id from public.user_profiles up where up.id=v_user_id;
  if v_role is null then return; end if;
  return query
  select a.id,a.action_type,a.status,a.bob_reasoning,a.confidence_score,a.context_table,a.context_summary,a.created_at,a.applied_at,a.approved_at,a.proposed_payload,a.amended_payload,a.organization_id,o.name,
    a.triggered_by,(select up1.display_name from public.user_profiles up1 where up1.id=a.triggered_by),
    a.user_id,(select up2.display_name from public.user_profiles up2 where up2.id=a.user_id),
    a.approved_by,(select up3.display_name from public.user_profiles up3 where up3.id=a.approved_by),
    a.rejection_reason,a.error_message,a.result_table,a.result_record_id,a.assigned_approver_id,
    (select up4.display_name from public.user_profiles up4 where up4.id=a.assigned_approver_id),
    case when a.status not in('pending','pending_approval','proposed') then false when v_role='grand_master' then true when v_role in('master','admin', 'admin_officer') then public.can_approve_action(v_user_id,a.organization_id) else false end
  from public.bob_agentic_actions a left join public.organizations o on o.id=a.organization_id
  where (a.triggered_by=v_user_id or a.user_id=v_user_id or a.assigned_approver_id=v_user_id or v_role='grand_master' or (v_role in('master','admin', 'admin_officer') and public.is_admin_for_org(a.organization_id)))
    and (p_statuses is null or a.status=any(p_statuses)) and (p_action_types is null or a.action_type=any(p_action_types))
  order by case when a.status in('pending','proposed','pending_approval') then 0 else 1 end,a.created_at desc limit p_limit offset p_offset;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_crm_onboarding_assignees"()
 RETURNS TABLE(user_id uuid, display_name text, role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_provider uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  return query select u.id,coalesce(nullif(trim(u.display_name),''),u.email,'Administrator'),u.role from public.user_profiles u
  where u.deactivated_at is null and u.role in('admin', 'admin_officer','master','grand_master') and (u.organization_id=v_provider or u.employer_organization_id=v_provider)
  order by coalesce(nullif(trim(u.display_name),''),u.email,'Administrator');
end;$function$;

CREATE OR REPLACE FUNCTION "public"."get_operating_organization_contexts"()
 RETURNS TABLE(organization_id uuid, organization_name text, authority_basis text, role_at_branch text, module_access text[], can_be_rostered boolean, is_default boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with actor as (
    select organization_id, employer_organization_id, role
    from public.user_profiles
    where id = auth.uid() and deactivated_at is null
  ), candidates as (
    -- The provider organisation itself, for its administrators.
    select
      home.id as organization_id,
      home.name as organization_name,
      'organisation_home'::text as authority_basis,
      null::text as role_at_branch,
      array[]::text[] as module_access,
      false as can_be_rostered,
      0 as authority_rank
    from actor
    join public.organizations home
      on home.id = actor.organization_id
     and home.organization_type in ('owner', 'service_provider')
     and home.active
    where actor.role in ('grand_master', 'master', 'admin', 'admin_officer')

    union all

    select
      branch.id as organization_id,
      branch.name as organization_name,
      'branch_authorisation'::text as authority_basis,
      authorisation.role_at_branch,
      authorisation.module_access,
      authorisation.can_be_rostered,
      1 as authority_rank
    from actor
    join public.staff_branch_authorisations authorisation
      on authorisation.user_id = auth.uid() and authorisation.status = 'active'
    join public.organizations branch
      on branch.id = authorisation.branch_org_id
     and branch.organization_type = 'branch'
     and branch.active

    union all

    select
      branch.id,
      branch.name,
      'corporate_oversight'::text,
      null::text,
      array[]::text[],
      false,
      2
    from actor
    join public.organizations branch
      on branch.organization_type = 'branch'
     and branch.active
     and branch.id = any(public.get_descendant_organizations(coalesce(actor.employer_organization_id, actor.organization_id)))
    where actor.role in ('grand_master', 'master', 'admin', 'admin_officer')
  ), ranked as (
    select distinct on (organization_id)
      organization_id, organization_name, authority_basis, role_at_branch,
      module_access, can_be_rostered
    from candidates
    order by organization_id, authority_rank
  )
  select
    ranked.organization_id,
    ranked.organization_name,
    ranked.authority_basis,
    ranked.role_at_branch,
    ranked.module_access,
    ranked.can_be_rostered,
    ranked.organization_id = actor.organization_id as is_default
  from ranked
  cross join actor
  order by (ranked.organization_id = actor.organization_id) desc, ranked.organization_name;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_payroll_setup_readiness"(p_operating_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_payroll_organization_id uuid;
  v_result jsonb;
BEGIN
  SELECT profile.organization_id
  INTO v_payroll_organization_id
  FROM public.user_profiles profile
  WHERE profile.id = v_actor
    AND profile.deactivated_at IS NULL
    AND profile.role IN ('grand_master', 'master', 'admin', 'admin_officer');

  IF v_payroll_organization_id IS NULL
    OR NOT public.user_can_operate_organization(p_operating_organization_id)
    OR NOT public.is_admin_for_org(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized payroll administrator required';
  END IF;

  SELECT jsonb_build_object(
    'payroll_organization_id', v_payroll_organization_id,
    'operating_organization_id', p_operating_organization_id,
    'active_pay_code_count', (
      SELECT count(*)
      FROM public.reference_codes code
      WHERE code.organization_id = v_payroll_organization_id
        AND code.code_type = 'pay_item'
        AND code.is_active
    ),
    'unassigned_staff_count', (
      SELECT count(*)
      FROM public.staff_profiles staff
      WHERE staff.organization_id = v_payroll_organization_id
        AND staff.end_date IS NULL
        AND staff.role_code IS NULL
    ),
    'rules_without_active_pay_code', (
      SELECT count(*)
      FROM public.rate_rules rule
      WHERE rule.organization_id = p_operating_organization_id
        AND rule.rule_kind = 'pay'
        AND rule.active
        AND NOT EXISTS (
          SELECT 1
          FROM public.reference_codes code
          WHERE code.organization_id = v_payroll_organization_id
            AND code.code_type = 'pay_item'
            AND code.code = rule.pay_code
            AND code.is_active
        )
    ),
    'roles', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'code', role.code,
          'name', role.name,
          'staff_count', (
            SELECT count(*)
            FROM public.staff_profiles staff
            WHERE staff.organization_id = v_payroll_organization_id
              AND staff.end_date IS NULL
              AND staff.role_code = role.code
          ),
          'specific_rule_count', (
            SELECT count(*)
            FROM public.rate_rules rule
            WHERE rule.organization_id = p_operating_organization_id
              AND rule.rule_kind = 'pay'
              AND rule.active
              AND rule.role_code = role.code
          ),
          'fallback_rule_count', (
            SELECT count(*)
            FROM public.rate_rules rule
            WHERE rule.organization_id = p_operating_organization_id
              AND rule.rule_kind = 'pay'
              AND rule.active
              AND rule.role_code IS NULL
          ),
          'status', CASE
            WHEN EXISTS (
              SELECT 1 FROM public.rate_rules rule
              WHERE rule.organization_id = p_operating_organization_id
                AND rule.rule_kind = 'pay'
                AND rule.active
                AND rule.role_code = role.code
            ) THEN 'ready'
            WHEN EXISTS (
              SELECT 1 FROM public.rate_rules rule
              WHERE rule.organization_id = p_operating_organization_id
                AND rule.rule_kind = 'pay'
                AND rule.active
                AND rule.role_code IS NULL
            ) THEN 'fallback'
            ELSE 'missing_rule'
          END
        )
        ORDER BY role.sort_order, role.code
      )
      FROM public.reference_codes role
      WHERE role.organization_id = v_payroll_organization_id
        AND role.code_type = 'role_code'
        AND role.is_active
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_staff_branch_authorisations"(p_user_id uuid)
 RETURNS TABLE(id uuid, branch_organization_id uuid, branch_name text, role_at_branch text, module_access text[], can_be_rostered boolean, status text, starts_on date, ends_on date, authorised_by uuid, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Authenticated user required'; end if;
  if p_user_id <> v_actor and not exists (
    select 1 from public.user_profiles actor
    join public.user_profiles target on target.id = p_user_id
    where actor.id = v_actor
      and actor.deactivated_at is null
      and (actor.role = 'grand_master' or (target.employer_organization_id = coalesce(actor.employer_organization_id, actor.organization_id) and (actor.role in ('master', 'admin', 'admin_officer') or cardinality(public.user_managed_branch_ids()) > 0)))
  ) then
    raise exception 'Not authorised to view this staff member branch access';
  end if;
  return query
    select assignment.id, assignment.branch_org_id, branch.name, assignment.role_at_branch,
      assignment.module_access, assignment.can_be_rostered, assignment.status,
      assignment.starts_on, assignment.ends_on, assignment.authorised_by, assignment.updated_at
  from public.staff_branch_authorisations assignment
  join public.organizations branch on branch.id = assignment.branch_org_id
  where assignment.user_id = p_user_id
    and (p_user_id = v_actor or exists(select 1 from public.user_profiles actor where actor.id = v_actor and actor.role in ('grand_master', 'master', 'admin', 'admin_officer')) or assignment.branch_org_id = any(public.user_managed_branch_ids()))
  order by branch.name;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_vehicle_owner_access"(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_target public.user_profiles%rowtype;
  v_direct public.staff_area_grants%rowtype;
  v_preset_level text;
BEGIN
  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id;
  IF v_target.id IS NULL OR auth.uid() IS NULL
     OR NOT public.is_admin_for_org(v_target.organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required';
  END IF;
  SELECT * INTO v_direct FROM public.staff_area_grants
  WHERE user_id = p_user_id AND scope_org_id = v_target.organization_id
    AND area = 'vehicle_owner_identity' AND status = 'active';
  SELECT max(grant_row.level) INTO v_preset_level
  FROM public.preset_assignments assignment
  JOIN public.access_presets preset ON preset.id = assignment.preset_id
  CROSS JOIN LATERAL jsonb_each_text(preset.grants) AS grant_row(area, level)
  WHERE assignment.user_id = p_user_id AND assignment.status = 'active'
    AND grant_row.area = 'vehicle_owner_identity'
    AND v_target.organization_id = ANY (public.get_descendant_organizations(assignment.scope_org_id));
  RETURN jsonb_build_object(
    'direct', v_direct.id IS NOT NULL,
    'direct_level', v_direct.level,
    'granted_at', v_direct.updated_at,
    'via_preset', v_preset_level IS NOT NULL,
    'via_role', v_target.role IN ('admin', 'admin_officer', 'master', 'grand_master'),
    'organization_id', v_target.organization_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."identity_actor_can_admin"(p_actor_user_id uuid, p_organization_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS(
    SELECT 1 FROM public.user_profiles profile
    WHERE profile.id=p_actor_user_id AND profile.deactivated_at IS NULL
      AND profile.role IN ('grand_master','master','admin', 'admin_officer')
      AND (profile.role='grand_master'
        OR (profile.role='master' AND (p_organization_id=ANY(public.get_descendant_organizations(profile.employer_organization_id))
          OR p_organization_id=ANY(public.get_descendant_organizations(profile.organization_id))
          OR EXISTS(SELECT 1 FROM public.service_agreements agreement WHERE agreement.agreement_type='operational'
            AND (agreement.ends_on IS NULL OR agreement.ends_on>=current_date)
            AND agreement.client_organization_id=p_organization_id
            AND (profile.organization_id=agreement.provider_organization_id OR profile.employer_organization_id=agreement.provider_organization_id))))
        OR (profile.role IN ('admin', 'admin_officer') AND (profile.organization_id=p_organization_id
          OR p_organization_id=ANY(public.get_descendant_organizations(profile.organization_id))
          OR EXISTS(SELECT 1 FROM public.service_agreements agreement WHERE agreement.agreement_type='operational'
            AND (agreement.ends_on IS NULL OR agreement.ends_on>=current_date)
            AND agreement.client_organization_id=p_organization_id
            AND (profile.organization_id=agreement.provider_organization_id OR profile.employer_organization_id=agreement.provider_organization_id)))))
  ) OR EXISTS(
      SELECT 1 FROM public.user_profiles profile
      JOIN public.incidents incident ON incident.officer_user_id=profile.id
      WHERE profile.id=p_actor_user_id AND profile.deactivated_at IS NULL
        AND profile.role IN ('officer','admin_officer') AND incident.organization_id=p_organization_id
        AND incident.status IN ('open','in_review','escalated')
    )
$function$;

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
      and role in ('grand_master', 'master', 'admin', 'admin_officer')
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
        or (role IN ('admin', 'admin_officer') and (
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

CREATE OR REPLACE FUNCTION "public"."is_tenant_import_admin"(p_organization_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles actor
    WHERE actor.id = auth.uid()
      AND actor.deactivated_at IS NULL
      AND actor.role IN ('admin', 'admin_officer', 'master')
      AND (
        actor.organization_id = p_organization_id
        OR actor.employer_organization_id = p_organization_id
        OR p_organization_id = ANY(public.get_descendant_organizations(actor.organization_id))
        OR p_organization_id = ANY(public.get_descendant_organizations(actor.employer_organization_id))
      )
  );
$function$;

CREATE OR REPLACE FUNCTION "public"."manage_crm_onboarding_workflow"(p_account_organization_id uuid, p_expected_version integer, p_stage text, p_target_live_at timestamp with time zone, p_assigned_to uuid, p_note text)
 RETURNS crm_onboarding_ledgers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_ledger public.crm_onboarding_ledgers%rowtype;
  v_previous_stage text;
  v_rank integer;
  v_next_rank integer;
  v_agreement_id uuid;
  v_readiness jsonb;
  v_note text := trim(coalesce(p_note, ''));
BEGIN
  SELECT organization_id INTO v_provider
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;

  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active CRM administrator required';
  END IF;

  SELECT * INTO v_ledger
  FROM public.crm_onboarding_ledgers
  WHERE account_organization_id = p_account_organization_id
    AND provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
  ORDER BY started_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Onboarding ledger not found'; END IF;
  IF v_ledger.version <> p_expected_version THEN RAISE EXCEPTION 'Onboarding ledger changed since it was opened'; END IF;
  IF v_ledger.status = 'activated' THEN RAISE EXCEPTION 'Activated onboarding cannot be changed'; END IF;
  IF char_length(v_note) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Stage note must be between 3 and 1000 characters'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.user_profiles u
    WHERE u.id = p_assigned_to
      AND u.deactivated_at IS NULL
      AND u.role IN ('admin', 'admin_officer','master','grand_master')
      AND (u.organization_id = v_provider OR u.employer_organization_id = v_provider)
  ) THEN RAISE EXCEPTION 'Select an active provider CRM administrator'; END IF;

  v_rank := array_position(ARRAY['qualify','configure','review'], v_ledger.current_stage);
  v_next_rank := array_position(ARRAY['qualify','configure','review'], p_stage);
  IF v_next_rank IS NULL OR v_next_rank < v_rank OR v_next_rank > v_rank + 1 THEN
    RAISE EXCEPTION 'Onboarding stage transition is not allowed';
  END IF;

  IF p_stage = 'review' AND p_stage <> v_ledger.current_stage THEN
    SELECT sa.id INTO v_agreement_id
    FROM public.service_agreements sa
    WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_ledger.provider_organization_id))
      AND sa.client_organization_id = p_account_organization_id
      AND sa.agreement_type = 'operational'
      AND sa.invitation_status = 'accepted'
      AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
    ORDER BY sa.created_at DESC
    LIMIT 1;

    IF v_agreement_id IS NULL THEN RAISE EXCEPTION 'Accepted operational agreement required before review'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.crm_contacts c WHERE c.organization_id = p_account_organization_id AND c.is_primary AND c.deactivated_at IS NULL) THEN
      RAISE EXCEPTION 'Active primary contact required before review';
    END IF;
    v_readiness := public.get_crm_operational_readiness(v_agreement_id);
    IF NOT coalesce((v_readiness->>'ready')::boolean, false) THEN
      RAISE EXCEPTION 'Operational readiness blockers remain before review';
    END IF;
  END IF;

  v_previous_stage := v_ledger.current_stage;
  UPDATE public.crm_onboarding_ledgers
  SET current_stage = p_stage,
      status = CASE WHEN p_stage = v_ledger.current_stage THEN v_ledger.status WHEN p_stage = 'review' THEN 'ready' ELSE 'in_progress' END,
      target_live_at = coalesce(p_target_live_at, target_live_at),
      assigned_to = p_assigned_to,
      stage_note = v_note,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = v_ledger.id
  RETURNING * INTO v_ledger;

  INSERT INTO public.crm_onboarding_events(ledger_id,provider_organization_id,account_organization_id,event_type,from_stage,to_stage,ledger_status,assigned_to,note,actor_user_id,ledger_version)
  VALUES(v_ledger.id,v_ledger.provider_organization_id,p_account_organization_id,'workflow_updated',v_previous_stage,v_ledger.current_stage,v_ledger.status,v_ledger.assigned_to,v_note,v_actor,v_ledger.version);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_ledger.provider_organization_id,v_actor,'crm_onboarding_workflow_updated','crm_onboarding_ledgers',v_ledger.id,jsonb_build_object('account_organization_id',p_account_organization_id,'from_stage',v_previous_stage,'stage',v_ledger.current_stage,'assigned_to',v_ledger.assigned_to,'version',v_ledger.version));
  RETURN v_ledger;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."manage_pay_code"(p_action text, p_pay_code_id uuid DEFAULT NULL::uuid, p_code text DEFAULT NULL::text, p_name text DEFAULT NULL::text)
 RETURNS reference_codes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_organization_id uuid;
  v_code text := upper(nullif(trim(coalesce(p_code, '')), ''));
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_row public.reference_codes%rowtype;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Signed-in payroll administrator required';
  END IF;

  SELECT profile.organization_id
  INTO v_organization_id
  FROM public.user_profiles profile
  WHERE profile.id = v_actor
    AND profile.deactivated_at IS NULL
    AND profile.role IN ('grand_master', 'master', 'admin', 'admin_officer');

  IF v_organization_id IS NULL OR NOT public.is_admin_for_org(v_organization_id) THEN
    RAISE EXCEPTION 'Organisation payroll administrator required';
  END IF;

  IF p_action = 'create' THEN
    IF v_code IS NULL OR v_name IS NULL OR length(v_code) > 32 OR length(v_name) > 120
      OR v_code !~ '^[A-Z0-9][A-Z0-9_-]*$' THEN
      RAISE EXCEPTION 'Enter a pay code using letters, numbers, underscores, or hyphens and a display name';
    END IF;

    INSERT INTO public.reference_codes (
      organization_id, code_type, code, name, is_active, sort_order, created_by, updated_by
    ) VALUES (
      v_organization_id, 'pay_item', v_code, v_name, true,
      coalesce((
        SELECT max(code.sort_order) + 10
        FROM public.reference_codes code
        WHERE code.organization_id = v_organization_id
          AND code.code_type = 'pay_item'
      ), 10),
      v_actor, v_actor
    )
    RETURNING * INTO v_row;

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_organization_id, v_actor, 'pay_code_created', 'reference_codes', v_row.id,
      jsonb_build_object('code', v_row.code, 'name', v_row.name)
    );
    RETURN v_row;
  END IF;

  IF p_action = 'deactivate' THEN
    SELECT *
    INTO v_row
    FROM public.reference_codes code
    WHERE code.id = p_pay_code_id
      AND code.organization_id = v_organization_id
      AND code.code_type = 'pay_item'
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pay code not found in this organisation';
    END IF;
    IF NOT v_row.is_active THEN
      RAISE EXCEPTION 'Pay code is already inactive';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.rate_rules rule
      WHERE rule.organization_id = ANY(public.get_descendant_organizations(v_organization_id))
        AND rule.rule_kind = 'pay'
        AND rule.active
        AND rule.pay_code = v_row.code
    ) THEN
      RAISE EXCEPTION 'Deactivate or move every active pay rule using this pay code first';
    END IF;

    UPDATE public.reference_codes
    SET is_active = false,
        updated_by = v_actor
    WHERE id = v_row.id
    RETURNING * INTO v_row;

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_organization_id, v_actor, 'pay_code_deactivated', 'reference_codes', v_row.id,
      jsonb_build_object('code', v_row.code, 'name', v_row.name)
    );
    RETURN v_row;
  END IF;

  RAISE EXCEPTION 'Unsupported pay-code action';
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."manage_pay_role_code"(p_action text, p_role_code_id uuid DEFAULT NULL::uuid, p_code text DEFAULT NULL::text, p_name text DEFAULT NULL::text)
 RETURNS reference_codes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
	v_actor uuid := auth.uid();
	v_organization_id uuid;
	v_code text := nullif(trim(coalesce(p_code, '')), '');
	v_name text := nullif(trim(coalesce(p_name, '')), '');
	v_row public.reference_codes%rowtype;
BEGIN
	IF v_actor IS NULL THEN
		RAISE EXCEPTION 'Signed-in payroll administrator required';
	END IF;

	SELECT profile.organization_id INTO v_organization_id
	FROM public.user_profiles profile
	WHERE profile.id = v_actor
		AND profile.deactivated_at IS NULL
		AND profile.role IN ('grand_master', 'master', 'admin', 'admin_officer');

	IF v_organization_id IS NULL OR NOT public.is_admin_for_org(v_organization_id) THEN
		RAISE EXCEPTION 'Organisation payroll administrator required';
	END IF;

	IF p_action = 'create' THEN
		IF v_code IS NULL OR v_name IS NULL OR length(v_code) > 32 OR length(v_name) > 120
			OR v_code !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' THEN
			RAISE EXCEPTION 'Enter a code (letters, numbers, underscores or hyphens) and a name';
		END IF;

		INSERT INTO public.reference_codes (
			organization_id, code_type, code, name, is_active, sort_order, created_by, updated_by
		) VALUES (
			v_organization_id, 'role_code', v_code, v_name, true,
			coalesce((SELECT max(code.sort_order) + 10 FROM public.reference_codes code
				WHERE code.organization_id = v_organization_id AND code.code_type = 'role_code'), 10),
			v_actor, v_actor
		) RETURNING * INTO v_row;

		INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
		VALUES (v_organization_id, v_actor, 'pay_role_code_created', 'reference_codes', v_row.id,
			jsonb_build_object('code', v_row.code, 'name', v_row.name));
		RETURN v_row;
	END IF;

	IF p_action = 'deactivate' THEN
		SELECT * INTO v_row
		FROM public.reference_codes code
		WHERE code.id = p_role_code_id
			AND code.organization_id = v_organization_id
			AND code.code_type = 'role_code'
		FOR UPDATE;
		IF NOT FOUND THEN RAISE EXCEPTION 'Payroll role code not found in this organisation'; END IF;
		IF NOT v_row.is_active THEN RAISE EXCEPTION 'Payroll role code is already inactive'; END IF;
		IF EXISTS (
			SELECT 1 FROM public.staff_profiles staff
			WHERE staff.organization_id = v_organization_id AND staff.role_code = v_row.code
		) THEN
			RAISE EXCEPTION 'Remove this payroll role from all staff before deactivating it';
		END IF;

		UPDATE public.reference_codes
		SET is_active = false, updated_by = v_actor
		WHERE id = v_row.id
		RETURNING * INTO v_row;

		INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
		VALUES (v_organization_id, v_actor, 'pay_role_code_deactivated', 'reference_codes', v_row.id,
			jsonb_build_object('code', v_row.code, 'name', v_row.name));
		RETURN v_row;
	END IF;

	RAISE EXCEPTION 'Unsupported payroll role-code action';
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."manage_user_identity_access"(p_user_id uuid, p_expected_updated_at timestamp with time zone, p_action text, p_display_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_preset_id uuid DEFAULT NULL::uuid, p_assignment_id uuid DEFAULT NULL::uuid, p_grant_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor public.user_profiles%rowtype;v_target public.user_profiles%rowtype;v_preset public.access_presets%rowtype;v_assignment public.preset_assignments%rowtype;v_grant public.staff_area_grants%rowtype;v_reason text:=nullif(trim(coalesce(p_reason,'')),'');v_old_identity jsonb;
begin
  select p.* into v_actor from public.user_profiles p where p.id=auth.uid() and p.deactivated_at is null;
  if not found or v_actor.role not in('grand_master','master','admin', 'admin_officer') then raise exception 'Active identity administrator required';end if;
  select p.* into v_target from public.user_profiles p where p.id=p_user_id for update;if not found then raise exception 'User profile not found';end if;
  if v_actor.role<>'grand_master' and v_target.organization_id<>v_actor.organization_id then raise exception 'User is outside your organization';end if;
  if public.identity_role_level(v_target.role)>public.identity_role_level(v_actor.role) then raise exception 'Cannot manage a user above your authority';end if;
  if p_expected_updated_at is not null and v_target.updated_at<>p_expected_updated_at then raise exception 'User identity changed since it was opened';end if;
  if v_reason is null then raise exception 'A change reason is required';end if;

  if p_action='update_identity' then
    if nullif(trim(coalesce(p_display_name,'')),'') is null then raise exception 'Display name is required';end if;
    if p_role not in('grand_master','master','admin','admin_officer','nzscv_monitor','officer','scan_operator','client_admin','client_officer','client_viewer') then raise exception 'Unsupported user role';end if;
    if public.identity_role_level(p_role)>public.identity_role_level(v_actor.role) then raise exception 'Cannot assign a role above your authority';end if;
    if v_target.id=v_actor.id and p_role<>v_target.role then raise exception 'You cannot change your own role';end if;
    v_old_identity:=jsonb_build_object('display_name',v_target.display_name,'phone',v_target.phone,'role',v_target.role);
    update public.user_profiles set display_name=trim(p_display_name),phone=nullif(trim(coalesce(p_phone,'')),''),role=p_role where id=v_target.id returning * into v_target;
    perform public.log_user_management_action(v_target.organization_id,v_target.id,'user_identity_updated',v_actor.id,v_old_identity,jsonb_build_object('display_name',v_target.display_name,'phone',v_target.phone,'role',v_target.role),jsonb_build_object('reason',v_reason));
  elsif p_action='set_preset' then
    if v_target.id=v_actor.id then raise exception 'You cannot change your own access preset';end if;
    if v_target.role not in('grand_master','master','admin','admin_officer') then raise exception 'Access presets apply to administration roles';end if;
    select p.* into v_preset from public.access_presets p where p.id=p_preset_id and (p.organization_id is null or p.organization_id=v_target.organization_id);if not found then raise exception 'Access preset is not available for this organization';end if;
    update public.preset_assignments set status='ended',updated_at=clock_timestamp() where user_id=v_target.id and scope_org_id=v_target.organization_id and status='active';
    insert into public.preset_assignments(user_id,preset_id,scope_org_id,status,assigned_by) values(v_target.id,v_preset.id,v_target.organization_id,'active',v_actor.id)
    on conflict(user_id,preset_id,scope_org_id) do update set status='active',assigned_by=excluded.assigned_by,updated_at=clock_timestamp() returning * into v_assignment;
    perform public.log_user_management_action(v_target.organization_id,v_target.id,'access_preset_assigned',v_actor.id,null,jsonb_build_object('preset_id',v_preset.id,'preset_key',v_preset.key),jsonb_build_object('reason',v_reason));
  elsif p_action='clear_preset' then
    if v_target.id=v_actor.id then raise exception 'You cannot change your own access preset';end if;
    update public.preset_assignments set status='ended',updated_at=clock_timestamp() where id=p_assignment_id and user_id=v_target.id and scope_org_id=v_target.organization_id and status='active' returning * into v_assignment;
    if not found then raise exception 'Active preset assignment not found';end if;
    perform public.log_user_management_action(v_target.organization_id,v_target.id,'access_preset_ended',v_actor.id,jsonb_build_object('assignment_id',v_assignment.id,'preset_id',v_assignment.preset_id),null,jsonb_build_object('reason',v_reason));
  elsif p_action='end_grant' then
    if v_target.id=v_actor.id then raise exception 'You cannot end your own direct access grant';end if;
    update public.staff_area_grants set status='ended',updated_at=clock_timestamp() where id=p_grant_id and user_id=v_target.id and scope_org_id=v_target.organization_id and status='active' returning * into v_grant;
    if not found then raise exception 'Active direct grant not found';end if;
    perform public.log_user_management_action(v_target.organization_id,v_target.id,'direct_access_grant_ended',v_actor.id,jsonb_build_object('grant_id',v_grant.id,'area',v_grant.area,'level',v_grant.level),null,jsonb_build_object('reason',v_reason));
  else raise exception 'Unsupported identity access action';end if;
  return jsonb_build_object('user_id',v_target.id,'display_name',v_target.display_name,'role',v_target.role,'updated_at',v_target.updated_at,'action',p_action,'assignment_id',v_assignment.id,'grant_id',v_grant.id);
end;$function$;

CREATE OR REPLACE FUNCTION "public"."notify_place_hazard_report"()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_reviewer record;
BEGIN
  IF NEW.status = 'reported' AND NEW.origin = 'officer_reported' THEN
    FOR v_reviewer IN
      SELECT p.id FROM public.user_profiles p
      WHERE p.organization_id = NEW.organization_id AND p.deactivated_at IS NULL
        AND p.role IN ('admin', 'admin_officer', 'master', 'grand_master')
    LOOP
      PERFORM public.enqueue_notification(
        p_organization_id => NEW.organization_id, p_category => 'place_hazard_review',
        p_title => 'Reported site hazard needs review',
        p_body => 'An officer reported a hazard. It is visible to officers as not yet reviewed. Confirm, amend or retire it in the place hazard register.',
        p_severity => CASE WHEN NEW.risk_level IN ('high', 'critical') THEN 'warning' ELSE 'info' END,
        p_recipient_user_id => v_reviewer.id, p_link_page => 'sites',
        p_link_payload => jsonb_build_object('site_id', NEW.client_site_id, 'location_id', NEW.location_id, 'hazard_id', NEW.id),
        p_dedup_key => 'place_hazard_review:' || NEW.id::text || ':' || v_reviewer.id::text
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."notify_safety_review"()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_user record;
BEGIN
  FOR v_user IN SELECT id FROM public.user_profiles
    WHERE organization_id = NEW.organization_id AND deactivated_at IS NULL AND role IN ('admin', 'admin_officer', 'master', 'grand_master')
  LOOP
    PERFORM public.enqueue_notification(
      p_organization_id => NEW.organization_id, p_category => 'system',
      p_title => NEW.title,
      p_body => 'Review the source evidence and record corrective action in Field reports / Safety reviews.',
      p_severity => 'warning', p_recipient_user_id => v_user.id, p_link_page => 'safety-reviews',
      p_link_payload => jsonb_build_object('review_id', NEW.id, 'location_id', NEW.location_id),
      p_dedup_key => 'safety_review:' || NEW.id::text || ':' || v_user.id::text
    );
  END LOOP;
  RETURN NEW;
END;
$function$;

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
        and p.role in ('grand_master', 'master', 'admin', 'admin_officer')
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

CREATE OR REPLACE FUNCTION "public"."report_provider_custodian_for_actor"(p_target_organization_id uuid, p_actor_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  select exists (
    select 1
    from public.user_profiles profile
    where profile.id = p_actor_user_id
      and profile.deactivated_at is null
      and profile.role in ('grand_master', 'master', 'admin', 'admin_officer')
      and (
        profile.organization_id = p_target_organization_id
        or p_target_organization_id = any(public.get_descendant_organizations(profile.organization_id))
        or (
          profile.employer_organization_id is not null
          and (
            profile.employer_organization_id = p_target_organization_id
            or p_target_organization_id = any(public.get_descendant_organizations(profile.employer_organization_id))
          )
        )
      )
  );
$function$;

CREATE OR REPLACE FUNCTION "public"."resolve_org_invitation"(p_target_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_target public.organizations%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_scope uuid[];
begin
  select * into v_profile from public.user_profiles where id = v_actor and deactivated_at is null;
  if not found or v_profile.role not in ('grand_master', 'master', 'admin', 'admin_officer') then raise exception 'Not authorised to invite users for this organisation'; end if;
  select * into v_target from public.organizations where id = p_target_organization_id;
  if not found then raise exception 'Organisation not found'; end if;

  -- own organisation: a master seats the first user of their own organisation (bootstrap only; claim_first_org_user refuses a second)
  if v_target.id = v_profile.organization_id and v_profile.role in ('grand_master', 'master') then
    return jsonb_build_object('kind', 'same_org', 'role', 'master', 'agreement_id', null, 'provider_organization_id', v_target.id, 'invitation_status', null);
  end if;

  -- reach: the employing organisation and its branches, plus any branch the actor is authorised at
  v_scope := public.get_descendant_organizations(coalesce(v_profile.employer_organization_id, v_profile.organization_id))
    || coalesce((select array_agg(a.branch_org_id) from public.staff_branch_authorisations a where a.user_id = v_actor and a.status = 'active'), '{}'::uuid[]);

  -- a client of the actor's provider under an operational agreement: the client's first user runs the client portal
  select a.* into v_agreement
  from public.service_agreements a
  where a.client_organization_id = v_target.id
    and a.agreement_type = 'operational'
    and a.provider_organization_id = any(v_scope)
    and (a.ends_on is null or a.ends_on >= current_date)
    and public.is_admin_for_org(a.provider_organization_id)
  order by case a.invitation_status when 'invited' then 0 when 'not_invited' then 1 when 'accepted' then 2 else 3 end, a.created_at desc
  limit 1;
  if found then
    return jsonb_build_object('kind', 'client', 'role', 'client_admin', 'agreement_id', v_agreement.id, 'provider_organization_id', v_agreement.provider_organization_id, 'invitation_status', v_agreement.invitation_status);
  end if;

  -- a platform subscriber under the owner's financial agreement: the subscriber's first master (owner ruling 2026-09-15)
  if v_profile.role = 'grand_master' then
    select a.* into v_agreement
    from public.service_agreements a
    where a.client_organization_id = v_target.id
      and a.agreement_type = 'financial'
      and a.provider_organization_id = any(v_scope)
      and (a.ends_on is null or a.ends_on >= current_date)
    order by a.created_at desc
    limit 1;
    if found then
      return jsonb_build_object('kind', 'subscriber', 'role', 'master', 'agreement_id', v_agreement.id, 'provider_organization_id', v_agreement.provider_organization_id, 'invitation_status', v_agreement.invitation_status);
    end if;
  end if;

  raise exception 'Not authorised to invite users for this organisation';
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."review_leave_request"(p_request_id uuid, p_expected_status text, p_decision text, p_review_notes text DEFAULT NULL::text)
 RETURNS leave_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_leave public.leave_requests%rowtype;v_notes text:=nullif(trim(coalesce(p_review_notes,'')), '');v_officer_user_id uuid;
begin
  select * into v_leave from public.leave_requests where id=p_request_id for update;if not found then raise exception 'Leave request not found';end if;
  if not exists(select 1 from public.user_profiles actor where actor.id=v_actor and actor.deactivated_at is null and actor.role in('grand_master','master','admin', 'admin_officer') and coalesce(actor.employer_organization_id,actor.organization_id)=v_leave.organization_id) then raise exception 'Corporate leave approval required';end if;
  if v_leave.status<>p_expected_status or v_leave.status<>'branch_checked' or p_decision not in('approved','declined') then raise exception 'Only branch-checked leave requests are available for corporate decision';end if;
  if p_decision='approved' and v_leave.branch_reviewed_by=v_actor then raise exception 'A different corporate reviewer must approve this leave request';end if;
  if p_decision='declined' and v_notes is null then raise exception 'Review notes are required to decline leave';end if;
  if p_decision='approved' and exists(select 1 from public.roster_slots slot where slot.staff_id=v_leave.staff_id and slot.status not in('declined','cancelled') and daterange((slot.scheduled_start at time zone 'Pacific/Auckland')::date,(slot.scheduled_end at time zone 'Pacific/Auckland')::date,'[]')&&daterange(v_leave.starts_on,v_leave.ends_on,'[]')) then raise exception 'Active roster slots overlap this leave request';end if;
  update public.leave_requests set status=p_decision,approved_by=v_actor,approved_at=clock_timestamp(),decision_notes=v_notes where id=v_leave.id returning * into v_leave;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_leave.organization_id,v_actor,case when p_decision='approved' then 'leave_corporate_approved' else 'leave_corporate_declined' end,'leave_requests',v_leave.id,jsonb_build_object('staff_id',v_leave.staff_id,'branch_reviewed_organization_id',v_leave.branch_reviewed_organization_id,'review_notes',v_notes));
  select coalesce(staff.user_id,staff.id) into v_officer_user_id from public.staff_profiles staff where staff.id=v_leave.staff_id;
  if v_officer_user_id is not null then perform public.enqueue_notification(p_organization_id=>v_leave.organization_id,p_category=>'leave_decision',p_title=>'Leave request '||v_leave.status,p_body=>coalesce(v_notes,'Your leave request has been '||v_leave.status||'.'),p_severity=>'info',p_recipient_user_id=>v_officer_user_id,p_link_page=>'leave-decision',p_link_payload=>jsonb_build_object('leave_request_id',v_leave.id,'status',v_leave.status),p_dedup_key=>'leave_decision:'||v_leave.id::text||':'||v_leave.status);end if;
  return v_leave;
end;$function$;

CREATE OR REPLACE FUNCTION "public"."staff_branch_authorisation_manager_can_manage"(p_actor_id uuid, p_branch_organization_id uuid, p_target_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.user_profiles actor
    join public.user_profiles target on target.id = p_target_user_id
    where actor.id = p_actor_id
      and actor.deactivated_at is null
      and target.employer_organization_id is not null
      and (
        actor.role = 'grand_master'
        or (
          target.employer_organization_id = coalesce(actor.employer_organization_id, actor.organization_id)
          and p_branch_organization_id = any(public.get_descendant_organizations(coalesce(actor.employer_organization_id, actor.organization_id)))
          and (actor.role in ('master', 'admin', 'admin_officer') or p_branch_organization_id = any(public.user_managed_branch_ids()))
        )
      )
  );
$function$;

CREATE OR REPLACE FUNCTION "public"."sweep_place_hazard_reviews"(p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_h record; v_user record; v_count integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sweep_place_hazard_reviews'));
  FOR v_h IN SELECT * FROM public.place_hazards
    WHERE status <> 'retired' AND review_due <= (now() AT TIME ZONE 'Pacific/Auckland')::date
      AND (p_organization_id IS NULL OR organization_id = p_organization_id)
  LOOP
    FOR v_user IN SELECT id FROM public.user_profiles WHERE organization_id = v_h.organization_id
      AND deactivated_at IS NULL AND (id = v_h.risk_owner_id OR role IN ('admin', 'admin_officer', 'master', 'grand_master'))
    LOOP
      PERFORM public.enqueue_notification(
        p_organization_id => v_h.organization_id, p_category => 'place_hazard_review',
        p_title => 'Place hazard review is due', p_body => 'Review the hazard, controls and owner; record findings and the next review date.',
        p_severity => 'warning', p_recipient_user_id => v_user.id, p_link_page => 'sites',
        p_link_payload => jsonb_build_object('site_id', v_h.client_site_id, 'location_id', v_h.location_id, 'hazard_id', v_h.id),
        p_dedup_key => 'hazard_due:' || v_h.id::text || ':' || v_h.review_due::text || ':' || v_user.id::text
      );
      v_count := v_count + 1;
    END LOOP;
  END LOOP;
  RETURN v_count;
END;
$function$;

-- Role-addressed notifications sent to 'admin' reach an admin_officer as well.
ALTER POLICY "notifications_select" ON "public"."notifications"
  USING (
    org_access_allowed(organization_id)
    AND (
      recipient_user_id = auth.uid()
      OR (
        recipient_user_id IS NULL
        AND (
          recipient_role = current_user_role()
          OR (recipient_role = 'admin' AND current_user_role() = 'admin_officer')
        )
      )
    )
  );

ALTER POLICY "notifications_update" ON "public"."notifications"
  USING (
    org_access_allowed(organization_id)
    AND (
      recipient_user_id = auth.uid()
      OR (
        recipient_user_id IS NULL
        AND (
          recipient_role = current_user_role()
          OR (recipient_role = 'admin' AND current_user_role() = 'admin_officer')
        )
      )
    )
  )
  WITH CHECK (
    org_access_allowed(organization_id)
    AND (
      recipient_user_id = auth.uid()
      OR (
        recipient_user_id IS NULL
        AND (
          recipient_role = current_user_role()
          OR (recipient_role = 'admin' AND current_user_role() = 'admin_officer')
        )
      )
    )
  );