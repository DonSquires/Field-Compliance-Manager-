-- Latent RPC defects of one class, plus people management for a subscriber's own organisation.
--
-- A rolled-back live probe (2026-09-15) showed that create_dispatch_job, queue_dispatch_job_for_officer
-- and get_manageable_user_identities fail on first real use with 'column reference "id" is ambiguous':
-- their RETURNS TABLE columns (id, status, ...) collide with unqualified column references in their
-- own bodies. The same defect had already stopped advance_dispatch_job_status (fixed in 20260915140000).
-- add_crm_invoice_line (invoice_id) and apply_bob_roster_fill_plan (plan_id) carry the identical pattern
-- and are fixed the same way. Bodies are verbatim from the live catalog; only the colliding references
-- are table-qualified.
--
-- get_manageable_user_identities also accepted only a branch, so a subscriber operating its own
-- organisation (Model A own-rooted service_provider) could never list or manage its people. It now
-- returns the organisation's own people (home or employer) to its administrators, and keeps the
-- branch-authorisation path for branches.

CREATE OR REPLACE FUNCTION "public"."create_dispatch_job"(p_organization_id uuid, p_service_agreement_id uuid, p_client_site_id uuid, p_client_request_id uuid, p_job_type text, p_priority text, p_sla_minutes integer, p_dispatch_resource_id uuid DEFAULT NULL::uuid, p_briefing_notes text DEFAULT NULL::text, p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, created boolean, status text, sla_respond_by timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existing public.dispatch_jobs%rowtype;
  v_created public.dispatch_jobs%rowtype;
  v_resource public.dispatch_resources%rowtype;
  v_shift public.shifts%rowtype;
begin
  if not public.is_admin_for_org(p_organization_id) then
    raise exception 'Not authorised to create dispatch jobs for this organisation';
  end if;

  if p_sla_minutes is null or p_sla_minutes < 1 or p_sla_minutes > 1440 then
    raise exception 'SLA minutes must be between 1 and 1440';
  end if;

  if not exists (
    select 1
    from public.service_agreements sa
    join public.service_agreement_locations sal on sal.service_agreement_id = sa.id
    join public.client_sites cs on cs.id = sal.site_id
    where sa.id = p_service_agreement_id
      and sa.provider_organization_id = p_organization_id
      and sal.site_id = p_client_site_id
      and sal.status = 'active'
      and cs.active = true
  ) then
    raise exception 'Site is not active under this service agreement';
  end if;

  select * into v_existing
  from public.dispatch_jobs
  where organization_id = p_organization_id
    and client_request_id = p_client_request_id;

  if found then
    return query select v_existing.id, false, v_existing.status, v_existing.sla_respond_by;
    return;
  end if;

  if p_dispatch_resource_id is not null then
    if p_shift_id is null then
      raise exception 'A shift is required when dispatching to a resource';
    end if;

    select * into v_resource
    from public.dispatch_resources
    where dispatch_resources.id = p_dispatch_resource_id
      and dispatch_resources.organization_id = p_organization_id
    for update;

    if not found or v_resource.status <> 'available' or v_resource.assigned_officer_id is null then
      raise exception 'Dispatch resource is not available with an assigned officer';
    end if;

    select * into v_shift
    from public.shifts
    where shifts.id = p_shift_id
      and shifts.organization_id = p_organization_id
      and shifts.status in ('accepted', 'in_progress')
    for share;

    if not found or v_shift.officer_user_id <> v_resource.assigned_officer_id then
      raise exception 'Shift officer does not match the selected dispatch resource';
    end if;
  elsif p_shift_id is not null then
    if not exists (
      select 1 from public.shifts
      where shifts.id = p_shift_id
        and shifts.organization_id = p_organization_id
        and shifts.status in ('accepted', 'in_progress')
    ) then
      raise exception 'Shift is not active in this organisation';
    end if;
  end if;

  begin
    insert into public.dispatch_jobs (
      organization_id, service_agreement_id, client_site_id, client_request_id,
      dispatch_resource_id, job_type, priority, status, sla_minutes,
      sla_respond_by, briefing_notes, shift_id, dispatched_at
    ) values (
      p_organization_id, p_service_agreement_id, p_client_site_id, p_client_request_id,
      p_dispatch_resource_id, p_job_type, p_priority,
      case when p_dispatch_resource_id is null then 'pending' else 'dispatched' end,
      p_sla_minutes, now() + make_interval(mins => p_sla_minutes),
      nullif(trim(p_briefing_notes), ''), p_shift_id,
      case when p_dispatch_resource_id is null then null else now() end
    ) returning * into v_created;

    if p_dispatch_resource_id is not null then
      update public.dispatch_resources
      set status = 'busy'
      where dispatch_resources.id = p_dispatch_resource_id;
    end if;
  exception when unique_violation then
    select * into v_created
    from public.dispatch_jobs
    where organization_id = p_organization_id
      and client_request_id = p_client_request_id;
    return query select v_created.id, false, v_created.status, v_created.sla_respond_by;
    return;
  end;

  return query select v_created.id, true, v_created.status, v_created.sla_respond_by;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."queue_dispatch_job_for_officer"(p_organization_id uuid, p_service_agreement_id uuid, p_client_site_id uuid, p_client_request_id uuid, p_officer_user_id uuid, p_work_unit_id uuid, p_module_key text, p_job_type text, p_priority text, p_sla_minutes integer, p_briefing_notes text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, created boolean, status text, assigned_officer_id uuid, work_unit_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_actor uuid := auth.uid(); v_job record; v_unit public.roster_work_units%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Active organization administrator required'; END IF;
  SELECT * INTO v_unit FROM public.roster_work_units WHERE roster_work_units.id=p_work_unit_id AND roster_work_units.organization_id=p_organization_id AND roster_work_units.active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active work unit is required'; END IF;
  IF v_unit.service_type IS DISTINCT FROM p_module_key THEN RAISE EXCEPTION 'Work unit module does not match requested module'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles u
    JOIN public.service_agreements sa ON sa.id=p_service_agreement_id
    JOIN public.organizations officer_org ON officer_org.id=u.organization_id
    WHERE u.id=p_officer_user_id AND u.deactivated_at IS NULL AND u.role IN ('officer','admin_officer')
      AND (officer_org.id=sa.provider_organization_id OR sa.provider_organization_id=ANY(public.get_descendant_organizations(officer_org.id)))
  ) THEN RAISE EXCEPTION 'Target officer is not authorized for this service agreement'; END IF;
  SELECT * INTO v_job FROM public.create_dispatch_job(p_organization_id,p_service_agreement_id,p_client_site_id,p_client_request_id,p_job_type,p_priority,p_sla_minutes,NULL,p_briefing_notes,NULL);
  UPDATE public.dispatch_jobs AS job
    SET assigned_officer_id=p_officer_user_id, work_unit_id=p_work_unit_id, module_key=p_module_key
    WHERE job.id=v_job.id;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(p_organization_id,v_actor,'dispatch_job_queued_for_officer','dispatch_jobs',v_job.id,jsonb_build_object('officer_user_id',p_officer_user_id,'work_unit_id',p_work_unit_id,'module_key',p_module_key,'roster_independent',true));
  RETURN QUERY SELECT v_job.id,v_job.created,v_job.status,p_officer_user_id,p_work_unit_id;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."add_crm_invoice_line"(p_client_request_id uuid, p_invoice_id uuid, p_description text, p_quantity numeric, p_unit_price numeric)
 RETURNS TABLE(line_id uuid, invoice_id uuid, subtotal numeric, gst_amount numeric, total_amount numeric, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_invoice public.invoices%rowtype;
  v_line public.invoice_line_items%rowtype;
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_next_seq integer;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select i.* into v_invoice from public.invoices i where i.id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice not found';
  end if;

  if not public.is_admin_for_org(v_invoice.organization_id) then
    raise exception 'Not authorised to manage invoices for this organization';
  end if;

  if v_invoice.status <> 'draft' then
    raise exception 'Only draft invoices can be updated';
  end if;

  if v_description is null then
    raise exception 'Line description is required';
  end if;

  if p_quantity is null or p_quantity <= 0 or p_unit_price is null or p_unit_price < 0 then
    raise exception 'Invoice line quantity and price must be positive numbers';
  end if;

  select coalesce(max(line_number), 0) + 1 into v_next_seq
  from public.invoice_line_items where invoice_line_items.invoice_id = v_invoice.id;

  insert into public.invoice_line_items (
    invoice_id, line_number, description, quantity, unit_price, line_total, organization_id
  )
  values (
    v_invoice.id, v_next_seq, v_description, p_quantity, p_unit_price, round(p_quantity * p_unit_price, 2), v_invoice.organization_id
  )
  returning * into v_line;

  update public.invoices i set
    subtotal = totals.subtotal,
    gst_amount = round(totals.subtotal * 0.15, 2),
    total_amount = round(totals.subtotal * 1.15, 2),
    updated_at = now()
  from (
    select coalesce(sum(l.line_total), 0)::numeric(12,2) subtotal
    from public.invoice_line_items l
    where l.invoice_id = v_invoice.id
  ) totals
  where i.id = v_invoice.id
  returning i.* into v_invoice;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_invoice.organization_id,
    v_actor,
    'crm_invoice_line_added',
    'invoice_line_items',
    v_line.id,
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'description', v_description,
      'quantity', p_quantity,
      'unit_price', p_unit_price,
      'line_total', v_line.line_total,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_line.id, v_invoice.id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, true;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."apply_bob_roster_fill_plan"(p_action_id uuid)
 RETURNS TABLE(plan_id uuid, assignments_applied integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action public.bob_agentic_actions%rowtype;
  v_payload jsonb;
  v_plan public.bob_roster_plans%rowtype;
  v_item jsonb;
  v_slot public.roster_slots%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_count integer := 0;
  v_actor uuid;
begin
  select a.* into v_action from public.bob_agentic_actions a where a.id = p_action_id for update;
  if not found then raise exception 'Bob action not found'; end if;
  if v_action.action_type <> 'apply_roster_fill_plan' or v_action.status <> 'approved' then
    raise exception 'Only approved apply_roster_fill_plan actions can be executed';
  end if;

  select p.* into v_plan from public.bob_roster_plans p where p.action_id = v_action.id;
  if found then
    return query select v_plan.id, (select count(*)::integer from public.bob_roster_plan_slots where bob_roster_plan_slots.plan_id = v_plan.id);
    return;
  end if;

  v_payload := coalesce(v_action.amended_payload, v_action.proposed_payload);
  if jsonb_typeof(v_payload->'assignments') <> 'array' or jsonb_array_length(v_payload->'assignments') = 0 then
    raise exception 'Roster plan requires at least one assignment';
  end if;

  v_actor := v_action.approved_by;
  insert into public.bob_roster_plans(organization_id, action_id, period_start, period_end, applied_by)
  values (
    v_action.organization_id, v_action.id,
    (v_payload->>'period_start')::timestamptz,
    (v_payload->>'period_end')::timestamptz,
    v_actor
  ) returning * into v_plan;

  for v_item in select value from jsonb_array_elements(v_payload->'assignments') loop
    select s.* into v_slot from public.roster_slots s where s.id = (v_item->>'roster_slot_id')::uuid for update;
    if not found or v_slot.organization_id <> v_action.organization_id then
      raise exception 'Proposed roster slot is unavailable';
    end if;
    if v_slot.status <> 'draft' or v_slot.staff_id is not null then
      raise exception 'Roster slot % changed after Bob proposed it; revise the plan', v_slot.id;
    end if;

    select sp.* into v_staff from public.staff_profiles sp where sp.id = (v_item->>'staff_id')::uuid;
    if not found or v_staff.organization_id <> v_action.organization_id or not v_staff.work_ready then
      raise exception 'Proposed staff member is unavailable';
    end if;
    if public.staff_has_roster_availability_conflict(v_staff.id, v_slot.scheduled_start, v_slot.scheduled_end)
      or public.staff_fatigue_conflict(v_staff.id, v_slot.scheduled_start, v_slot.scheduled_end, v_slot.id) is not null then
      raise exception 'Proposed staff member no longer meets availability or fatigue requirements';
    end if;

    update public.roster_slots set staff_id = v_staff.id where id = v_slot.id;
    insert into public.bob_roster_plan_slots(plan_id, roster_slot_id, staff_id, score, rationale)
    values (v_plan.id, v_slot.id, v_staff.id, coalesce((v_item->>'score')::numeric, 0), coalesce(nullif(trim(v_item->>'rationale'), ''), 'Bob roster proposal'));
    v_count := v_count + 1;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_action.organization_id, v_actor, 'bob_roster_plan_applied', 'bob_roster_plans', v_plan.id,
    jsonb_build_object('action_id', v_action.id, 'assignments_applied', v_count));

  return query select v_plan.id, v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_manageable_user_identities"(p_operating_organization_id uuid)
 RETURNS TABLE(id uuid, display_name text, role text, email text, phone text, module_access text[], deactivated_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org public.organizations%rowtype;
begin
  if v_actor is null or not public.user_can_operate_organization(p_operating_organization_id) then
    raise exception 'Active authorized operating organisation required';
  end if;
  select * into v_org from public.organizations o where o.id = p_operating_organization_id and o.organization_type in ('owner', 'service_provider', 'branch') and o.active;
  if not found then raise exception 'Active operating organisation required'; end if;

  if v_org.organization_type = 'branch' then
    return query
    select user_profile.id, user_profile.display_name, user_profile.role, user_profile.email, user_profile.phone,
      user_profile.module_access, user_profile.deactivated_at, user_profile.updated_at
    from public.staff_branch_authorisations assignment
    join public.user_profiles user_profile on user_profile.id = assignment.user_id
    where assignment.branch_org_id = v_org.id
      and public.staff_branch_authorisation_manager_can_manage(v_actor, v_org.id, user_profile.id)
    order by user_profile.display_name nulls last, user_profile.email;
  else
    -- The organisation itself: its own people (home or employer), for its administrators.
    if not public.is_admin_for_org(v_org.id) then raise exception 'Organisation administrator required'; end if;
    return query
    select user_profile.id, user_profile.display_name, user_profile.role, user_profile.email, user_profile.phone,
      user_profile.module_access, user_profile.deactivated_at, user_profile.updated_at
    from public.user_profiles user_profile
    where (user_profile.organization_id = v_org.id or user_profile.employer_organization_id = v_org.id)
      and user_profile.role <> 'grand_master'
    order by user_profile.display_name nulls last, user_profile.email;
  end if;
end;
$function$;
