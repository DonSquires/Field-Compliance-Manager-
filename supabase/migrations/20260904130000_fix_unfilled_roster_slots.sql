-- Fix: roster_slots.staff_id was NOT NULL, so an unfilled slot could not exist.
-- generate_roster_from_templates (20260903220000) inserts no staff_id and would
-- fail on every call, and offer_overtime_by_seniority targets unfilled slots
-- that were unrepresentable. Both deployed cleanly because PL/pgSQL does not
-- bind column constraints at CREATE time.
-- Open/vacant slots are a real roster state: template-generated drafts, shifts
-- awaiting an overtime offer, and vacancies pending auto-assignment.

ALTER TABLE "public"."roster_slots" ALTER COLUMN "staff_id" DROP NOT NULL;

COMMENT ON COLUMN "public"."roster_slots"."staff_id" IS 'Assigned staff member. NULL means the slot is open/unfilled and awaiting assignment, template generation, or an overtime offer.';

CREATE INDEX IF NOT EXISTS "idx_roster_slots_unfilled"
  ON "public"."roster_slots"("organization_id", "scheduled_start")
  WHERE "staff_id" IS NULL;

-- Availability and fatigue checks only apply once someone is actually assigned.
CREATE OR REPLACE FUNCTION "public"."enforce_roster_slot_availability"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_fatigue text;
begin
  if new.staff_id is not null and new.status not in ('declined', 'cancelled') then
    if public.staff_has_roster_availability_conflict(new.staff_id, new.scheduled_start, new.scheduled_end) then
      raise exception 'Staff member is unavailable during this roster slot';
    end if;
    v_fatigue := public.staff_fatigue_conflict(new.staff_id, new.scheduled_start, new.scheduled_end, new.id);
    if v_fatigue is not null then
      raise exception 'Fatigue rule breach: %', v_fatigue;
    end if;
  end if;
  return new;
end;
$$;

-- Template generation now resolves a work unit per template (patrol route match
-- first, then site, then a single active fallback) and leaves slots unfilled.
DROP FUNCTION IF EXISTS "public"."generate_roster_from_templates"(uuid,uuid,date,date);

CREATE OR REPLACE FUNCTION "public"."generate_roster_from_templates"(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_from_date date,
  p_to_date date
)
RETURNS TABLE(slots_generated integer, templates_applied integer, templates_skipped integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_count integer := 0;
  v_applied integer := 0;
  v_skipped integer := 0;
  v_tpl record;
  v_unit_id uuid;
  v_fallback_unit uuid;
  v_curr_date date;
  v_dow integer;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_made_any boolean;
  v_slot integer;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select actor.organization_id into v_provider from public.user_profiles actor
  where actor.id = v_actor and actor.deactivated_at is null;

  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active roster administrator required';
  end if;

  if p_organization_id <> v_provider then
    raise exception 'Organization is outside your managed account hierarchy';
  end if;

  if p_to_date < p_from_date then
    raise exception 'Generation period end must not precede its start';
  end if;

  if (p_to_date - p_from_date) > 186 then
    raise exception 'Generation period cannot exceed six months';
  end if;

  select wu.id into v_fallback_unit
  from public.roster_work_units wu
  where wu.organization_id = v_provider and wu.active = true
  order by wu.name
  limit 1;

  for v_tpl in (
    select st.*
    from public.shift_templates st
    where st.organization_id = v_provider
      and st.is_active = true
      and (st.effective_from is null or st.effective_from <= p_to_date)
      and (st.effective_to is null or st.effective_to >= p_from_date)
  ) loop
    v_unit_id := null;

    if v_tpl.patrol_route_id is not null then
      select wu.id into v_unit_id from public.roster_work_units wu
      where wu.organization_id = v_provider and wu.active = true
        and wu.patrol_route_id = v_tpl.patrol_route_id
      limit 1;
    end if;

    if v_unit_id is null and v_tpl.site_id is not null then
      select wu.id into v_unit_id
      from public.roster_work_units wu
      join public.service_agreement_locations sal on sal.id = wu.service_agreement_location_id
      where wu.organization_id = v_provider and wu.active = true and sal.site_id = v_tpl.site_id
      limit 1;
    end if;

    v_unit_id := coalesce(v_unit_id, v_fallback_unit);

    if v_unit_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_made_any := false;
    v_curr_date := p_from_date;

    while v_curr_date <= p_to_date loop
      v_dow := extract(isodow from v_curr_date);
      if v_dow = any(v_tpl.active_days) then
        v_start_ts := (v_curr_date + v_tpl.start_time) at time zone 'Pacific/Auckland';
        if v_tpl.end_time <= v_tpl.start_time then
          v_end_ts := ((v_curr_date + 1) + v_tpl.end_time) at time zone 'Pacific/Auckland';
        else
          v_end_ts := (v_curr_date + v_tpl.end_time) at time zone 'Pacific/Auckland';
        end if;

        for v_slot in 1..greatest(v_tpl.required_staff_count, 1) loop
          if not exists (
            select 1 from public.roster_slots s
            where s.organization_id = v_provider
              and s.work_unit_id = v_unit_id
              and s.scheduled_start = v_start_ts
              and s.notes = 'Generated from shift template: ' || v_tpl.name || ' (' || v_slot || ')'
          ) then
            insert into public.roster_slots(
              organization_id, work_unit_id, staff_id, scheduled_start, scheduled_end,
              status, client_request_id, notes, created_by
            )
            values (
              v_provider, v_unit_id, null, v_start_ts, v_end_ts,
              'draft', gen_random_uuid(),
              'Generated from shift template: ' || v_tpl.name || ' (' || v_slot || ')',
              v_actor
            );
            v_count := v_count + 1;
            v_made_any := true;
          end if;
        end loop;
      end if;
      v_curr_date := v_curr_date + 1;
    end loop;

    if v_made_any then
      v_applied := v_applied + 1;
    end if;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_provider, v_actor, 'roster_generated_from_templates', 'roster_slots', v_provider,
    jsonb_build_object(
      'from_date', p_from_date,
      'to_date', p_to_date,
      'slots_generated', v_count,
      'templates_applied', v_applied,
      'templates_skipped', v_skipped,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_count, v_applied, v_skipped;
end;
$$;

REVOKE ALL ON FUNCTION "public"."generate_roster_from_templates"(uuid,uuid,date,date) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."generate_roster_from_templates"(uuid,uuid,date,date) TO "authenticated", "service_role";

-- Batch publish must not publish a slot that still has nobody assigned.
DROP FUNCTION IF EXISTS "public"."batch_publish_roster_slots"(uuid,uuid,timestamptz,timestamptz);

CREATE OR REPLACE FUNCTION "public"."batch_publish_roster_slots"(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(published_count integer, materialized_count integer, conflict_count integer, unfilled_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_slot record;
  v_unit public.roster_work_units%rowtype;
  v_pub integer := 0;
  v_mat integer := 0;
  v_conf integer := 0;
  v_unfilled integer := 0;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select actor.organization_id into v_provider from public.user_profiles actor
  where actor.id = v_actor and actor.deactivated_at is null;

  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active roster administrator required';
  end if;

  if p_organization_id <> v_provider then
    raise exception 'Organization is outside your managed account hierarchy';
  end if;

  for v_slot in (
    select s.* from public.roster_slots s
    where s.organization_id = v_provider
      and s.status = 'draft'
      and s.scheduled_start >= p_from
      and s.scheduled_start < p_to
    order by s.scheduled_start
    for update
  ) loop
    if v_slot.staff_id is null then
      v_unfilled := v_unfilled + 1;
      continue;
    end if;

    if exists (
      select 1 from public.leave_requests l
      where l.staff_id = v_slot.staff_id
        and l.status = 'approved'
        and daterange(l.starts_on, l.ends_on, '[]')
            && daterange(v_slot.scheduled_start::date, v_slot.scheduled_end::date, '[]')
    ) then
      v_conf := v_conf + 1;
      continue;
    end if;

    update public.roster_slots set status = 'published' where id = v_slot.id;
    v_pub := v_pub + 1;

    select wu.* into v_unit from public.roster_work_units wu where wu.id = v_slot.work_unit_id;
    if found and v_unit.work_unit_type <> 'internal' then
      begin
        perform public.materialize_roster_slot(v_slot.id, 'published');
        v_mat := v_mat + 1;
      exception when others then
        null;
      end;
    end if;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_provider, v_actor, 'roster_period_batch_published', 'roster_slots', v_provider,
    jsonb_build_object(
      'from', p_from, 'to', p_to,
      'published_count', v_pub, 'materialized_count', v_mat,
      'conflict_count', v_conf, 'unfilled_count', v_unfilled,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_pub, v_mat, v_conf, v_unfilled;
end;
$$;

REVOKE ALL ON FUNCTION "public"."batch_publish_roster_slots"(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."batch_publish_roster_slots"(uuid,uuid,timestamptz,timestamptz) TO "authenticated", "service_role";

-- Overtime is now offered against genuinely open slots.
CREATE OR REPLACE FUNCTION "public"."offer_overtime_by_seniority"(
  p_client_request_id uuid,
  p_roster_slot_id uuid,
  p_offer_count integer DEFAULT 3,
  p_expires_in_minutes integer DEFAULT 60
)
RETURNS TABLE(offers_created integer, offer_round integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_round integer;
  v_expires timestamptz;
  v_created integer := 0;
  v_candidate record;
  v_position integer := 0;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select s.* into v_slot from public.roster_slots s where s.id = p_roster_slot_id for update;
  if not found then
    raise exception 'Roster slot not found';
  end if;

  if not public.is_admin_for_org(v_slot.organization_id) then
    raise exception 'Not authorised to offer overtime for this organization';
  end if;

  if v_slot.status not in ('draft', 'published', 'declined') then
    raise exception 'Overtime can only be offered for an open roster slot';
  end if;

  if p_offer_count is null or p_offer_count <= 0 or p_offer_count > 50 then
    raise exception 'Offer count must be between 1 and 50';
  end if;

  if exists (select 1 from public.overtime_offers o where o.roster_slot_id = v_slot.id and o.status = 'offered') then
    raise exception 'This slot already has open overtime offers';
  end if;

  select coalesce(max(o.offer_round), 0) + 1 into v_round
  from public.overtime_offers o where o.roster_slot_id = v_slot.id;

  v_expires := now() + make_interval(mins => greatest(p_expires_in_minutes, 5));

  for v_candidate in (
    select sp.id as staff_id
    from public.staff_profiles sp
    where sp.organization_id = v_slot.organization_id
      and sp.work_ready = true
      and sp.overtime_eligible = true
      and (v_slot.staff_id is null or sp.id <> v_slot.staff_id)
      and (sp.end_date is null or sp.end_date >= (v_slot.scheduled_start at time zone 'Pacific/Auckland')::date)
      and not public.staff_has_roster_availability_conflict(sp.id, v_slot.scheduled_start, v_slot.scheduled_end)
      and public.staff_fatigue_conflict(sp.id, v_slot.scheduled_start, v_slot.scheduled_end, v_slot.id) is null
      and not exists (
        select 1 from public.overtime_offers o
        where o.roster_slot_id = v_slot.id and o.staff_id = sp.id and o.status in ('declined', 'accepted')
      )
    order by sp.seniority_date asc nulls last, sp.start_date asc nulls last, sp.id
    limit p_offer_count
  ) loop
    v_position := v_position + 1;
    insert into public.overtime_offers(
      organization_id, roster_slot_id, staff_id, offer_round, seniority_position,
      status, expires_at, client_request_id, created_by
    )
    values (
      v_slot.organization_id, v_slot.id, v_candidate.staff_id, v_round, v_position,
      'offered', v_expires,
      uuid_in(md5(p_client_request_id::text || v_candidate.staff_id::text)::cstring),
      v_actor
    );
    v_created := v_created + 1;
  end loop;

  if v_created = 0 then
    raise exception 'No eligible staff available for overtime on this slot';
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_slot.organization_id, v_actor, 'overtime_offered_by_seniority', 'overtime_offers', v_slot.id,
    jsonb_build_object(
      'roster_slot_id', v_slot.id, 'offer_round', v_round,
      'offers_created', v_created, 'was_unfilled', v_slot.staff_id is null,
      'expires_at', v_expires, 'client_request_id', p_client_request_id
    )
  );

  return query select v_created, v_round;
end;
$$;

REVOKE ALL ON FUNCTION "public"."offer_overtime_by_seniority"(uuid,uuid,integer,integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."offer_overtime_by_seniority"(uuid,uuid,integer,integer) TO "authenticated", "service_role";
