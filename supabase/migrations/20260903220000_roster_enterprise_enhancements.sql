-- Migration: 20260903220000_roster_enterprise_enhancements.sql
-- Enterprise Rostering System Enhancements:
-- 1. Batch Publish Roster Slots (batch_publish_roster_slots)
-- 2. Recall / Unpublish Roster Slot (unpublish_roster_slot)
-- 3. Staff Availability Governance (manage_staff_availability)
-- 4. Shift Template Management & Generation (manage_shift_template, generate_roster_from_templates)
-- 5. Shift Swap Approval Governance (review_shift_swap)

-- 1. Governed RPC: batch_publish_roster_slots
CREATE OR REPLACE FUNCTION "public"."batch_publish_roster_slots"(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(
  published_count integer,
  materialized_count integer,
  conflict_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_slot record;
  v_unit public.roster_work_units%rowtype;
  v_pub_count integer := 0;
  v_mat_count integer := 0;
  v_conf_count integer := 0;
  v_mat_res record;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select actor.organization_id into v_provider from public.user_profiles actor where actor.id = v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active roster administrator required';
  end if;

  if p_organization_id <> v_provider then
    raise exception 'Organization is outside your managed account hierarchy';
  end if;

  for v_slot in (
    select s.*
    from public.roster_slots s
    where s.organization_id = v_provider
      and s.status = 'draft'
      and s.scheduled_start >= p_from
      and s.scheduled_start < p_to
    for update
  ) loop
    -- Check availability / leave conflict if staff assigned
    if v_slot.staff_id is not null then
      if exists (
        select 1 from public.leave_requests l
        where l.staff_id = v_slot.staff_id
          and l.status = 'approved'
          and daterange(l.starts_on, l.ends_on, '[]') && daterange(v_slot.scheduled_start::date, v_slot.scheduled_end::date, '[]')
      ) then
        v_conf_count := v_conf_count + 1;
        continue;
      end if;
    end if;

    -- Update slot to published
    update public.roster_slots set status = 'published', updated_at = now() where id = v_slot.id;
    v_pub_count := v_pub_count + 1;

    -- Materialize operational shift if work unit requires it
    select wu.* into v_unit from public.roster_work_units wu where wu.id = v_slot.work_unit_id;
    if found and v_unit.work_unit_type <> 'internal' then
      begin
        select * into v_mat_res from public.materialize_roster_slot(v_slot.id, 'published');
        v_mat_count := v_mat_count + 1;
      exception when others then
        -- Materialization warning ignored for batch resilience
        null;
      end;
    end if;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_provider,
    v_actor,
    'roster_period_batch_published',
    'roster_slots',
    v_provider,
    jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'published_count', v_pub_count,
      'materialized_count', v_mat_count,
      'conflict_count', v_conf_count,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_pub_count, v_mat_count, v_conf_count;
end;
$$;

REVOKE ALL ON FUNCTION "public"."batch_publish_roster_slots"(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."batch_publish_roster_slots"(uuid,uuid,timestamptz,timestamptz) TO "authenticated", "service_role";

-- 2. Governed RPC: unpublish_roster_slot
CREATE OR REPLACE FUNCTION "public"."unpublish_roster_slot"(
  p_client_request_id uuid,
  p_slot_id uuid,
  p_expected_status text,
  p_reason text DEFAULT NULL
)
RETURNS TABLE(
  slot_id uuid,
  slot_status text,
  shift_cancelled boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_shift public.shifts%rowtype;
  v_shift_canc boolean := false;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select s.* into v_slot from public.roster_slots s where s.id = p_slot_id for update;
  if not found then
    raise exception 'Roster slot not found';
  end if;

  if not public.is_admin_for_org(v_slot.organization_id) then
    raise exception 'Not authorised to manage roster slots for this organization';
  end if;

  if v_slot.status <> p_expected_status then
    raise exception 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status;
  end if;

  if v_slot.status not in ('published', 'accepted') then
    raise exception 'Only published or accepted roster slots can be recalled to draft';
  end if;

  -- Update slot back to draft
  update public.roster_slots set status = 'draft', updated_at = now() where id = v_slot.id returning * into v_slot;

  -- Cancel linked shift if present and not in progress / completed
  select sh.* into v_shift from public.shifts sh where sh.roster_slot_id = v_slot.id;
  if found then
    if v_shift.status = 'scheduled' then
      update public.shifts set status = 'cancelled', updated_at = now() where id = v_shift.id;
      v_shift_canc := true;
    elsif v_shift.status in ('in_progress', 'completed') then
      raise exception 'Cannot recall roster slot while linked shift is %', v_shift.status;
    end if;
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_slot.organization_id,
    v_actor,
    'roster_slot_unpublished',
    'roster_slots',
    v_slot.id,
    jsonb_build_object(
      'reason', v_reason,
      'shift_cancelled', v_shift_canc,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_slot.id, v_slot.status, v_shift_canc;
end;
$$;

REVOKE ALL ON FUNCTION "public"."unpublish_roster_slot"(uuid,uuid,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."unpublish_roster_slot"(uuid,uuid,text,text) TO "authenticated", "service_role";

-- 3. Governed RPC: manage_staff_availability
CREATE OR REPLACE FUNCTION "public"."manage_staff_availability"(
  p_client_request_id uuid,
  p_staff_id uuid,
  p_action text,
  p_availability_id uuid DEFAULT NULL,
  p_day_of_week integer DEFAULT NULL,
  p_specific_date date DEFAULT NULL,
  p_available_from time DEFAULT NULL,
  p_available_to time DEFAULT NULL,
  p_all_day boolean DEFAULT false,
  p_type text DEFAULT 'unavailable',
  p_notes text DEFAULT NULL
)
RETURNS public.staff_availability
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_avail public.staff_availability%rowtype;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select sp.* into v_staff from public.staff_profiles sp where sp.id = p_staff_id or sp.user_id = p_staff_id;
  if not found then
    raise exception 'Staff profile not found';
  end if;

  if not public.is_admin_for_org(v_staff.organization_id) and v_staff.user_id <> v_actor and v_staff.id <> v_actor then
    raise exception 'Not authorised to manage availability for this staff member';
  end if;

  if p_action = 'create' then
    if (p_day_of_week is null and p_specific_date is null) or (p_day_of_week is not null and p_specific_date is not null) then
      raise exception 'Must specify either day_of_week (1-7) or specific_date, but not both';
    end if;

    if p_type not in ('available', 'preferred', 'unavailable', 'leave') then
      raise exception 'Invalid availability_type';
    end if;

    insert into public.staff_availability(
      staff_id, organization_id, day_of_week, specific_date,
      available_from, available_to, all_day, availability_type, notes
    )
    values (
      v_staff.id, v_staff.organization_id, p_day_of_week, p_specific_date,
      p_available_from, p_available_to, p_all_day, p_type, v_notes
    )
    returning * into v_avail;

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (
      v_staff.organization_id, v_actor, 'staff_availability_created', 'staff_availability', v_avail.id,
      jsonb_build_object('staff_id', v_staff.id, 'availability_type', p_type, 'client_request_id', p_client_request_id)
    );

    return v_avail;
  elsif p_action = 'delete' then
    select sa.* into v_avail from public.staff_availability sa where sa.id = p_availability_id and sa.organization_id = v_staff.organization_id;
    if not found then
      raise exception 'Availability record not found';
    end if;

    delete from public.staff_availability where id = v_avail.id;

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (
      v_staff.organization_id, v_actor, 'staff_availability_deleted', 'staff_availability', v_avail.id,
      jsonb_build_object('staff_id', v_staff.id, 'client_request_id', p_client_request_id)
    );

    return v_avail;
  else
    raise exception 'Unsupported manage_staff_availability action %', p_action;
  end if;
end;
$$;

REVOKE ALL ON FUNCTION "public"."manage_staff_availability"(uuid,uuid,text,uuid,integer,date,time,time,boolean,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_staff_availability"(uuid,uuid,text,uuid,integer,date,time,time,boolean,text,text) TO "authenticated", "service_role";

-- 4. Governed RPC: manage_shift_template
CREATE OR REPLACE FUNCTION "public"."manage_shift_template"(
  p_client_request_id uuid,
  p_template_id uuid DEFAULT NULL,
  p_action text DEFAULT 'create',
  p_name text DEFAULT NULL,
  p_shift_type text DEFAULT 'day',
  p_start_time time DEFAULT '08:00',
  p_end_time time DEFAULT '16:00',
  p_recurrence_type text DEFAULT 'weekly',
  p_active_days integer[] DEFAULT '{1,2,3,4,5}',
  p_required_staff_count integer DEFAULT 1,
  p_notes text DEFAULT NULL
)
RETURNS public.shift_templates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_tpl public.shift_templates%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select actor.organization_id into v_provider from public.user_profiles actor where actor.id = v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active roster administrator required';
  end if;

  if p_action in ('create', 'update') then
    if v_name is null then
      raise exception 'Shift template name is required';
    end if;

    if p_shift_type not in ('day', 'swing', 'night', 'overnight', 'split') then
      raise exception 'Invalid shift_type';
    end if;

    if p_recurrence_type not in ('daily', 'weekly', 'fortnightly', 'monthly', 'custom') then
      raise exception 'Invalid recurrence_type';
    end if;

    if p_required_staff_count is null or p_required_staff_count <= 0 then
      raise exception 'Required staff count must be positive';
    end if;

    if p_action = 'create' then
      insert into public.shift_templates(
        organization_id, name, shift_type, start_time, end_time,
        recurrence_type, active_days, required_staff_count, notes, created_by
      )
      values (
        v_provider, v_name, p_shift_type, p_start_time, p_end_time,
        p_recurrence_type, coalesce(p_active_days, '{1,2,3,4,5}'::integer[]), p_required_staff_count, nullif(trim(coalesce(p_notes, '')), ''), v_actor
      )
      returning * into v_tpl;

      insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (v_provider, v_actor, 'shift_template_created', 'shift_templates', v_tpl.id, jsonb_build_object('name', v_tpl.name, 'client_request_id', p_client_request_id));
    else
      select st.* into v_tpl from public.shift_templates st where st.id = p_template_id and st.organization_id = v_provider;
      if not found then
        raise exception 'Shift template not found';
      end if;

      update public.shift_templates set
        name = v_name,
        shift_type = p_shift_type,
        start_time = p_start_time,
        end_time = p_end_time,
        recurrence_type = p_recurrence_type,
        active_days = coalesce(p_active_days, active_days),
        required_staff_count = p_required_staff_count,
        notes = nullif(trim(coalesce(p_notes, '')), '')
      where id = v_tpl.id
      returning * into v_tpl;

      insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (v_provider, v_actor, 'shift_template_updated', 'shift_templates', v_tpl.id, jsonb_build_object('name', v_tpl.name, 'client_request_id', p_client_request_id));
    end if;

    return v_tpl;
  elsif p_action = 'toggle_active' then
    select st.* into v_tpl from public.shift_templates st where st.id = p_template_id and st.organization_id = v_provider;
    if not found then
      raise exception 'Shift template not found';
    end if;

    update public.shift_templates set is_active = not is_active where id = v_tpl.id returning * into v_tpl;

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_provider, v_actor, 'shift_template_toggled', 'shift_templates', v_tpl.id, jsonb_build_object('is_active', v_tpl.is_active));

    return v_tpl;
  else
    raise exception 'Unsupported manage_shift_template action %', p_action;
  end if;
end;
$$;

REVOKE ALL ON FUNCTION "public"."manage_shift_template"(uuid,uuid,text,text,text,time,time,text,integer[],integer,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_shift_template"(uuid,uuid,text,text,text,time,time,text,integer[],integer,text) TO "authenticated", "service_role";

-- 5. Governed RPC: generate_roster_from_templates
CREATE OR REPLACE FUNCTION "public"."generate_roster_from_templates"(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_from_date date,
  p_to_date date
)
RETURNS TABLE(
  slots_generated integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_count integer := 0;
  v_tpl record;
  v_unit public.roster_work_units%rowtype;
  v_curr_date date;
  v_dow integer;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select actor.organization_id into v_provider from public.user_profiles actor where actor.id = v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active roster administrator required';
  end if;

  if p_organization_id <> v_provider then
    raise exception 'Organization is outside your managed account hierarchy';
  end if;

  -- Default fallback work unit if none specified
  select wu.* into v_unit from public.roster_work_units wu where wu.organization_id = v_provider and wu.active = true order by name limit 1;
  if not found then
    raise exception 'Active work unit required to generate roster slots';
  end if;

  for v_tpl in (
    select st.*
    from public.shift_templates st
    where st.organization_id = v_provider and st.is_active = true
  ) loop
    v_curr_date := p_from_date;
    while v_curr_date <= p_to_date loop
      -- Calculate Day of Week (1=Monday ... 7=Sunday)
      v_dow := extract(isodow from v_curr_date);
      if v_dow = any(v_tpl.active_days) then
        v_start_ts := v_curr_date + v_tpl.start_time;
        if v_tpl.end_time <= v_tpl.start_time then
          v_end_ts := (v_curr_date + interval '1 day')::date + v_tpl.end_time;
        else
          v_end_ts := v_curr_date + v_tpl.end_time;
        end if;

        -- Create slot if duplicate start time doesn't already exist for this work unit
        if not exists (
          select 1 from public.roster_slots s
          where s.organization_id = v_provider
            and s.work_unit_id = v_unit.id
            and s.scheduled_start = v_start_ts
        ) then
          insert into public.roster_slots(
            organization_id, work_unit_id, scheduled_start, scheduled_end, status, notes
          )
          values (
            v_provider, v_unit.id, v_start_ts, v_end_ts, 'draft', 'Generated from shift template: ' || v_tpl.name
          );
          v_count := v_count + 1;
        end if;
      end if;
      v_curr_date := v_curr_date + interval '1 day';
    end loop;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_provider,
    v_actor,
    'roster_generated_from_templates',
    'roster_slots',
    v_provider,
    jsonb_build_object(
      'from_date', p_from_date,
      'to_date', p_to_date,
      'slots_generated', v_count,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_count;
end;
$$;

REVOKE ALL ON FUNCTION "public"."generate_roster_from_templates"(uuid,uuid,date,date) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."generate_roster_from_templates"(uuid,uuid,date,date) TO "authenticated", "service_role";

-- 6. Governed RPC: review_shift_swap
CREATE OR REPLACE FUNCTION "public"."review_shift_swap"(
  p_client_request_id uuid,
  p_swap_id uuid,
  p_expected_status text,
  p_decision text,
  p_review_notes text DEFAULT NULL
)
RETURNS public.shift_swaps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_swap public.shift_swaps%rowtype;
  v_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
  v_orig_shift public.shifts%rowtype;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select sw.* into v_swap from public.shift_swaps sw where sw.id = p_swap_id for update;
  if not found then
    raise exception 'Shift swap request not found';
  end if;

  if not public.is_admin_for_org(v_swap.organization_id) then
    raise exception 'Not authorised to review shift swaps for this organization';
  end if;

  if v_swap.status <> p_expected_status then
    raise exception 'Shift swap changed from expected status % to %', p_expected_status, v_swap.status;
  end if;

  if p_decision not in ('approved', 'declined') then
    raise exception 'Decision must be approved or declined';
  end if;

  if p_decision = 'approved' then
    if v_swap.swap_with_staff_id is null then
      raise exception 'Cannot approve swap without designated replacement staff';
    end if;

    select sh.* into v_orig_shift from public.shifts sh where sh.id = v_swap.original_shift_id;
    if found then
      -- Update officer on original shift
      update public.shifts set officer_user_id = v_swap.swap_with_staff_id, updated_at = now() where id = v_orig_shift.id;
      -- Update staff_id on linked roster_slot
      if v_orig_shift.roster_slot_id is not null then
        update public.roster_slots set staff_id = v_swap.swap_with_staff_id, updated_at = now() where id = v_orig_shift.roster_slot_id;
      end if;
    end if;

    update public.shift_swaps set
      status = 'approved',
      approved_by = v_actor,
      approved_at = now(),
      completed_at = now()
    where id = v_swap.id
    returning * into v_swap;
  else
    update public.shift_swaps set
      status = 'declined',
      declined_reason = v_notes,
      approved_by = v_actor,
      approved_at = now()
    where id = v_swap.id
    returning * into v_swap;
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_swap.organization_id,
    v_actor,
    'shift_swap_reviewed',
    'shift_swaps',
    v_swap.id,
    jsonb_build_object(
      'decision', p_decision,
      'original_shift_id', v_swap.original_shift_id,
      'swap_with_staff_id', v_swap.swap_with_staff_id,
      'client_request_id', p_client_request_id
    )
  );

  return v_swap;
end;
$$;

REVOKE ALL ON FUNCTION "public"."review_shift_swap"(uuid,uuid,text,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."review_shift_swap"(uuid,uuid,text,text,text) TO "authenticated", "service_role";
