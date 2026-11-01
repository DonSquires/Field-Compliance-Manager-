-- Manufacturing and maintenance roster labour follows a real Workshop work order.
-- The order owns client/place/asset, job execution, stock and invoicing; roster time
-- is payroll planning only, never a second client charge or a fabricated patrol.
ALTER TABLE public.workshop_work_orders
  ADD CONSTRAINT workshop_work_orders_org_id_key UNIQUE (organization_id, id);
ALTER TABLE public.roster_work_units
  ADD COLUMN workshop_work_order_id uuid,
  ADD CONSTRAINT roster_work_units_workshop_order_fkey
    FOREIGN KEY (organization_id, workshop_work_order_id)
    REFERENCES public.workshop_work_orders (organization_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX roster_work_units_workshop_order_key
  ON public.roster_work_units (organization_id, workshop_work_order_id)
  WHERE workshop_work_order_id IS NOT NULL;
ALTER TABLE public.roster_work_units DROP CONSTRAINT roster_work_units_type_check;
ALTER TABLE public.roster_work_units ADD CONSTRAINT roster_work_units_type_check
  CHECK (work_unit_type IN ('patrol', 'static', 'internal', 'workshop'));
ALTER TABLE public.roster_work_units DROP CONSTRAINT roster_work_units_exact_target_check;
ALTER TABLE public.roster_work_units ADD CONSTRAINT roster_work_units_exact_target_check CHECK (
  (work_unit_type = 'patrol' AND patrol_route_id IS NOT NULL
    AND service_agreement_location_id IS NULL AND service_agreement_module_id IS NULL
    AND workplace_id IS NULL AND team_id IS NULL AND cost_centre_id IS NULL
    AND workshop_work_order_id IS NULL)
  OR (work_unit_type = 'static' AND patrol_route_id IS NULL
    AND service_agreement_location_id IS NOT NULL AND service_agreement_module_id IS NOT NULL
    AND workplace_id IS NULL AND team_id IS NULL AND cost_centre_id IS NULL
    AND workshop_work_order_id IS NULL)
  OR (work_unit_type = 'internal' AND patrol_route_id IS NULL
    AND service_agreement_location_id IS NULL AND service_agreement_module_id IS NULL
    AND workplace_id IS NOT NULL AND workshop_work_order_id IS NULL)
  OR (work_unit_type = 'workshop' AND patrol_route_id IS NULL
    AND service_agreement_location_id IS NULL AND service_agreement_module_id IS NULL
    AND workplace_id IS NOT NULL AND workshop_work_order_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION public.create_operating_workshop_roster_work_unit(
  p_operating_organization_id uuid,
  p_name text,
  p_work_order_id uuid,
  p_workplace_id uuid,
  p_team_id uuid DEFAULT NULL,
  p_cost_centre_id uuid DEFAULT NULL
) RETURNS public.roster_work_units
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_order public.workshop_work_orders%rowtype;
  v_unit public.roster_work_units%rowtype;
BEGIN
  IF v_actor IS NULL
    OR NOT public.user_can_operate_organization(p_operating_organization_id)
    OR NOT public.is_admin_for_org(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized operating branch administrator required';
  END IF;
  IF nullif(trim(p_name), '') IS NULL THEN RAISE EXCEPTION 'Work unit name is required'; END IF;
  SELECT * INTO v_order FROM public.workshop_work_orders
    WHERE id = p_work_order_id AND organization_id = p_operating_organization_id FOR UPDATE;
  IF NOT FOUND OR v_order.status NOT IN ('draft', 'approved', 'in_progress') THEN
    RAISE EXCEPTION 'Open work order in this operating branch required';
  END IF;
  IF v_order.client_organization_id IS NULL THEN
    RAISE EXCEPTION 'Manufacturing and maintenance work must be assigned to a client. Set the client on the work order first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_workplaces
    WHERE id = p_workplace_id AND organization_id = p_operating_organization_id AND active) THEN
    RAISE EXCEPTION 'Active provider workplace required';
  END IF;
  IF p_team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.teams
    WHERE id = p_team_id AND organization_id = p_operating_organization_id AND status = 'active') THEN
    RAISE EXCEPTION 'Active team in this operating branch required';
  END IF;
  IF p_cost_centre_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cost_centres
    WHERE id = p_cost_centre_id AND organization_id = p_operating_organization_id AND active) THEN
    RAISE EXCEPTION 'Active cost centre in this operating branch required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.roster_work_units WHERE workshop_work_order_id = v_order.id
    AND organization_id = p_operating_organization_id) THEN
    RAISE EXCEPTION 'This work order already has a roster work unit. Roster additional staff against that unit.';
  END IF;
  INSERT INTO public.roster_work_units (
    organization_id, name, work_unit_type, service_type, workshop_work_order_id,
    workplace_id, team_id, cost_centre_id, created_by
  ) VALUES (
    p_operating_organization_id, trim(p_name), 'workshop', v_order.kind, v_order.id,
    p_workplace_id, p_team_id, p_cost_centre_id, v_actor
  ) RETURNING * INTO v_unit;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_operating_organization_id, v_actor, 'roster_work_unit_created', 'roster_work_units', v_unit.id,
    jsonb_build_object('work_unit_type', 'workshop', 'service_type', v_order.kind,
      'workshop_work_order_id', v_order.id, 'operating_organization_id', p_operating_organization_id));
  RETURN v_unit;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_operating_workshop_roster_work_unit(uuid,text,uuid,uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_operating_workshop_roster_work_unit(uuid,text,uuid,uuid,uuid,uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_workshop_roster_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_unit public.roster_work_units%rowtype;
BEGIN
  SELECT * INTO v_unit FROM public.roster_work_units WHERE id = NEW.work_unit_id;
  IF v_unit.work_unit_type = 'workshop' AND NEW.status NOT IN ('cancelled', 'declined', 'completed') THEN
    IF NEW.linked_shift_id IS NOT NULL THEN RAISE EXCEPTION 'Workshop work runs through its work order, not a patrol shift'; END IF;
    PERFORM 1 FROM public.workshop_work_orders
      WHERE id = v_unit.workshop_work_order_id AND organization_id = NEW.organization_id
        AND status IN ('approved', 'in_progress') FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Approve an open Workshop work order before rostering its labour'; END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_workshop_roster_order() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER enforce_workshop_roster_order
  BEFORE INSERT OR UPDATE ON public.roster_slots
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workshop_roster_order();

-- Existing lifecycle definitions, retaining their authorization and audit paths.
CREATE OR REPLACE FUNCTION "public"."batch_publish_roster_slots"(p_client_request_id uuid, p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(published_count integer, materialized_count integer, conflict_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid := auth.uid(); v_provider uuid; v_slot record; v_unit public.roster_work_units%rowtype; v_pub integer := 0; v_mat integer := 0; v_conf integer := 0; v_res record; v_error text;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select actor.organization_id into v_provider from public.user_profiles actor where actor.id = v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active roster administrator required'; end if;
  if p_organization_id <> v_provider then raise exception 'Organization is outside your managed account hierarchy'; end if;
  for v_slot in (select s.* from public.roster_slots s where s.organization_id = v_provider and s.status = 'draft' and s.scheduled_start >= p_from and s.scheduled_start < p_to for update) loop
    if v_slot.staff_id is not null and exists (select 1 from public.leave_requests l where l.staff_id = v_slot.staff_id and l.status = 'approved' and daterange(l.starts_on, l.ends_on, '[]') && daterange(v_slot.scheduled_start::date, v_slot.scheduled_end::date, '[]')) then v_conf := v_conf + 1; continue; end if;
    update public.roster_slots set status = 'published', updated_at = now() where id = v_slot.id; v_pub := v_pub + 1;
    select wu.* into v_unit from public.roster_work_units wu where wu.id = v_slot.work_unit_id;
    if found and v_unit.work_unit_type in ('patrol', 'static') then
      begin select * into v_res from public.materialize_roster_slot(v_slot.id, 'published'); v_mat := v_mat + 1;
      exception when others then
        get stacked diagnostics v_error = message_text;
        insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_provider, v_actor, 'roster_batch_publish_materialization_failed', 'roster_slots', v_slot.id, jsonb_build_object('client_request_id', p_client_request_id, 'error', v_error, 'work_unit_id', v_slot.work_unit_id));
      end;
    end if;
  end loop;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_provider, v_actor, 'roster_period_batch_published', 'roster_slots', v_provider, jsonb_build_object('from', p_from, 'to', p_to, 'published_count', v_pub, 'materialized_count', v_mat, 'conflict_count', v_conf, 'client_request_id', p_client_request_id));
  return query select v_pub, v_mat, v_conf;
end;
$function$;
REVOKE ALL ON FUNCTION "public"."batch_publish_roster_slots"(p_client_request_id uuid, p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."batch_publish_roster_slots"(p_client_request_id uuid, p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."batch_publish_roster_slots"(p_client_request_id uuid, p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."batch_publish_roster_slots"(p_client_request_id uuid, p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "anon";
GRANT EXECUTE ON FUNCTION "public"."batch_publish_roster_slots"(p_client_request_id uuid, p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."batch_publish_roster_slots"(p_client_request_id uuid, p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."finalize_shift_coverage"(p_request_id uuid, p_expected_status text, p_work_unit_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(request_id uuid, request_status text, roster_slot_id uuid, shift_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_request public.shift_coverage_requests%rowtype;v_staff public.staff_profiles%rowtype;v_unit public.roster_work_units%rowtype;v_slot public.roster_slots%rowtype;v_materialized record;v_shift_id uuid;v_start timestamptz;v_end timestamptz;
begin
  select r.* into v_request from public.shift_coverage_requests r where r.id=p_request_id for update;if not found then raise exception 'Coverage request not found';end if;
  if not public.is_admin_for_org(v_request.organization_id) then raise exception 'Active roster administrator required';end if;
  if v_request.status<>p_expected_status then raise exception 'Coverage request changed from expected status % to %',p_expected_status,v_request.status;end if;
  if v_request.status<>'claimed' or v_request.claimed_by is null then raise exception 'Only claimed coverage can be finalized';end if;
  select sp.* into v_staff from public.staff_profiles sp where sp.organization_id=v_request.organization_id and (sp.user_id=v_request.claimed_by or sp.id=v_request.claimed_by);if not found then raise exception 'Claimant staff profile not found';end if;
  select u.* into v_unit from public.roster_work_units u where u.id=p_work_unit_id and u.organization_id=v_request.organization_id and u.active;if not found then raise exception 'Active work unit in this organization required';end if;
  if v_request.patrol_route_id is not null and v_unit.patrol_route_id is distinct from v_request.patrol_route_id then raise exception 'Work unit does not match requested patrol route';end if;
  v_start:=(v_request.shift_date+v_request.start_time) at time zone 'Pacific/Auckland';v_end:=(v_request.shift_date+v_request.end_time) at time zone 'Pacific/Auckland';if v_end<=v_start then v_end:=v_end+interval '1 day';end if;
  select * into v_slot from public.create_roster_slot(v_request.id,v_unit.id,v_staff.id,v_start,v_end,true,concat_ws(E'\n',nullif(trim(coalesce(v_request.notes,'')),''),nullif(trim(coalesce(p_notes,'')),'')));
  if v_unit.work_unit_type in ('patrol', 'static') then select * into v_materialized from public.materialize_roster_slot(v_slot.id,'published');v_shift_id:=v_materialized.shift_id;end if;
  update public.shift_coverage_requests set status='filled',filled_at=clock_timestamp(),roster_slot_id=v_slot.id where id=v_request.id returning * into v_request;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_request.organization_id,v_actor,'shift_coverage_finalized','shift_coverage_requests',v_request.id,jsonb_build_object('claimed_by',v_request.claimed_by,'work_unit_id',v_unit.id,'roster_slot_id',v_slot.id,'shift_id',v_shift_id));
  perform public.enqueue_notification(p_organization_id=>v_request.organization_id,p_category=>'roster',p_title=>'Coverage assignment confirmed',p_body=>'Your claimed coverage is now a confirmed roster assignment.',p_severity=>'info',p_recipient_user_id=>v_request.claimed_by,p_link_page=>'schedule',p_link_payload=>jsonb_build_object('roster_slot_id',v_slot.id,'shift_id',v_shift_id),p_dedup_key=>'coverage_finalized:'||v_request.id::text);
  return query select v_request.id,v_request.status,v_slot.id,v_shift_id;
end;$function$;
REVOKE ALL ON FUNCTION "public"."finalize_shift_coverage"(p_request_id uuid, p_expected_status text, p_work_unit_id uuid, p_notes text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."finalize_shift_coverage"(p_request_id uuid, p_expected_status text, p_work_unit_id uuid, p_notes text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."finalize_shift_coverage"(p_request_id uuid, p_expected_status text, p_work_unit_id uuid, p_notes text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."finalize_shift_coverage"(p_request_id uuid, p_expected_status text, p_work_unit_id uuid, p_notes text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."preview_batch_publish_roster_slots"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(draft_count integer, leave_conflict_count integer, unassigned_count integer, field_shift_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Active roster administrator required'; end if;
  return query
  select count(*)::integer,
    count(*) filter (where s.staff_id is not null and exists (select 1 from public.leave_requests l where l.staff_id = s.staff_id and l.status = 'approved' and daterange(l.starts_on, l.ends_on, '[]') && daterange(s.scheduled_start::date, s.scheduled_end::date, '[]')))::integer,
    count(*) filter (where s.staff_id is null)::integer,
    count(*) filter (where wu.work_unit_type in ('patrol', 'static'))::integer
  from public.roster_slots s
  join public.roster_work_units wu on wu.id = s.work_unit_id
  where s.organization_id = p_organization_id and s.status = 'draft' and s.scheduled_start >= p_from and s.scheduled_start < p_to;
end;
$function$;
REVOKE ALL ON FUNCTION "public"."preview_batch_publish_roster_slots"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."preview_batch_publish_roster_slots"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."preview_batch_publish_roster_slots"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."preview_batch_publish_roster_slots"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."reassign_roster_slot"(p_slot_id uuid, p_expected_status text, p_new_staff_id uuid, p_reason text)
 RETURNS TABLE(slot_id uuid, slot_status text, staff_id uuid, shift_id uuid, shift_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_old_staff_id uuid;
  v_new_status text;
  v_materialized record;
begin
  select s.* into v_slot
  from public.roster_slots s
  where s.id = p_slot_id
  for update;
  if not found then
    raise exception 'Roster slot not found';
  end if;
  if not public.is_admin_for_org(v_slot.organization_id) then
    raise exception 'Not authorised to reassign this roster slot';
  end if;
  if v_slot.status <> p_expected_status then
    raise exception 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status;
  end if;
  if v_slot.status not in ('draft', 'published', 'accepted', 'declined') then
    raise exception 'This roster slot can no longer be reassigned';
  end if;
  if p_new_staff_id = v_slot.staff_id then
    raise exception 'Select a different staff member';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Reassignment reason is required';
  end if;

  select u.* into v_unit
  from public.roster_work_units u
  where u.id = v_slot.work_unit_id
    and u.organization_id = v_slot.organization_id
    and u.active;
  if not found then
    raise exception 'Active work unit not found';
  end if;

  select sp.* into v_staff
  from public.staff_profiles sp
  where sp.id = p_new_staff_id and sp.work_ready
    and (
      sp.organization_id = v_slot.organization_id
      or exists (
        select 1
        from public.staff_branch_authorisations sba
        where sba.user_id = sp.user_id
          and sba.branch_org_id = v_slot.organization_id
          and sba.status = 'active'
      )
    );
  if not found then
    raise exception 'Work-ready staff profile required';
  end if;

  v_old_staff_id := v_slot.staff_id;
  v_new_status := case when v_slot.status = 'draft' then 'draft' else 'published' end;

  update public.roster_slots rs
  set staff_id = p_new_staff_id,
      status = v_new_status,
      notes = concat_ws(E'\n', nullif(rs.notes, ''), 'Reassigned: ' || trim(p_reason))
  where rs.id = v_slot.id
  returning rs.* into v_slot;

  if v_unit.work_unit_type in ('patrol', 'static') and v_slot.status <> 'draft' then
    select * into v_materialized
    from public.materialize_roster_slot_core(v_slot.id, v_slot.status);
    v_slot.linked_shift_id := v_materialized.shift_id;
  end if;

  insert into public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  values (
    v_slot.organization_id,
    v_actor,
    'roster_slot_reassigned',
    'roster_slots',
    v_slot.id,
    jsonb_build_object(
      'work_unit_id', v_unit.id,
      'old_staff_id', v_old_staff_id,
      'new_staff_id', p_new_staff_id,
      'linked_shift_id', v_slot.linked_shift_id,
      'reason', trim(p_reason)
    )
  );

  return query
  select
    v_slot.id,
    v_slot.status,
    v_slot.staff_id,
    v_slot.linked_shift_id,
    (
      select s.status
      from public.shifts s
      where s.id = v_slot.linked_shift_id
    );
end;
$function$;
REVOKE ALL ON FUNCTION "public"."reassign_roster_slot"(p_slot_id uuid, p_expected_status text, p_new_staff_id uuid, p_reason text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."reassign_roster_slot"(p_slot_id uuid, p_expected_status text, p_new_staff_id uuid, p_reason text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."reassign_roster_slot"(p_slot_id uuid, p_expected_status text, p_new_staff_id uuid, p_reason text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."reassign_roster_slot"(p_slot_id uuid, p_expected_status text, p_new_staff_id uuid, p_reason text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."respond_to_overtime_offer"(p_offer_id uuid, p_expected_status text, p_response text, p_decline_reason text DEFAULT NULL::text)
 RETURNS overtime_offers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_offer public.overtime_offers%rowtype;
  v_slot public.roster_slots%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_reason text := nullif(trim(coalesce(p_decline_reason, '')), '');
begin
  select o.* into v_offer
  from public.overtime_offers o
  where o.id = p_offer_id
  for update;
  if not found then
    raise exception 'Overtime offer not found';
  end if;

  select sp.* into v_staff
  from public.staff_profiles sp
  where sp.id = v_offer.staff_id
    and sp.work_ready
    and (sp.user_id = v_actor or sp.id = v_actor);
  if not found then
    raise exception 'Only the offered work-ready staff member can respond';
  end if;

  if v_offer.status <> p_expected_status then
    raise exception 'Overtime offer changed from expected status % to %', p_expected_status, v_offer.status;
  end if;
  if v_offer.status <> 'offered' then
    raise exception 'Only open overtime offers can be answered';
  end if;
  if v_offer.expires_at < now() then
    update public.overtime_offers
    set status = 'expired'
    where id = v_offer.id
    returning * into v_offer;
    raise exception 'This overtime offer has expired';
  end if;
  if p_response not in ('accepted', 'declined') then
    raise exception 'Response must be accepted or declined';
  end if;

  if p_response = 'declined' then
    update public.overtime_offers
    set status = 'declined',
        decline_reason = v_reason,
        responded_at = now()
    where id = v_offer.id
    returning * into v_offer;
  else
    select s.* into v_slot
    from public.roster_slots s
    where s.id = v_offer.roster_slot_id
    for update;
    if not found or v_slot.status not in ('draft', 'published', 'declined') then
      raise exception 'Roster slot is no longer available';
    end if;

    select u.* into v_unit
    from public.roster_work_units u
    where u.id = v_slot.work_unit_id
      and u.organization_id = v_slot.organization_id
      and u.active;
    if not found then
      raise exception 'Active work unit not found';
    end if;

    if exists (
      select 1
      from public.roster_slots s
      where s.id <> v_slot.id
        and s.staff_id = v_staff.id
        and s.status not in ('declined', 'cancelled')
        and s.scheduled_start < v_slot.scheduled_end
        and s.scheduled_end > v_slot.scheduled_start
    ) then
      raise exception 'Staff member already has an overlapping roster slot';
    end if;

    update public.roster_slots
    set staff_id = v_offer.staff_id,
        status = 'accepted'
    where id = v_slot.id
    returning * into v_slot;

    if v_unit.work_unit_type in ('patrol', 'static') then
      perform public.materialize_roster_slot_core(v_slot.id, 'accepted');
      select s.* into v_slot
      from public.roster_slots s
      where s.id = v_slot.id;
    end if;

    update public.overtime_offers
    set status = 'accepted',
        responded_at = now()
    where id = v_offer.id
    returning * into v_offer;

    update public.overtime_offers
    set status = 'withdrawn'
    where roster_slot_id = v_offer.roster_slot_id
      and status = 'offered'
      and id <> v_offer.id;
  end if;

  insert into public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  values (
    v_offer.organization_id,
    v_actor,
    'overtime_offer_answered',
    'overtime_offers',
    v_offer.id,
    jsonb_build_object(
      'response', p_response,
      'roster_slot_id', v_offer.roster_slot_id,
      'seniority_position', v_offer.seniority_position,
      'decline_reason', v_reason,
      'linked_shift_id', v_slot.linked_shift_id
    )
  );

  return v_offer;
end;
$function$;
REVOKE ALL ON FUNCTION "public"."respond_to_overtime_offer"(p_offer_id uuid, p_expected_status text, p_response text, p_decline_reason text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."respond_to_overtime_offer"(p_offer_id uuid, p_expected_status text, p_response text, p_decline_reason text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."respond_to_overtime_offer"(p_offer_id uuid, p_expected_status text, p_response text, p_decline_reason text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."respond_to_overtime_offer"(p_offer_id uuid, p_expected_status text, p_response text, p_decline_reason text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."materialize_roster_slot_core"(p_slot_id uuid, p_expected_status text)
 RETURNS TABLE(slot_id uuid, shift_id uuid, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_user uuid;
  v_shift public.shifts%rowtype;
  v_shift_status text;
  v_sal public.service_agreement_locations%rowtype;
  v_site_location uuid;
  v_stop uuid;
  v_fatigue_conflict text;
begin
  select s.* into v_slot
  from public.roster_slots s
  where s.id = p_slot_id
  for update;
  if not found then
    raise exception 'Roster slot not found';
  end if;
  if v_slot.status <> p_expected_status then
    raise exception 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status;
  end if;

  select u.* into v_unit
  from public.roster_work_units u
  where u.id = v_slot.work_unit_id
    and u.organization_id = v_slot.organization_id
    and u.active;
  if not found then
    raise exception 'Active work unit not found';
  end if;
  if v_unit.work_unit_type not in ('patrol', 'static') then
    raise exception 'Only patrol and static roster slots materialize field shifts';
  end if;

  select sp.* into v_staff
  from public.staff_profiles sp
  where sp.id = v_slot.staff_id and sp.work_ready;
  if not found or not (
    v_staff.organization_id = v_slot.organization_id
    or exists (
      select 1
      from public.staff_branch_authorisations sba
      where sba.user_id = v_staff.user_id
        and sba.branch_org_id = v_slot.organization_id
        and sba.status = 'active'
    )
  ) then
    raise exception 'Work-ready staff profile required';
  end if;

  v_user := coalesce(v_staff.user_id, v_staff.id);
  if not exists (
    select 1
    from public.user_profiles up
    where up.id = v_user
      and up.deactivated_at is null
      and up.role in ('officer', 'admin_officer')
  ) then
    raise exception 'Roster slot staff is not an active field officer';
  end if;

  if v_slot.scheduled_start < now() - interval '5 minutes'
    or v_slot.scheduled_end <= v_slot.scheduled_start
    or v_slot.scheduled_end - v_slot.scheduled_start > interval '24 hours'
  then
    raise exception 'Slot timing is outside the accepted range';
  end if;

  if exists (
    select 1
    from public.leave_requests l
    where l.staff_id = v_staff.id
      and l.status = 'approved'
      and daterange(l.starts_on, l.ends_on, '[]')
        && daterange(v_slot.scheduled_start::date, v_slot.scheduled_end::date, '[]')
  ) then
    raise exception 'Staff member has approved leave';
  end if;

  if public.staff_has_roster_availability_conflict(
    v_staff.id,
    v_slot.scheduled_start,
    v_slot.scheduled_end
  ) then
    raise exception 'Staff member is unavailable during this roster slot';
  end if;

  v_fatigue_conflict := public.staff_fatigue_conflict(
    v_staff.id,
    v_slot.scheduled_start,
    v_slot.scheduled_end,
    v_slot.id
  );
  if v_fatigue_conflict is not null then
    raise exception 'Fatigue rule breach: %', v_fatigue_conflict;
  end if;

  if exists (
    select 1
    from public.shifts s
    where s.id <> coalesce(v_slot.linked_shift_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and s.officer_user_id = v_user
      and s.status not in ('declined', 'cancelled')
      and s.scheduled_start < v_slot.scheduled_end
      and s.scheduled_end > v_slot.scheduled_start
  ) then
    raise exception 'Officer already has an overlapping field shift';
  end if;

  v_shift_status := case when v_slot.status = 'accepted' then 'accepted' else 'published' end;

  if v_slot.linked_shift_id is not null then
    select s.* into v_shift
    from public.shifts s
    where s.id = v_slot.linked_shift_id
    for update;
    if not found then
      raise exception 'Linked field shift not found';
    end if;

    if v_shift.officer_user_id <> v_user then
      if v_shift.status not in ('published', 'accepted', 'declined')
        or v_shift.actual_start is not null
      then
        raise exception 'Field shift has started or is no longer reassignable';
      end if;
      if exists (
        select 1 from public.patrols p
        where p.shift_id = v_shift.id and p.status = 'in_progress'
      ) then
        raise exception 'Active patrol prevents reassignment';
      end if;
      if exists (
        select 1 from public.dispatch_jobs d
        where d.shift_id = v_shift.id
          and d.status in ('pending', 'pending_approval', 'dispatched', 'acknowledged', 'en_route', 'on_scene')
      ) then
        raise exception 'Active dispatch work prevents reassignment';
      end if;
      if exists (
        select 1 from public.shift_stop_actions a
        where a.shift_id = v_shift.id
      ) then
        raise exception 'Recorded field activity prevents reassignment';
      end if;
    end if;

    update public.shifts
    set officer_user_id = v_user,
        status = v_shift_status
    where id = v_shift.id
    returning * into v_shift;

    return query select v_slot.id, v_shift.id, false;
    return;
  end if;

  if v_unit.work_unit_type = 'patrol' then
    insert into public.shifts (
      organization_id,
      officer_user_id,
      service_type,
      patrol_route_id,
      scheduled_start,
      scheduled_end,
      status,
      notes,
      roster_slot_id
    )
    values (
      v_slot.organization_id,
      v_user,
      v_unit.service_type,
      v_unit.patrol_route_id,
      v_slot.scheduled_start,
      v_slot.scheduled_end,
      v_shift_status,
      v_slot.notes,
      v_slot.id
    )
    returning * into v_shift;

    perform public.generate_shift_stops(
      v_shift.id,
      (v_slot.scheduled_start at time zone 'Pacific/Auckland')::date
    );
  elsif v_unit.work_unit_type = 'static' then
    select sal.* into v_sal
    from public.service_agreement_locations sal
    where sal.id = v_unit.service_agreement_location_id
      and sal.status = 'active';
    if not found or not exists (
      select 1
      from public.service_agreement_modules sam
      where sam.id = v_unit.service_agreement_module_id
        and sam.service_agreement_id = v_sal.service_agreement_id
        and sam.enabled
        and sam.module_key = 'static_guarding'
    ) then
      raise exception 'Static work unit contract is no longer active';
    end if;

    if v_sal.site_id is not null then
      select cs.location_id into v_site_location
      from public.client_sites cs
      where cs.id = v_sal.site_id;
    end if;

    insert into public.shifts (
      organization_id,
      officer_user_id,
      service_type,
      location_id,
      zone_id,
      scheduled_start,
      scheduled_end,
      status,
      notes,
      roster_slot_id,
      service_agreement_location_id,
      service_agreement_module_id,
      total_stops,
      generated_at
    )
    values (
      v_slot.organization_id,
      v_user,
      v_unit.service_type,
      v_site_location,
      v_sal.zone_id,
      v_slot.scheduled_start,
      v_slot.scheduled_end,
      v_shift_status,
      v_slot.notes,
      v_slot.id,
      v_unit.service_agreement_location_id,
      v_unit.service_agreement_module_id,
      1,
      clock_timestamp()
    )
    returning * into v_shift;

    insert into public.shift_stops (
      organization_id,
      shift_id,
      site_id,
      zone_id,
      module_key,
      stop_order,
      visit_number,
      is_adhoc,
      sla_arrive_by,
      required_dwell_minutes,
      status,
      sla_status,
      officer_notes
    )
    values (
      v_slot.organization_id,
      v_shift.id,
      v_sal.site_id,
      v_sal.zone_id,
      'static_guarding',
      1,
      1,
      false,
      v_slot.scheduled_start,
      0,
      'pending',
      'on_track',
      v_slot.notes
    )
    returning id into v_stop;

    insert into public.shift_stop_modules (
      organization_id,
      shift_stop_id,
      module_key,
      is_required,
      service_agreement_module_id,
      service_agreement_location_id
    )
    values (
      v_slot.organization_id,
      v_stop,
      'static_guarding',
      true,
      v_unit.service_agreement_module_id,
      v_unit.service_agreement_location_id
    );
  else
    raise exception 'Unsupported field work unit type';
  end if;

  update public.roster_slots
  set linked_shift_id = v_shift.id
  where id = v_slot.id;

  insert into public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  values (
    v_slot.organization_id,
    v_actor,
    'roster_shift_created',
    'shifts',
    v_shift.id,
    jsonb_build_object(
      'officer_user_id', v_user,
      'staff_id', v_staff.id,
      'roster_slot_id', v_slot.id,
      'status', v_shift.status
    )
  );

  insert into public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  values (
    v_slot.organization_id,
    v_actor,
    'roster_slot_materialized',
    'roster_slots',
    v_slot.id,
    jsonb_build_object(
      'work_unit_id', v_unit.id,
      'work_unit_type', v_unit.work_unit_type,
      'shift_id', v_shift.id
    )
  );

  return query select v_slot.id, v_shift.id, true;
end;
$function$;
REVOKE ALL ON FUNCTION "public"."materialize_roster_slot_core"(p_slot_id uuid, p_expected_status text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."materialize_roster_slot_core"(p_slot_id uuid, p_expected_status text) TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_roster_commercial_readiness"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(slot_id uuid, pay_status text, billing_status text, quote_status text, geofence_status text, cost_centre_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to view roster commercial readiness';end if;
  if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '62 days' then raise exception 'Readiness window must be between 1 and 62 days';end if;
  return query
  select s.id,
    case when exists(select 1 from public.rate_rules r where r.organization_id=s.organization_id and r.rule_kind='pay' and r.active and (r.service_type is null or r.service_type=u.service_type) and (r.effective_from is null or r.effective_from<=s.scheduled_start::date) and (r.effective_to is null or r.effective_to>=s.scheduled_start::date)) then 'ready' else 'missing_rule' end,
    case
      when u.work_unit_type in ('internal', 'workshop') then 'not_applicable'
      when u.work_unit_type='static' and not exists(select 1 from public.service_agreement_locations l join public.service_agreements a on a.id=l.service_agreement_id join public.service_agreement_modules m on m.id=u.service_agreement_module_id and m.service_agreement_id=a.id and m.enabled where l.id=u.service_agreement_location_id and l.status='active' and a.agreement_type='operational' and (a.starts_on is null or a.starts_on<=s.scheduled_start::date) and (a.ends_on is null or a.ends_on>=s.scheduled_start::date)) then 'missing_contract'
      when u.work_unit_type='static' and public.roster_agreement_billing_ready((select l.service_agreement_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id),(select l.site_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id),(select l.zone_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id)) then 'ready'
      when u.work_unit_type='static' then 'missing_rate'
      when s.linked_shift_id is null then 'pending_materialization'
      when not exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required where st.shift_id=s.linked_shift_id) or exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required where st.shift_id=s.linked_shift_id and (sm.service_agreement_location_id is null or sm.service_agreement_module_id is null)) then 'missing_attribution'
      when exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required join public.service_agreement_locations l on l.id=sm.service_agreement_location_id where st.shift_id=s.linked_shift_id and not public.roster_agreement_billing_ready(l.service_agreement_id,l.site_id,l.zone_id)) then 'missing_rate'
      else 'ready' end,
    case
      when u.work_unit_type in ('internal', 'workshop') then 'not_applicable'
      when u.work_unit_type='static' and exists(select 1 from public.service_agreement_locations l join public.quotes q on q.service_agreement_id=l.service_agreement_id and q.status='accepted' where l.id=u.service_agreement_location_id) then 'accepted'
      when u.work_unit_type='static' then 'missing'
      when s.linked_shift_id is null then 'pending_materialization'
      when exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required left join public.service_agreement_locations l on l.id=sm.service_agreement_location_id left join public.quotes q on q.service_agreement_id=l.service_agreement_id and q.status='accepted' where st.shift_id=s.linked_shift_id and q.id is null) then 'missing'
      else 'accepted' end,
    case
      when u.work_unit_type in ('internal', 'workshop') then 'not_applicable'
      when u.work_unit_type='static' then public.roster_place_geofence_state((select l.site_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id),(select l.zone_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id))
      when s.linked_shift_id is null then 'pending_materialization'
      when not exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id) then 'pending_materialization'
      when exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id and public.roster_place_geofence_state(st.site_id,st.zone_id)='missing') then 'missing'
      when not exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id and public.roster_place_geofence_state(st.site_id,st.zone_id)<>'verified') then 'verified'
      else 'mapped_unverified' end,
    case when u.work_unit_type in ('patrol', 'static') then 'not_applicable' when u.cost_centre_id is not null then 'ready' else 'missing' end
  from public.roster_slots s join public.roster_work_units u on u.id=s.work_unit_id
  where s.organization_id=p_organization_id and s.scheduled_start<p_to and s.scheduled_end>p_from and s.status<>'cancelled';
end;$function$;
REVOKE ALL ON FUNCTION "public"."get_roster_commercial_readiness"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_roster_commercial_readiness"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."get_roster_commercial_readiness"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_roster_commercial_readiness"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "service_role";

CREATE OR REPLACE FUNCTION public.get_roster_labour_cost(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(slot_id uuid, work_unit_name text, staff_id uuid, scheduled_hours numeric, pay_rate numeric, charge_rate numeric, pay_cost numeric, billable numeric, margin numeric, rate_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to view labour cost for this organization'; end if;
  return query
  select s.id, work_unit.name, s.staff_id,
    round(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    pay.amount, bill.amount,
    round(coalesce(pay.amount, 0) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    case when historical.yes then null else round(coalesce(bill.amount, 0) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2) end,
    case when historical.yes then null else round((coalesce(bill.amount, 0) - coalesce(pay.amount, 0)) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2) end,
    case
      when historical.yes and pay.amount is null then 'no_pay_rule'
      when work_unit.work_unit_type = 'workshop' then 'billed_via_work_order'
      when historical.yes then 'billed_via_patrol_log'
      when pay.amount is null and bill.amount is null then 'no_rules'
      when pay.amount is null then 'no_pay_rule'
      when bill.amount is null then 'no_billing_rule'
      else 'resolved' end
  from public.roster_slots s
  join public.roster_work_units work_unit on work_unit.id = s.work_unit_id
  left join public.staff_profiles staff on staff.id = s.staff_id
  cross join lateral (select (work_unit.work_unit_type = 'workshop' or coalesce(s.external_refs->>'source' = 'rm_patrol_log_labour', false)) as yes) historical
  left join lateral public.resolve_rate_rule(p_organization_id, 'pay', s.scheduled_start, work_unit.service_type, null, null, null, null, null, staff.role_code, null, null, 'hourly') pay on true
  left join lateral public.resolve_rate_rule(p_organization_id, 'billing', s.scheduled_start, work_unit.service_type, null, null, null, null, null, staff.role_code, null, null, 'hourly') bill on not historical.yes
  where s.organization_id = p_organization_id and s.status not in ('cancelled', 'declined') and s.scheduled_start >= p_from and s.scheduled_start < p_to
  order by s.scheduled_start;
end;
$function$;
REVOKE ALL ON FUNCTION public.get_roster_labour_cost(uuid, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_roster_labour_cost(uuid, timestamp with time zone, timestamp with time zone) TO postgres, authenticated, service_role;

-- Manufacturing and maintenance: who leads the job by default, and digger work as a subject.
CREATE TABLE public.workshop_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  default_job_lead_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.workshop_settings IS 'Per-organization Manufacturing & maintenance defaults. The default job lead is preselected on new client jobs; the work order keeps the actual assignee. Written only through set_workshop_default_job_lead.';
ALTER TABLE public.workshop_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workshop_settings FROM anon, authenticated;
GRANT SELECT ON public.workshop_settings TO authenticated;
CREATE POLICY workshop_settings_read ON public.workshop_settings FOR SELECT TO authenticated
  USING (public.user_can_operate_organization(organization_id));

CREATE OR REPLACE FUNCTION public.set_workshop_default_job_lead(p_organization_id uuid, p_user_id uuid)
RETURNS public.workshop_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_previous uuid;
  v_row public.workshop_settings%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.user_can_operate_organization(p_organization_id)
    OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Active authorized operating branch administrator required';
  END IF;
  IF p_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_profiles profile
    WHERE profile.id = p_user_id AND profile.deactivated_at IS NULL
      AND (profile.organization_id = p_organization_id OR profile.employer_organization_id = p_organization_id)
  ) THEN
    RAISE EXCEPTION 'Job lead must be an active staff member of this organization';
  END IF;
  SELECT default_job_lead_user_id INTO v_previous FROM public.workshop_settings WHERE organization_id = p_organization_id;
  INSERT INTO public.workshop_settings (organization_id, default_job_lead_user_id, updated_by, updated_at)
  VALUES (p_organization_id, p_user_id, v_actor, now())
  ON CONFLICT (organization_id) DO UPDATE
    SET default_job_lead_user_id = EXCLUDED.default_job_lead_user_id, updated_by = v_actor, updated_at = now()
  RETURNING * INTO v_row;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'workshop_default_job_lead_set', 'workshop_settings', p_organization_id,
    jsonb_build_object('previous_user_id', v_previous, 'user_id', p_user_id));
  RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_workshop_default_job_lead(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_workshop_default_job_lead(uuid, uuid) TO authenticated, service_role;

-- Owner ruling 2026-10: Pete Crawford is R&M's main manufacturing and maintenance worker.
INSERT INTO public.workshop_settings (organization_id, default_job_lead_user_id, updated_at)
SELECT 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid, profile.id, now()
FROM public.user_profiles profile
WHERE profile.id = '8f705807-81d5-424e-910f-3c5d8d97b80e'::uuid
  AND profile.deactivated_at IS NULL
  AND 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid IN (profile.organization_id, profile.employer_organization_id)
ON CONFLICT (organization_id) DO NOTHING;
INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
SELECT settings.organization_id, NULL, 'workshop_default_job_lead_set', 'workshop_settings', settings.organization_id,
  jsonb_build_object('user_id', settings.default_job_lead_user_id, 'source', 'owner_ruling_migration_20261029130000')
FROM public.workshop_settings settings
WHERE settings.organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
  AND NOT EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'workshop_default_job_lead_set'
    AND a.target_id = settings.organization_id AND a.metadata->>'source' = 'owner_ruling_migration_20261029130000');

INSERT INTO public.reference_code_templates (code_type, code, name, description, is_active, sort_order, external_refs)
VALUES ('work_subject', 'earthworks', 'Earthworks (digger / excavator)', 'Digger or excavator work: tracks, drains, culverts, clearing, post holes.', true, 85, '{}'::jsonb)
ON CONFLICT DO NOTHING;
INSERT INTO public.reference_codes (organization_id, code_type, code, name, description, is_active, sort_order, external_refs)
SELECT DISTINCT existing.organization_id, 'work_subject', 'earthworks', 'Earthworks (digger / excavator)',
  'Digger or excavator work: tracks, drains, culverts, clearing, post holes.', true, 85, '{}'::jsonb
FROM public.reference_codes existing
WHERE existing.code_type = 'work_subject'
ON CONFLICT (organization_id, code_type, code) DO NOTHING;
