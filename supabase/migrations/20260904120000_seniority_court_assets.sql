-- Tier 3: public-safety workforce capabilities
-- 1. Seniority-ordered overtime offers (union/rank-based distribution)
-- 2. Court appearance scheduling with associated overtime
-- 3. Activates the existing assets / asset_checks fleet tables and links
--    equipment to shifts

ALTER TABLE "public"."staff_profiles"
  ADD COLUMN IF NOT EXISTS "seniority_date" date,
  ADD COLUMN IF NOT EXISTS "overtime_eligible" boolean DEFAULT true NOT NULL;

UPDATE "public"."staff_profiles" SET "seniority_date" = "start_date"
  WHERE "seniority_date" IS NULL AND "start_date" IS NOT NULL;

COMMENT ON COLUMN "public"."staff_profiles"."seniority_date" IS 'Basis for seniority-ordered overtime distribution. Defaults to start_date; kept separate so recognised prior service can be credited.';

CREATE TABLE IF NOT EXISTS "public"."overtime_offers" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" uuid NOT NULL REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
  "roster_slot_id" uuid NOT NULL REFERENCES "public"."roster_slots"("id") ON DELETE CASCADE,
  "staff_id" uuid NOT NULL REFERENCES "public"."staff_profiles"("id") ON DELETE CASCADE,
  "offer_round" integer DEFAULT 1 NOT NULL,
  "seniority_position" integer NOT NULL,
  "status" text DEFAULT 'offered' NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "responded_at" timestamptz,
  "decline_reason" text,
  "client_request_id" uuid NOT NULL,
  "created_by" uuid REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "overtime_offers_status_check" CHECK ("status" IN ('offered', 'accepted', 'declined', 'expired', 'withdrawn')),
  UNIQUE ("organization_id", "client_request_id")
);

CREATE INDEX IF NOT EXISTS "idx_overtime_offers_slot" ON "public"."overtime_offers"("roster_slot_id", "offer_round");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_overtime_offers_open" ON "public"."overtime_offers"("roster_slot_id", "staff_id") WHERE "status" = 'offered';

ALTER TABLE "public"."overtime_offers" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "overtime_offers_select" ON "public"."overtime_offers";
CREATE POLICY "overtime_offers_select" ON "public"."overtime_offers" FOR SELECT TO "authenticated"
  USING (public.is_admin_for_org(organization_id) OR EXISTS (
    SELECT 1 FROM public.staff_profiles sp
    WHERE sp.id = overtime_offers.staff_id AND (sp.user_id = auth.uid() OR sp.id = auth.uid())
  ));

REVOKE ALL ON TABLE "public"."overtime_offers" FROM PUBLIC, "anon", "authenticated";
GRANT SELECT ON TABLE "public"."overtime_offers" TO "authenticated";
GRANT ALL ON TABLE "public"."overtime_offers" TO "service_role";

CREATE TABLE IF NOT EXISTS "public"."court_appearances" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" uuid NOT NULL REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
  "officer_user_id" uuid NOT NULL REFERENCES "public"."user_profiles"("id") ON DELETE RESTRICT,
  "enforcement_case_id" uuid REFERENCES "public"."enforcement_cases"("id") ON DELETE SET NULL,
  "court_name" text NOT NULL,
  "case_reference" text,
  "subpoena_reference" text,
  "appearance_type" text NOT NULL,
  "scheduled_at" timestamptz NOT NULL,
  "estimated_hours" numeric(4,2) DEFAULT 2 NOT NULL,
  "actual_start" timestamptz,
  "actual_end" timestamptz,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "is_overtime" boolean DEFAULT false NOT NULL,
  "outcome" text,
  "notes" text,
  "client_request_id" uuid NOT NULL,
  "created_by" uuid REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "court_appearances_type_check" CHECK ("appearance_type" IN ('hearing', 'trial', 'deposition', 'tribunal', 'mediation', 'other')),
  CONSTRAINT "court_appearances_status_check" CHECK ("status" IN ('scheduled', 'attended', 'adjourned', 'cancelled', 'excused')),
  UNIQUE ("organization_id", "client_request_id")
);

CREATE INDEX IF NOT EXISTS "idx_court_appearances_officer" ON "public"."court_appearances"("officer_user_id", "scheduled_at");

ALTER TABLE "public"."court_appearances" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "court_appearances_select" ON "public"."court_appearances";
CREATE POLICY "court_appearances_select" ON "public"."court_appearances" FOR SELECT TO "authenticated"
  USING (public.is_admin_for_org(organization_id) OR officer_user_id = auth.uid());

REVOKE ALL ON TABLE "public"."court_appearances" FROM PUBLIC, "anon", "authenticated";
GRANT SELECT ON TABLE "public"."court_appearances" TO "authenticated";
GRANT ALL ON TABLE "public"."court_appearances" TO "service_role";

DROP TRIGGER IF EXISTS "trg_court_appearances_touch" ON "public"."court_appearances";
CREATE TRIGGER "trg_court_appearances_touch" BEFORE UPDATE ON "public"."court_appearances"
  FOR EACH ROW EXECUTE FUNCTION "public"."tg_touch_updated_at"();

CREATE TABLE IF NOT EXISTS "public"."shift_assets" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" uuid NOT NULL REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
  "shift_id" uuid NOT NULL REFERENCES "public"."shifts"("id") ON DELETE CASCADE,
  "asset_id" uuid NOT NULL REFERENCES "public"."assets"("id") ON DELETE RESTRICT,
  "assigned_by" uuid REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL,
  "assigned_at" timestamptz DEFAULT now() NOT NULL,
  "returned_at" timestamptz,
  "client_request_id" uuid NOT NULL,
  UNIQUE ("organization_id", "client_request_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_shift_assets_active" ON "public"."shift_assets"("asset_id") WHERE "returned_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_shift_assets_shift" ON "public"."shift_assets"("shift_id");

ALTER TABLE "public"."shift_assets" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shift_assets_select" ON "public"."shift_assets";
CREATE POLICY "shift_assets_select" ON "public"."shift_assets" FOR SELECT TO "authenticated"
  USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE "public"."shift_assets" FROM PUBLIC, "anon", "authenticated";
GRANT SELECT ON TABLE "public"."shift_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."shift_assets" TO "service_role";

REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."assets" FROM PUBLIC, "anon", "authenticated";
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."asset_checks" FROM PUBLIC, "anon", "authenticated";

DROP POLICY IF EXISTS "assets_insert" ON "public"."assets";
DROP POLICY IF EXISTS "assets_update" ON "public"."assets";
DROP POLICY IF EXISTS "asset_checks_insert" ON "public"."asset_checks";

-- Offers the slot to the most senior eligible unassigned staff who are free.
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
    raise exception 'Overtime can only be offered for an unfilled roster slot';
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
      and sp.id <> v_slot.staff_id
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
      -- derived so a retried round stays idempotent per candidate
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
      'roster_slot_id', v_slot.id,
      'offer_round', v_round,
      'offers_created', v_created,
      'expires_at', v_expires,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_created, v_round;
end;
$$;

REVOKE ALL ON FUNCTION "public"."offer_overtime_by_seniority"(uuid,uuid,integer,integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."offer_overtime_by_seniority"(uuid,uuid,integer,integer) TO "authenticated", "service_role";

-- First acceptance wins; remaining open offers on the slot are withdrawn.
CREATE OR REPLACE FUNCTION "public"."respond_to_overtime_offer"(
  p_offer_id uuid,
  p_expected_status text,
  p_response text,
  p_decline_reason text DEFAULT NULL
)
RETURNS public.overtime_offers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_offer public.overtime_offers%rowtype;
  v_slot public.roster_slots%rowtype;
  v_reason text := nullif(trim(coalesce(p_decline_reason, '')), '');
begin
  select o.* into v_offer from public.overtime_offers o where o.id = p_offer_id for update;
  if not found then
    raise exception 'Overtime offer not found';
  end if;

  if not exists (
    select 1 from public.staff_profiles sp
    where sp.id = v_offer.staff_id and (sp.user_id = v_actor or sp.id = v_actor)
  ) then
    raise exception 'Only the offered staff member can respond';
  end if;

  if v_offer.status <> p_expected_status then
    raise exception 'Overtime offer changed from expected status % to %', p_expected_status, v_offer.status;
  end if;

  if v_offer.status <> 'offered' then
    raise exception 'Only open overtime offers can be answered';
  end if;

  if v_offer.expires_at < now() then
    update public.overtime_offers set status = 'expired' where id = v_offer.id returning * into v_offer;
    raise exception 'This overtime offer has expired';
  end if;

  if p_response not in ('accepted', 'declined') then
    raise exception 'Response must be accepted or declined';
  end if;

  if p_response = 'declined' then
    update public.overtime_offers
    set status = 'declined', decline_reason = v_reason, responded_at = now()
    where id = v_offer.id
    returning * into v_offer;
  else
    select s.* into v_slot from public.roster_slots s where s.id = v_offer.roster_slot_id for update;
    if v_slot.status not in ('draft', 'published', 'declined') then
      raise exception 'Roster slot is no longer available';
    end if;

    update public.overtime_offers
    set status = 'accepted', responded_at = now()
    where id = v_offer.id
    returning * into v_offer;

    update public.overtime_offers
    set status = 'withdrawn'
    where roster_slot_id = v_offer.roster_slot_id and status = 'offered' and id <> v_offer.id;

    update public.roster_slots
    set staff_id = v_offer.staff_id, status = 'accepted'
    where id = v_slot.id;
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_offer.organization_id, v_actor, 'overtime_offer_answered', 'overtime_offers', v_offer.id,
    jsonb_build_object(
      'response', p_response,
      'roster_slot_id', v_offer.roster_slot_id,
      'seniority_position', v_offer.seniority_position,
      'decline_reason', v_reason
    )
  );

  return v_offer;
end;
$$;

REVOKE ALL ON FUNCTION "public"."respond_to_overtime_offer"(uuid,text,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."respond_to_overtime_offer"(uuid,text,text,text) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."schedule_court_appearance"(
  p_client_request_id uuid,
  p_officer_user_id uuid,
  p_court_name text,
  p_appearance_type text,
  p_scheduled_at timestamptz,
  p_estimated_hours numeric DEFAULT 2,
  p_enforcement_case_id uuid DEFAULT NULL,
  p_case_reference text DEFAULT NULL,
  p_subpoena_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.court_appearances
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_appearance public.court_appearances%rowtype;
  v_court text := nullif(trim(coalesce(p_court_name, '')), '');
  v_is_ot boolean;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select actor.organization_id into v_provider from public.user_profiles actor
  where actor.id = v_actor and actor.deactivated_at is null;

  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active roster administrator required';
  end if;

  select c.* into v_appearance from public.court_appearances c
  where c.organization_id = v_provider and c.client_request_id = p_client_request_id;
  if found then
    return v_appearance;
  end if;

  if v_court is null then
    raise exception 'Court name is required';
  end if;

  if p_appearance_type not in ('hearing', 'trial', 'deposition', 'tribunal', 'mediation', 'other') then
    raise exception 'Unsupported court appearance type';
  end if;

  if p_estimated_hours is null or p_estimated_hours <= 0 or p_estimated_hours > 24 then
    raise exception 'Estimated hours must be between 0 and 24';
  end if;

  -- Court time outside any rostered slot is overtime.
  v_is_ot := not exists (
    select 1 from public.roster_slots s
    join public.staff_profiles sp on sp.id = s.staff_id
    where coalesce(sp.user_id, sp.id) = p_officer_user_id
      and s.status in ('published', 'accepted', 'completed')
      and tstzrange(s.scheduled_start, s.scheduled_end, '[)')
          @> p_scheduled_at
  );

  insert into public.court_appearances(
    organization_id, officer_user_id, enforcement_case_id, court_name, case_reference,
    subpoena_reference, appearance_type, scheduled_at, estimated_hours, status,
    is_overtime, notes, client_request_id, created_by
  )
  values (
    v_provider, p_officer_user_id, p_enforcement_case_id, v_court,
    nullif(trim(coalesce(p_case_reference, '')), ''),
    nullif(trim(coalesce(p_subpoena_reference, '')), ''),
    p_appearance_type, p_scheduled_at, p_estimated_hours, 'scheduled',
    v_is_ot, nullif(trim(coalesce(p_notes, '')), ''), p_client_request_id, v_actor
  )
  returning * into v_appearance;

  perform public.enqueue_notification(
    v_provider, 'roster', 'Court appearance scheduled',
    format('%s at %s on %s.', initcap(p_appearance_type), v_court,
      to_char(p_scheduled_at at time zone 'Pacific/Auckland', 'DD Mon YYYY HH24:MI')),
    'warning', p_officer_user_id, null, 'roster',
    jsonb_build_object('court_appearance_id', v_appearance.id),
    'court_appearance:' || v_appearance.id::text
  );

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_provider, v_actor, 'court_appearance_scheduled', 'court_appearances', v_appearance.id,
    jsonb_build_object(
      'officer_user_id', p_officer_user_id,
      'court_name', v_court,
      'scheduled_at', p_scheduled_at,
      'is_overtime', v_is_ot,
      'subpoena_reference', p_subpoena_reference,
      'client_request_id', p_client_request_id
    )
  );

  return v_appearance;
end;
$$;

REVOKE ALL ON FUNCTION "public"."schedule_court_appearance"(uuid,uuid,text,text,timestamptz,numeric,uuid,text,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."schedule_court_appearance"(uuid,uuid,text,text,timestamptz,numeric,uuid,text,text,text) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."record_court_appearance_outcome"(
  p_appearance_id uuid,
  p_expected_status text,
  p_status text,
  p_actual_start timestamptz DEFAULT NULL,
  p_actual_end timestamptz DEFAULT NULL,
  p_outcome text DEFAULT NULL
)
RETURNS public.court_appearances
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_appearance public.court_appearances%rowtype;
  v_outcome text := nullif(trim(coalesce(p_outcome, '')), '');
begin
  select c.* into v_appearance from public.court_appearances c where c.id = p_appearance_id for update;
  if not found then
    raise exception 'Court appearance not found';
  end if;

  if v_appearance.officer_user_id <> v_actor and not public.is_admin_for_org(v_appearance.organization_id) then
    raise exception 'Not authorised to update this court appearance';
  end if;

  if v_appearance.status <> p_expected_status then
    raise exception 'Court appearance changed from expected status % to %', p_expected_status, v_appearance.status;
  end if;

  if p_status not in ('attended', 'adjourned', 'cancelled', 'excused') then
    raise exception 'Unsupported court appearance outcome status';
  end if;

  if p_status = 'attended' and (p_actual_start is null or p_actual_end is null) then
    raise exception 'Attended appearances require actual start and end times';
  end if;

  if p_actual_end is not null and p_actual_start is not null and p_actual_end <= p_actual_start then
    raise exception 'Court appearance must end after it starts';
  end if;

  update public.court_appearances
  set status = p_status, actual_start = p_actual_start, actual_end = p_actual_end, outcome = v_outcome
  where id = v_appearance.id
  returning * into v_appearance;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_appearance.organization_id, v_actor, 'court_appearance_outcome_recorded', 'court_appearances', v_appearance.id,
    jsonb_build_object(
      'status', p_status,
      'actual_start', p_actual_start,
      'actual_end', p_actual_end,
      'is_overtime', v_appearance.is_overtime,
      'outcome', v_outcome
    )
  );

  return v_appearance;
end;
$$;

REVOKE ALL ON FUNCTION "public"."record_court_appearance_outcome"(uuid,text,text,timestamptz,timestamptz,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."record_court_appearance_outcome"(uuid,text,text,timestamptz,timestamptz,text) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."assign_shift_asset"(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_asset_id uuid
)
RETURNS public.shift_assets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_asset public.assets%rowtype;
  v_link public.shift_assets%rowtype;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select s.* into v_shift from public.shifts s where s.id = p_shift_id;
  if not found then
    raise exception 'Shift not found';
  end if;

  if not public.is_admin_for_org(v_shift.organization_id) and v_shift.officer_user_id <> v_actor then
    raise exception 'Not authorised to assign assets to this shift';
  end if;

  select l.* into v_link from public.shift_assets l
  where l.organization_id = v_shift.organization_id and l.client_request_id = p_client_request_id;
  if found then
    return v_link;
  end if;

  select a.* into v_asset from public.assets a where a.id = p_asset_id for update;
  if not found then
    raise exception 'Asset not found';
  end if;

  if v_asset.organization_id <> v_shift.organization_id then
    raise exception 'Asset belongs to another organization';
  end if;

  if v_asset.status <> 'available' then
    raise exception 'Asset is not available (current status %)', v_asset.status;
  end if;

  insert into public.shift_assets(organization_id, shift_id, asset_id, assigned_by, client_request_id)
  values (v_shift.organization_id, v_shift.id, v_asset.id, v_actor, p_client_request_id)
  returning * into v_link;

  update public.assets
  set status = 'in_use', assigned_to = v_shift.officer_user_id
  where id = v_asset.id;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_shift.organization_id, v_actor, 'shift_asset_assigned', 'shift_assets', v_link.id,
    jsonb_build_object(
      'shift_id', v_shift.id,
      'asset_id', v_asset.id,
      'asset_type', v_asset.asset_type,
      'registration', v_asset.registration,
      'client_request_id', p_client_request_id
    )
  );

  return v_link;
end;
$$;

REVOKE ALL ON FUNCTION "public"."assign_shift_asset"(uuid,uuid,uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."assign_shift_asset"(uuid,uuid,uuid) TO "authenticated", "service_role";

-- Returning an unserviceable asset routes it to maintenance rather than the pool.
CREATE OR REPLACE FUNCTION "public"."return_shift_asset"(
  p_link_id uuid,
  p_condition text DEFAULT 'good',
  p_odometer_reading integer DEFAULT NULL,
  p_fuel_level text DEFAULT NULL,
  p_defects_noted text DEFAULT NULL
)
RETURNS public.shift_assets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_link public.shift_assets%rowtype;
begin
  select l.* into v_link from public.shift_assets l where l.id = p_link_id for update;
  if not found then
    raise exception 'Shift asset assignment not found';
  end if;

  if not public.is_admin_for_org(v_link.organization_id)
     and not exists (select 1 from public.shifts s where s.id = v_link.shift_id and s.officer_user_id = v_actor) then
    raise exception 'Not authorised to return this asset';
  end if;

  if v_link.returned_at is not null then
    return v_link;
  end if;

  if p_condition not in ('good', 'minor_issue', 'major_issue', 'unserviceable') then
    raise exception 'Unsupported asset condition';
  end if;

  if p_fuel_level is not null and p_fuel_level not in ('full', 'three_quarter', 'half', 'quarter', 'empty') then
    raise exception 'Unsupported fuel level';
  end if;

  update public.shift_assets set returned_at = now() where id = v_link.id returning * into v_link;

  insert into public.asset_checks(
    organization_id, asset_id, checked_by, check_type, condition,
    odometer_reading, fuel_level, defects_noted
  )
  values (
    v_link.organization_id, v_link.asset_id, v_actor, 'post_shift', p_condition,
    p_odometer_reading, p_fuel_level, nullif(trim(coalesce(p_defects_noted, '')), '')
  );

  update public.assets
  set
    status = case when p_condition in ('major_issue', 'unserviceable') then 'maintenance' else 'available' end,
    assigned_to = null,
    last_inspection_date = current_date
  where id = v_link.asset_id;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_link.organization_id, v_actor, 'shift_asset_returned', 'shift_assets', v_link.id,
    jsonb_build_object(
      'asset_id', v_link.asset_id,
      'condition', p_condition,
      'odometer_reading', p_odometer_reading,
      'fuel_level', p_fuel_level,
      'defects_noted', p_defects_noted
    )
  );

  return v_link;
end;
$$;

REVOKE ALL ON FUNCTION "public"."return_shift_asset"(uuid,text,integer,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."return_shift_asset"(uuid,text,integer,text,text) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."manage_asset"(
  p_client_request_id uuid,
  p_action text,
  p_asset_id uuid DEFAULT NULL,
  p_asset_type text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_registration text DEFAULT NULL,
  p_make text DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_year integer DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_next_inspection_date date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_asset public.assets%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select actor.organization_id into v_provider from public.user_profiles actor
  where actor.id = v_actor and actor.deactivated_at is null;

  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active fleet administrator required';
  end if;

  if p_action = 'create' then
    if v_name is null then
      raise exception 'Asset name is required';
    end if;
    if p_asset_type not in ('vehicle', 'radio', 'body_camera', 'torch', 'uniform', 'first_aid_kit', 'ems_device', 'other') then
      raise exception 'Unsupported asset type';
    end if;

    insert into public.assets(
      organization_id, asset_type, name, serial_number, registration,
      make, model, year, status, next_inspection_date, notes
    )
    values (
      v_provider, p_asset_type, v_name,
      nullif(trim(coalesce(p_serial_number, '')), ''),
      nullif(trim(coalesce(p_registration, '')), ''),
      nullif(trim(coalesce(p_make, '')), ''),
      nullif(trim(coalesce(p_model, '')), ''),
      p_year, coalesce(p_status, 'available'), p_next_inspection_date,
      nullif(trim(coalesce(p_notes, '')), '')
    )
    returning * into v_asset;

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_provider, v_actor, 'asset_created', 'assets', v_asset.id,
      jsonb_build_object('asset_type', v_asset.asset_type, 'name', v_asset.name, 'client_request_id', p_client_request_id));

    return v_asset;
  elsif p_action = 'update' then
    select a.* into v_asset from public.assets a where a.id = p_asset_id and a.organization_id = v_provider for update;
    if not found then
      raise exception 'Asset not found';
    end if;

    if p_status is not null and p_status not in ('available', 'in_use', 'maintenance', 'retired', 'lost') then
      raise exception 'Unsupported asset status';
    end if;

    if p_status = 'available' and exists (
      select 1 from public.shift_assets l where l.asset_id = v_asset.id and l.returned_at is null
    ) then
      raise exception 'Asset is still assigned to an active shift';
    end if;

    update public.assets set
      name = coalesce(v_name, name),
      serial_number = coalesce(nullif(trim(coalesce(p_serial_number, '')), ''), serial_number),
      registration = coalesce(nullif(trim(coalesce(p_registration, '')), ''), registration),
      make = coalesce(nullif(trim(coalesce(p_make, '')), ''), make),
      model = coalesce(nullif(trim(coalesce(p_model, '')), ''), model),
      year = coalesce(p_year, year),
      status = coalesce(p_status, status),
      next_inspection_date = coalesce(p_next_inspection_date, next_inspection_date),
      notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes)
    where id = v_asset.id
    returning * into v_asset;

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_provider, v_actor, 'asset_updated', 'assets', v_asset.id,
      jsonb_build_object('status', v_asset.status, 'name', v_asset.name));

    return v_asset;
  else
    raise exception 'Unsupported manage_asset action %', p_action;
  end if;
end;
$$;

REVOKE ALL ON FUNCTION "public"."manage_asset"(uuid,text,uuid,text,text,text,text,text,text,integer,text,date,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_asset"(uuid,text,uuid,text,text,text,text,text,text,integer,text,date,text) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."record_asset_check"(
  p_client_request_id uuid,
  p_asset_id uuid,
  p_check_type text,
  p_condition text,
  p_odometer_reading integer DEFAULT NULL,
  p_fuel_level text DEFAULT NULL,
  p_defects_noted text DEFAULT NULL,
  p_action_required text DEFAULT NULL
)
RETURNS public.asset_checks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_asset public.assets%rowtype;
  v_check public.asset_checks%rowtype;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select a.* into v_asset from public.assets a where a.id = p_asset_id for update;
  if not found then
    raise exception 'Asset not found';
  end if;

  if not public.org_access_allowed(v_asset.organization_id) then
    raise exception 'Not authorised to check this asset';
  end if;

  if p_check_type not in ('pre_shift', 'post_shift', 'weekly', 'monthly', 'defect_report') then
    raise exception 'Unsupported asset check type';
  end if;

  if p_condition not in ('good', 'minor_issue', 'major_issue', 'unserviceable') then
    raise exception 'Unsupported asset condition';
  end if;

  if p_fuel_level is not null and p_fuel_level not in ('full', 'three_quarter', 'half', 'quarter', 'empty') then
    raise exception 'Unsupported fuel level';
  end if;

  insert into public.asset_checks(
    organization_id, asset_id, checked_by, check_type, condition,
    odometer_reading, fuel_level, defects_noted, action_required
  )
  values (
    v_asset.organization_id, v_asset.id, v_actor, p_check_type, p_condition,
    p_odometer_reading, p_fuel_level,
    nullif(trim(coalesce(p_defects_noted, '')), ''),
    nullif(trim(coalesce(p_action_required, '')), '')
  )
  returning * into v_check;

  if p_condition in ('major_issue', 'unserviceable') then
    update public.assets set status = 'maintenance' where id = v_asset.id;
    perform public.enqueue_notification(
      v_asset.organization_id, 'system', 'Asset requires maintenance',
      format('%s reported %s during a %s check.', v_asset.name, replace(p_condition, '_', ' '), replace(p_check_type, '_', ' ')),
      'warning', null, 'admin', 'roster',
      jsonb_build_object('asset_id', v_asset.id, 'asset_check_id', v_check.id),
      'asset_defect:' || v_check.id::text
    );
  end if;

  update public.assets set last_inspection_date = current_date where id = v_asset.id;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_asset.organization_id, v_actor, 'asset_check_recorded', 'asset_checks', v_check.id,
    jsonb_build_object(
      'asset_id', v_asset.id,
      'check_type', p_check_type,
      'condition', p_condition,
      'odometer_reading', p_odometer_reading,
      'client_request_id', p_client_request_id
    )
  );

  return v_check;
end;
$$;

REVOKE ALL ON FUNCTION "public"."record_asset_check"(uuid,uuid,text,text,integer,text,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."record_asset_check"(uuid,uuid,text,text,integer,text,text,text) TO "authenticated", "service_role";
