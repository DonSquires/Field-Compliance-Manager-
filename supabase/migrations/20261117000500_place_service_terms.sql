-- Place patrols and services, Task 5 (owner design 2026-11-16).
-- Versioned place service terms. Every change to what a client is owed at a place (days,
-- window, months, visits, gap, time on site, checks, instructions) is a dated, immutable
-- version. When the provider turns on place_changes_need_second_approver, a change waits as a
-- pending version and a bob_agentic_actions row until another administrator approves it.
-- Approved versions are projected onto the live delivery schedule and patrol config on their
-- effective date (immediately when due, otherwise by the hourly roll), and pending stops on
-- unlocked future shifts are regenerated.
--
-- "Today" is the Pacific/Auckland calendar date, not current_date (UTC on the database).
-- Static guarding terms are reserved for Task 7, which supplies apply_place_static_post_version
-- and replaces the "not available yet" guard in preview and save.

CREATE TABLE IF NOT EXISTS public.place_service_term_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  delivery_schedule_id uuid REFERENCES public.service_agreement_delivery_schedules(id),
  work_unit_id uuid REFERENCES public.roster_work_units(id),
  service_kind text NOT NULL CHECK (service_kind IN ('patrol', 'static_guarding')),
  change_kind text NOT NULL CHECK (change_kind IN ('create', 'update', 'end')),
  effective_from date NOT NULL,
  applied_effective_from date,
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  reason text,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  client_request_id uuid NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  approval_action_id uuid REFERENCES public.bob_agentic_actions(id),
  CHECK ((status = 'approved') = (applied_effective_from IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);

COMMENT ON TABLE public.place_service_term_versions IS
  'Dated, immutable versions of the service terms owed at one place under one agreement. organization_id is the provider. A pending version waits for a second administrator; applied_effective_from is the date an approved version takes effect (never before its approval). Written only through save_place_service_change and decide_place_service_change.';

CREATE INDEX IF NOT EXISTS idx_place_service_term_versions_schedule
  ON public.place_service_term_versions (delivery_schedule_id, status, applied_effective_from);
CREATE INDEX IF NOT EXISTS idx_place_service_term_versions_location
  ON public.place_service_term_versions (location_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_place_service_term_versions_one_pending
  ON public.place_service_term_versions (delivery_schedule_id)
  WHERE status = 'pending' AND delivery_schedule_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.place_service_term_versions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_decision_columns text[] := array['status', 'applied_effective_from', 'decided_by', 'decided_at',
    'decision_reason', 'delivery_schedule_id', 'work_unit_id'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Place service versions cannot be deleted' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - v_decision_columns) is distinct from (to_jsonb(old) - v_decision_columns) then
    raise exception 'Place service versions cannot be changed' using errcode = 'P0001';
  end if;
  -- The decision: pending becomes approved, rejected or withdrawn once. A new service's schedule or
  -- work unit is created before the decision and recorded in the same update.
  if old.status = 'pending' and new.status in ('approved', 'rejected', 'withdrawn') then
    return new;
  end if;
  raise exception 'Place service versions cannot be changed' using errcode = 'P0001';
end;
$$;

REVOKE ALL ON FUNCTION public.place_service_term_versions_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER place_service_term_versions_immutable
  BEFORE UPDATE OR DELETE ON public.place_service_term_versions
  FOR EACH ROW EXECUTE FUNCTION public.place_service_term_versions_guard();

ALTER TABLE public.place_service_term_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY place_service_term_versions_admin_select ON public.place_service_term_versions
  FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id));

REVOKE ALL ON TABLE public.place_service_term_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.place_service_term_versions TO authenticated;
GRANT ALL ON TABLE public.place_service_term_versions TO service_role;

CREATE TABLE IF NOT EXISTS public.patrol_schedule_draw_seeds(
  delivery_schedule_id uuid PRIMARY KEY REFERENCES public.service_agreement_delivery_schedules(id),
  seed bytea NOT NULL DEFAULT extensions.gen_random_bytes(32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.patrol_schedule_draw_seeds IS
  'Secret per-schedule seed for the random-days draw. Never readable through the Data API, so officers and clients cannot predict which days are drawn.';

ALTER TABLE public.patrol_schedule_draw_seeds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.patrol_schedule_draw_seeds FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.patrol_schedule_draw_seeds TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_place_service_change_request
  ON public.audit_log (organization_id, ((metadata ->> 'kind')), ((metadata ->> 'client_request_id')))
  WHERE action IN ('place_service_change_approved', 'place_service_change_pending', 'place_service_change_rejected',
    'place_service_change_withdrawn');

-- Small internal helpers.

CREATE OR REPLACE FUNCTION public.place_service_today()
RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  select (clock_timestamp() at time zone 'Pacific/Auckland')::date
$$;

CREATE OR REPLACE FUNCTION public.place_service_json_int(p_value jsonb)
RETURNS integer
LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  select case when jsonb_typeof(p_value) = 'number' then
    case when (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
          and abs((p_value #>> '{}')::numeric) <= 1000000
      then (p_value #>> '{}')::numeric::integer end
  end
$$;

CREATE OR REPLACE FUNCTION public.place_service_json_int_array(p_value jsonb)
RETURNS integer[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  select case when jsonb_typeof(p_value) = 'array'
      and not exists (select 1 from jsonb_array_elements(p_value) e where public.place_service_json_int(e) is null)
    then coalesce((select array_agg(distinct public.place_service_json_int(e) order by public.place_service_json_int(e))
                   from jsonb_array_elements(p_value) e), array[]::integer[])
  end
$$;

CREATE OR REPLACE FUNCTION public.place_service_json_time(p_value jsonb)
RETURNS time
LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  select case when jsonb_typeof(p_value) = 'string' then
    case when (p_value #>> '{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then (p_value #>> '{}')::time end
  end
$$;

-- The catalogue module is what the agreement covers; the toolset is what the officer does at
-- the stop. A module is a data profile: adding a place-visit service is a row here, not code.
CREATE TABLE IF NOT EXISTS public.place_service_module_profiles (
  module_key text PRIMARY KEY,
  capability_key text NOT NULL,
  toolset_key text NOT NULL,
  config_module_key text NOT NULL,
  delivered_as_visits boolean NOT NULL DEFAULT false
);
ALTER TABLE public.place_service_module_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.place_service_module_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.place_service_module_profiles TO service_role;
COMMENT ON TABLE public.place_service_module_profiles IS
  'Module profile for place services: the capability and officer toolset a catalogue module maps to, and whether it is delivered as visits to a place. Read through place_service_module_mapping.';

INSERT INTO public.place_service_module_profiles(module_key, capability_key, toolset_key, config_module_key, delivered_as_visits)
VALUES
  ('patrol', 'patrol', 'general_patrol', 'general_patrol', true),
  ('general_patrol', 'patrol', 'general_patrol', 'general_patrol', true),
  ('dispatch', 'alarm_response', 'alarm_response', 'alarm_response', true),
  ('alarm_response', 'alarm_response', 'alarm_response', 'alarm_response', true),
  ('noise_control', 'noise_control', 'noise_control', 'noise_control', true),
  ('freedom_camping', 'freedom_camping', 'freedom_camping', 'freedom_camping', true),
  ('welfare', 'patrol', 'welfare_check', 'general_patrol', true),
  ('welfare_check', 'patrol', 'welfare_check', 'general_patrol', true),
  ('parking_enforcement', 'patrol', 'parking_enforcement', 'general_patrol', true),
  ('biosecurity', 'patrol', 'biosecurity', 'general_patrol', true),
  ('smoke_complaints', 'patrol', 'smoke_complaints', 'general_patrol', true),
  ('access_control', 'patrol', 'access_control', 'general_patrol', true),
  ('ems', 'patrol', 'ems', 'general_patrol', true),
  ('static_guarding', 'patrol', 'static_guarding', 'general_patrol', false)
ON CONFLICT (module_key) DO NOTHING;

-- Modules without a profile keep their own key as toolset and are not place-visit services.
CREATE OR REPLACE FUNCTION public.place_service_module_mapping(p_module_key text)
RETURNS TABLE(capability_key text, toolset_key text, config_module_key text, delivered_as_visits boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  select coalesce(p.capability_key, 'patrol'), coalesce(p.toolset_key, p_module_key),
         coalesce(p.config_module_key, 'general_patrol'), coalesce(p.delivered_as_visits, false)
  from (select 1) one
  left join public.place_service_module_profiles p on p.module_key = p_module_key
$$;

CREATE OR REPLACE FUNCTION public.place_service_normalise_endpoint(p_endpoint jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_anchor text := p_endpoint ->> 'anchor';
  v_offset numeric;
  v_time time;
begin
  if jsonb_typeof(p_endpoint) is distinct from 'object' or v_anchor is null
     or v_anchor not in ('sunrise', 'sunset', 'clock') then
    raise exception 'Choose sunrise, sunset or a clock time for each end of the window' using errcode = 'P0001';
  end if;
  if v_anchor = 'clock' then
    v_time := public.place_service_json_time(p_endpoint -> 'time');
    if v_time is null then
      raise exception 'Window times must be in hh:mm format' using errcode = 'P0001';
    end if;
    return jsonb_build_object('anchor', 'clock', 'time', to_char(v_time, 'HH24:MI'), 'offset_hours', 0);
  end if;
  if p_endpoint -> 'offset_hours' is null or jsonb_typeof(p_endpoint -> 'offset_hours') = 'null' then
    v_offset := 0;
  elsif jsonb_typeof(p_endpoint -> 'offset_hours') = 'number' then
    v_offset := (p_endpoint ->> 'offset_hours')::numeric;
  else
    raise exception 'Offsets must be in quarter hours between -12 and 12' using errcode = 'P0001';
  end if;
  if v_offset < -12 or v_offset > 12 or v_offset * 4 <> trunc(v_offset * 4) then
    raise exception 'Offsets must be in quarter hours between -12 and 12' using errcode = 'P0001';
  end if;
  return jsonb_build_object('anchor', v_anchor, 'offset_hours', trim_scale(v_offset));
end;
$$;

CREATE OR REPLACE FUNCTION public.normalise_place_service_terms(p_agreement_id uuid, p_location_id uuid, p_terms jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_agreement public.service_agreements%rowtype;
  v_location public.locations%rowtype;
  v_site uuid;
  v_zone uuid;
  v_place_ok boolean;
  v_module text := nullif(btrim(p_terms ->> 'module_key'), '');
  v_map record;
  v_days jsonb := p_terms -> 'days';
  v_days_out jsonb;
  v_list integer[];
  v_per_week integer;
  v_window jsonb := p_terms -> 'window';
  v_window_out jsonb;
  v_start jsonb;
  v_end jsonb;
  v_wstart time;
  v_wend time;
  v_months integer[];
  v_visits integer;
  v_gap integer;
  v_dwell integer;
  v_active_checks text[];
  v_checks text[] := array[]::text[];
  v_check jsonb;
begin
  if jsonb_typeof(p_terms) is distinct from 'object' then
    raise exception 'Service terms must be an object' using errcode = '22023';
  end if;
  select * into v_agreement from public.service_agreements a where a.id = p_agreement_id;
  if not found then
    raise exception 'Service agreement not found' using errcode = 'P0002';
  end if;
  select * into v_location from public.locations l where l.id = p_location_id;
  if not found or v_location.organization_id is distinct from v_agreement.client_organization_id then
    raise exception 'This agreement does not cover this location' using errcode = 'P0001';
  end if;

  -- One place: a site or an area of this location.
  begin
    v_site := nullif(p_terms -> 'anchor' ->> 'site_id', '')::uuid;
    v_zone := nullif(p_terms -> 'anchor' ->> 'zone_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose one place: a site or an area' using errcode = 'P0001';
  end;
  if (v_site is null) = (v_zone is null) then
    raise exception 'Choose one place: a site or an area' using errcode = 'P0001';
  end if;
  if v_site is not null then
    select exists (select 1 from public.client_sites s where s.id = v_site and s.active
      and s.location_id = p_location_id and s.client_organization_id = v_agreement.client_organization_id) into v_place_ok;
  else
    select exists (select 1 from public.location_zones z where z.id = v_zone and z.location_id = p_location_id
      and z.is_active and not z.is_verification_point) into v_place_ok;
  end if;
  if not v_place_ok then
    raise exception 'That place is not part of this location' using errcode = 'P0001';
  end if;

  -- The service, delivered as visits to the place.
  if v_module is null or not exists (select 1 from public.module_catalog m where m.module_key = v_module and m.active) then
    raise exception 'Choose an active service (module)' using errcode = 'P0001';
  end if;
  select * into v_map from public.place_service_module_mapping(v_module);
  if not v_map.delivered_as_visits then
    raise exception 'This service is not delivered as visits to a place' using errcode = 'P0001';
  end if;

  -- Days: fixed weekdays, or a number drawn at random from allowed days each ISO week.
  if v_days ->> 'mode' = 'random' then
    v_list := public.place_service_json_int_array(v_days -> 'allowed');
    if v_list is null or cardinality(v_list) = 0 or v_list[1] < 1 or v_list[cardinality(v_list)] > 7 then
      raise exception 'Choose at least one day of the week (Monday = 1)' using errcode = 'P0001';
    end if;
    v_per_week := public.place_service_json_int(v_days -> 'per_week');
    if v_per_week is null or v_per_week < 1 or v_per_week > cardinality(v_list) then
      raise exception 'Random days per week must be between 1 and the number of allowed days' using errcode = 'P0001';
    end if;
    v_days_out := jsonb_build_object('mode', 'random', 'per_week', v_per_week, 'allowed', to_jsonb(v_list));
  elsif v_days ->> 'mode' = 'fixed' then
    v_list := public.place_service_json_int_array(v_days -> 'weekdays');
    if v_list is null or cardinality(v_list) = 0 or v_list[1] < 1 or v_list[cardinality(v_list)] > 7 then
      raise exception 'Choose at least one day of the week (Monday = 1)' using errcode = 'P0001';
    end if;
    v_days_out := jsonb_build_object('mode', 'fixed', 'weekdays', to_jsonb(v_list));
  else
    raise exception 'Choose at least one day of the week (Monday = 1)' using errcode = 'P0001';
  end if;

  -- Window: any time, fixed clock times, or sunrise/sunset with quarter-hour offsets.
  if v_window is null or jsonb_typeof(v_window) = 'null' or v_window ->> 'mode' = 'any' then
    v_window_out := jsonb_build_object('mode', 'any');
  elsif v_window ->> 'mode' = 'fixed' then
    if (nullif(v_window ->> 'start', '') is null) <> (nullif(v_window ->> 'end', '') is null) then
      raise exception 'Set both window times, or neither for any time of day' using errcode = 'P0001';
    end if;
    if nullif(v_window ->> 'start', '') is null then
      v_window_out := jsonb_build_object('mode', 'any');
    else
      v_wstart := public.place_service_json_time(v_window -> 'start');
      v_wend := public.place_service_json_time(v_window -> 'end');
      if v_wstart is null or v_wend is null then
        raise exception 'Window times must be in hh:mm format' using errcode = 'P0001';
      end if;
      v_window_out := jsonb_build_object('mode', 'fixed', 'start', to_char(v_wstart, 'HH24:MI'), 'end', to_char(v_wend, 'HH24:MI'));
    end if;
  elsif v_window ->> 'mode' = 'solar' then
    if v_window -> 'start' is null or v_window -> 'end' is null then
      raise exception 'Set both window times, or neither for any time of day' using errcode = 'P0001';
    end if;
    v_start := public.place_service_normalise_endpoint(v_window -> 'start');
    v_end := public.place_service_normalise_endpoint(v_window -> 'end');
    if (v_start ->> 'anchor' <> 'clock' or v_end ->> 'anchor' <> 'clock')
       and public.place_anchor_point(v_site, v_zone) is null then
      raise exception 'Draw the boundary for this place before using sunrise or sunset times' using errcode = 'P0001';
    end if;
    v_window_out := jsonb_build_object('mode', 'solar', 'start', v_start, 'end', v_end);
  else
    raise exception 'Choose a window: any time, fixed times, or sunrise and sunset' using errcode = 'P0001';
  end if;

  -- Months ([] = every month).
  if p_terms -> 'months' is null or jsonb_typeof(p_terms -> 'months') = 'null' then
    v_months := array[]::integer[];
  else
    v_months := public.place_service_json_int_array(p_terms -> 'months');
    if v_months is null or (cardinality(v_months) > 0 and (v_months[1] < 1 or v_months[cardinality(v_months)] > 12)) then
      raise exception 'Months must be between 1 and 12' using errcode = 'P0001';
    end if;
  end if;

  v_visits := coalesce(public.place_service_json_int(p_terms -> 'visits_per_shift'),
    case when p_terms -> 'visits_per_shift' is null then 1 end);
  if v_visits is null or v_visits < 1 or v_visits > 24 then
    raise exception 'Visits per shift must be between 1 and 24' using errcode = 'P0001';
  end if;
  v_gap := coalesce(public.place_service_json_int(p_terms -> 'min_gap_minutes'),
    case when p_terms -> 'min_gap_minutes' is null then 60 end);
  if v_gap is null or v_gap < 0 or v_gap > 720 then
    raise exception 'Minimum gap must be between 0 and 720 minutes' using errcode = 'P0001';
  end if;
  -- The patrol config requires at least one minute on site for a scheduled visit.
  v_dwell := coalesce(public.place_service_json_int(p_terms -> 'dwell_minutes'),
    case when p_terms -> 'dwell_minutes' is null then 15 end);
  if v_dwell is null or v_dwell < 1 or v_dwell > 480 then
    raise exception 'Time on site must be between 1 and 480 minutes' using errcode = 'P0001';
  end if;

  -- Checks from the provider's active catalogue, in the order given, without repeats.
  v_active_checks := public.active_check_keys_for(v_agreement.provider_organization_id);
  if p_terms -> 'checks' is not null and jsonb_typeof(p_terms -> 'checks') <> 'null' then
    if jsonb_typeof(p_terms -> 'checks') <> 'array' then
      raise exception 'Unknown or inactive check: %', p_terms ->> 'checks' using errcode = 'P0001';
    end if;
    for v_check in select e from jsonb_array_elements(p_terms -> 'checks') e loop
      if jsonb_typeof(v_check) <> 'string' or not ((v_check #>> '{}') = any(v_active_checks)) then
        raise exception 'Unknown or inactive check: %', v_check #>> '{}' using errcode = 'P0001';
      end if;
      if not ((v_check #>> '{}') = any(v_checks)) then
        v_checks := v_checks || (v_check #>> '{}');
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'anchor', jsonb_build_object('site_id', v_site, 'zone_id', v_zone),
    'module_key', v_module,
    'days', v_days_out,
    'window', v_window_out,
    'months', to_jsonb(v_months),
    'visits_per_shift', v_visits,
    'min_gap_minutes', v_gap,
    'dwell_minutes', v_dwell,
    'checks', to_jsonb(v_checks),
    'officer_instructions', nullif(btrim(coalesce(p_terms ->> 'officer_instructions', '')), ''));
end;
$$;

COMMENT ON FUNCTION public.normalise_place_service_terms(uuid, uuid, jsonb) IS
  'Validates and normalises patrol service terms for one place of a location under an agreement: one anchor (site or area), an active visit module, fixed or random days, any/fixed/solar window (solar needs a place point), months, visits, gap, time on site and checks from the provider''s active catalogue.';

-- The approved version in force at a date; NULL when there is none or it ended the service.
CREATE OR REPLACE FUNCTION public.place_service_version_at(p_delivery_schedule_id uuid, p_date date)
RETURNS public.place_service_term_versions
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  select v.* from public.place_service_term_versions v
  where v.delivery_schedule_id = p_delivery_schedule_id
    and v.status = 'approved'
    and v.applied_effective_from <= p_date
  order by v.applied_effective_from desc, v.decided_at desc nulls last, v.requested_at desc
  limit 1
$$;

CREATE OR REPLACE FUNCTION public.place_service_terms_at(p_delivery_schedule_id uuid, p_date date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  select case when v.change_kind = 'end' then null else v.terms end
  from public.place_service_version_at(p_delivery_schedule_id, p_date) v
  where v.id is not null
$$;

COMMENT ON FUNCTION public.place_service_terms_at(uuid, date) IS
  'Terms of the approved version in force for a delivery schedule on a date (latest applied_effective_from on or before the date; ties by latest decision). NULL when none applies or the service was ended.';

-- Terms read back from the live schedule and config, for schedules that predate versions.
CREATE OR REPLACE FUNCTION public.place_service_live_terms(p_delivery_schedule_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  select jsonb_build_object(
    'anchor', jsonb_build_object('site_id', s.site_id, 'zone_id', s.zone_id),
    'module_key', coalesce(sam.module_key, s.module_key),
    'days', jsonb_build_object('mode', 'fixed', 'weekdays', to_jsonb(s.active_days)),
    'window', case
      when c.time_window_type = 'sunrise_sunset' then jsonb_build_object('mode', 'solar',
        'start', jsonb_build_object('anchor', 'sunset', 'offset_hours', trim_scale(c.sunset_offset_minutes / 60.0)),
        'end', jsonb_build_object('anchor', 'sunrise', 'offset_hours', trim_scale(c.sunrise_offset_minutes / 60.0)))
      when s.window_start is not null then jsonb_build_object('mode', 'fixed',
        'start', to_char(s.window_start, 'HH24:MI'), 'end', to_char(s.window_end, 'HH24:MI'))
      else jsonb_build_object('mode', 'any') end,
    'months', to_jsonb(s.active_months),
    'visits_per_shift', s.visits_per_shift,
    'min_gap_minutes', s.min_gap_between_visits_minutes,
    'dwell_minutes', s.dwell_minutes,
    'checks', coalesce(c.required_actions, '[]'::jsonb),
    'officer_instructions', s.officer_instructions)
  from public.service_agreement_delivery_schedules s
  left join public.client_site_patrol_config c on c.delivery_schedule_id = s.id
  left join lateral (
    select m.module_key from public.service_agreement_modules m
    where m.service_agreement_id = s.service_agreement_id
      and m.module_key = any(array[s.module_key, case when s.module_key = 'general_patrol' then 'patrol' end])
    order by (m.module_key = s.module_key) limit 1
  ) sam on true
  where s.id = p_delivery_schedule_id
$$;

-- Random days: the allowed days ordered by an HMAC of the ISO week and day under the
-- schedule's secret seed; the first per_week, sorted. NULL when the schedule has no seed.
CREATE OR REPLACE FUNCTION public.place_service_drawn_days(p_delivery_schedule_id uuid, p_date date, p_allowed integer[], p_per_week integer)
RETURNS integer[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  select (
    select coalesce(array_agg(d order by d), array[]::integer[])
    from (
      select d from unnest(p_allowed) d
      order by extensions.hmac(convert_to(extract(isoyear from p_date)::int || '-' || extract(week from p_date)::int || '-' || d, 'UTF8'),
        s.seed, 'sha256')
      limit greatest(coalesce(p_per_week, 0), 0)
    ) drawn
  )
  from public.patrol_schedule_draw_seeds s
  where s.delivery_schedule_id = p_delivery_schedule_id
$$;

COMMENT ON FUNCTION public.place_service_drawn_days(uuid, date, integer[], integer) IS
  'The ISO weekdays drawn for the ISO week containing the date: allowed days ordered by HMAC-SHA256(isoyear-week-day) under the schedule''s secret seed, first per_week, sorted. Deterministic per week; NULL when the schedule has no seed.';

-- Does the service run on this date (days and months)? NULL when random days cannot be drawn yet.
CREATE OR REPLACE FUNCTION public.place_service_runs_on(p_terms jsonb, p_delivery_schedule_id uuid, p_date date)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_months integer[] := coalesce(public.place_service_json_int_array(p_terms -> 'months'), array[]::integer[]);
  v_drawn integer[];
begin
  if p_terms is null then
    return false;
  end if;
  if cardinality(v_months) > 0 and not (extract(month from p_date)::int = any(v_months)) then
    return false;
  end if;
  if p_terms -> 'days' ->> 'mode' = 'random' then
    v_drawn := public.place_service_drawn_days(p_delivery_schedule_id, p_date,
      public.place_service_json_int_array(p_terms -> 'days' -> 'allowed'),
      public.place_service_json_int(p_terms -> 'days' -> 'per_week'));
    if v_drawn is null then
      return null;
    end if;
    return extract(isodow from p_date)::int = any(v_drawn);
  end if;
  return extract(isodow from p_date)::int = any(public.place_service_json_int_array(p_terms -> 'days' -> 'weekdays'));
end;
$$;

CREATE OR REPLACE FUNCTION public.place_service_window_endpoint(p_endpoint jsonb, p_date date, p_point geometry)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_at timestamptz;
begin
  if p_endpoint ->> 'anchor' = 'clock' then
    return (p_date + (p_endpoint ->> 'time')::time) at time zone 'Pacific/Auckland';
  end if;
  if p_point is null then
    return null;
  end if;
  v_at := public.solar_event_at(p_date, ST_Y(p_point), ST_X(p_point), p_endpoint ->> 'anchor');
  return v_at + make_interval(mins => round(coalesce((p_endpoint ->> 'offset_hours')::numeric, 0) * 60)::int);
end;
$$;

CREATE OR REPLACE FUNCTION public.place_service_window_at(p_terms jsonb, p_date date, p_point geometry,
  p_shift_start timestamptz, p_shift_end timestamptz)
RETURNS TABLE(window_open timestamptz, window_close timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_open timestamptz;
  v_close timestamptz;
  v_prev_open timestamptz;
  v_prev_close timestamptz;
begin
  if p_terms -> 'window' ->> 'mode' = 'fixed' then
    return query select b.window_open, b.window_close
      from public.patrol_window_bounds(p_date, (p_terms -> 'window' ->> 'start')::time, (p_terms -> 'window' ->> 'end')::time,
        p_shift_start, p_shift_end) b;
    return;
  end if;
  if p_terms -> 'window' ->> 'mode' is distinct from 'solar' then
    return query select null::timestamptz, null::timestamptz;
    return;
  end if;
  -- Each night's window is resolved from its own local date, so a DST change or a different
  -- sunset the night before is honoured. The end rolls to the next local date when it is not
  -- after the start.
  v_open := public.place_service_window_endpoint(p_terms -> 'window' -> 'start', p_date, p_point);
  v_close := public.place_service_window_endpoint(p_terms -> 'window' -> 'end', p_date, p_point);
  if v_open is not null and v_close is not null and v_close <= v_open then
    v_close := public.place_service_window_endpoint(p_terms -> 'window' -> 'end', p_date + 1, p_point);
  end if;
  if v_open is null or v_close is null then
    v_open := null;
    v_close := null;
  end if;
  -- Same rule as patrol_window_bounds: a shift that only meets last night's window uses it.
  if p_shift_start is not null and p_shift_end is not null
     and not (v_open is not null and v_open < p_shift_end and p_shift_start < v_close) then
    v_prev_open := public.place_service_window_endpoint(p_terms -> 'window' -> 'start', p_date - 1, p_point);
    v_prev_close := public.place_service_window_endpoint(p_terms -> 'window' -> 'end', p_date - 1, p_point);
    if v_prev_open is not null and v_prev_close is not null and v_prev_close <= v_prev_open then
      v_prev_close := public.place_service_window_endpoint(p_terms -> 'window' -> 'end', p_date, p_point);
    end if;
    if v_prev_open is not null and v_prev_close is not null
       and v_prev_open < p_shift_end and p_shift_start < v_prev_close then
      v_open := v_prev_open;
      v_close := v_prev_close;
    end if;
  end if;
  if v_open is null or v_close is null then
    -- No window that day (polar night or midnight sun): no row, unlike 'any'.
    return;
  end if;
  return query select v_open, v_close;
end;
$$;

COMMENT ON FUNCTION public.place_service_window_at(jsonb, date, geometry, timestamptz, timestamptz) IS
  'Window for service terms on a local date: any = one row of NULLs (no limit); fixed = patrol_window_bounds; solar = sunrise/sunset at the place point plus offsets, or a clock time, in Pacific/Auckland, the end rolling to the next local date when it is not after the start. A shift that only meets the previous night''s window gets that window, resolved from the previous local date. Returns no row when the sun does not rise or set that day (and no previous-night window applies): the service has no window then, which is not the same as any time.';

-- Regenerates pending stops for a config on unlocked shifts from a date.
CREATE OR REPLACE FUNCTION public.place_service_regenerate_stops(p_config_id uuid, p_from date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_config public.client_site_patrol_config%rowtype;
  v_shift record;
  v_count integer := 0;
begin
  select * into v_config from public.client_site_patrol_config c where c.id = p_config_id;
  if not found then
    return 0;
  end if;
  for v_shift in
    select s.id, (s.scheduled_start at time zone 'Pacific/Auckland')::date as shift_date
    from public.shifts s
    where s.organization_id = v_config.organization_id
      and s.status <> 'cancelled'
      and (s.scheduled_start at time zone 'Pacific/Auckland')::date >= p_from
      and (public.patrol_config_serves(v_config.id, (s.scheduled_start at time zone 'Pacific/Auckland')::date,
             s.patrol_route_id, public.patrol_shift_work_unit_id(s.id))
           or exists (select 1 from public.shift_stops st where st.shift_id = s.id and st.patrol_config_id = v_config.id))
      and public.patrol_shift_plan_locked_reason(s.id) is null
    order by s.scheduled_start, s.id
  loop
    perform public.generate_shift_stops_internal(v_shift.id, v_shift.shift_date, v_config.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Projects the approved version in force today onto the live schedule and config. Returns
-- true when anything changed (and stops were regenerated).
CREATE OR REPLACE FUNCTION public.place_service_project_schedule(p_delivery_schedule_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_today date := public.place_service_today();
  v_version public.place_service_term_versions%rowtype;
  v_schedule public.service_agreement_delivery_schedules%rowtype;
  v_config public.client_site_patrol_config%rowtype;
  v_terms jsonb;
  v_map record;
  v_site uuid;
  v_zone uuid;
  v_days integer[];
  v_months integer[];
  v_wstart time;
  v_wend time;
  v_window_type text;
  v_sunrise integer := 0;
  v_sunset integer := 0;
  v_instructions text;
  v_changed boolean := false;
  v_rows integer;
  v_module_id uuid;
  v_sal_id uuid;
  v_enabled text[];
begin
  select * into v_schedule from public.service_agreement_delivery_schedules s where s.id = p_delivery_schedule_id for update;
  if not found then
    return false;
  end if;
  select * into v_version from public.place_service_version_at(p_delivery_schedule_id, v_today);
  if v_version.id is null then
    return false;
  end if;
  select * into v_config from public.client_site_patrol_config c where c.delivery_schedule_id = v_schedule.id for update;

  if v_version.change_kind = 'end' then
    update public.service_agreement_delivery_schedules set active = false where id = v_schedule.id and active;
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;
    if v_config.id is not null then
      update public.client_site_patrol_config set active = false, updated_at = clock_timestamp()
      where id = v_config.id and active;
      get diagnostics v_rows = row_count;
      v_changed := v_changed or v_rows > 0;
    end if;
  else
    v_terms := v_version.terms;
    select * into v_map from public.place_service_module_mapping(v_terms ->> 'module_key');
    v_site := nullif(v_terms -> 'anchor' ->> 'site_id', '')::uuid;
    v_zone := nullif(v_terms -> 'anchor' ->> 'zone_id', '')::uuid;
    v_days := case when v_terms -> 'days' ->> 'mode' = 'random'
      then public.place_service_json_int_array(v_terms -> 'days' -> 'allowed')
      else public.place_service_json_int_array(v_terms -> 'days' -> 'weekdays') end;
    v_months := coalesce(public.place_service_json_int_array(v_terms -> 'months'), array[]::integer[]);
    if v_terms -> 'window' ->> 'mode' = 'fixed' then
      v_wstart := (v_terms -> 'window' ->> 'start')::time;
      v_wend := (v_terms -> 'window' ->> 'end')::time;
    end if;
    v_window_type := case when v_terms -> 'window' ->> 'mode' = 'solar' then 'sunrise_sunset' else 'fixed' end;
    if v_window_type = 'sunrise_sunset' then
      select coalesce(max(round((e ->> 'offset_hours')::numeric * 60)::int) filter (where e ->> 'anchor' = 'sunrise'), 0),
             coalesce(max(round((e ->> 'offset_hours')::numeric * 60)::int) filter (where e ->> 'anchor' = 'sunset'), 0)
        into v_sunrise, v_sunset
      from (values (v_terms -> 'window' -> 'start'), (v_terms -> 'window' -> 'end')) w(e);
    end if;
    v_instructions := nullif(btrim(coalesce(v_terms ->> 'officer_instructions', '')), '');

    update public.service_agreement_delivery_schedules s
    set site_id = v_site, zone_id = v_zone, module_key = v_map.toolset_key, capability_key = v_map.capability_key,
        work_model = case when v_map.capability_key = 'alarm_response' then 'on_demand_callout' else 'scheduled_patrol' end,
        active_days = v_days, active_months = v_months,
        visits_per_shift = (v_terms ->> 'visits_per_shift')::int,
        min_gap_between_visits_minutes = (v_terms ->> 'min_gap_minutes')::int,
        window_start = v_wstart, window_end = v_wend,
        dwell_minutes = (v_terms ->> 'dwell_minutes')::int,
        officer_instructions = v_instructions, active = true
    where s.id = v_schedule.id
      and (s.site_id, s.zone_id, s.module_key, s.capability_key, s.work_model, s.active_days, s.active_months,
           s.visits_per_shift, s.min_gap_between_visits_minutes, s.window_start, s.window_end, s.dwell_minutes,
           s.officer_instructions, s.active)
        is distinct from
          (v_site, v_zone, v_map.toolset_key, v_map.capability_key,
           case when v_map.capability_key = 'alarm_response' then 'on_demand_callout' else 'scheduled_patrol' end,
           v_days, v_months, (v_terms ->> 'visits_per_shift')::int, (v_terms ->> 'min_gap_minutes')::int,
           v_wstart, v_wend, (v_terms ->> 'dwell_minutes')::int, v_instructions, true);
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;

    if v_config.id is not null then
      update public.client_site_patrol_config c
      set site_id = v_site, zone_id = v_zone, module_key = v_map.config_module_key, active_days = v_days,
          active_months = v_months, visits_per_shift = (v_terms ->> 'visits_per_shift')::int,
          min_gap_between_visits_minutes = (v_terms ->> 'min_gap_minutes')::int,
          time_window_type = v_window_type, window_start = v_wstart, window_end = v_wend,
          sunrise_offset_minutes = v_sunrise, sunset_offset_minutes = v_sunset,
          dwell_minutes = (v_terms ->> 'dwell_minutes')::int, officer_instructions = v_instructions,
          required_actions = coalesce(v_terms -> 'checks', '[]'::jsonb), active = true, updated_at = clock_timestamp()
      where c.id = v_config.id
        and (c.site_id, c.zone_id, c.module_key, c.active_days, c.active_months, c.visits_per_shift,
             c.min_gap_between_visits_minutes, c.time_window_type, c.window_start, c.window_end,
             c.sunrise_offset_minutes, c.sunset_offset_minutes, c.dwell_minutes, c.officer_instructions,
             c.required_actions, c.active)
          is distinct from
            (v_site, v_zone, v_map.config_module_key, v_days, v_months, (v_terms ->> 'visits_per_shift')::int,
             (v_terms ->> 'min_gap_minutes')::int, v_window_type, v_wstart, v_wend, v_sunrise, v_sunset,
             (v_terms ->> 'dwell_minutes')::int, v_instructions, coalesce(v_terms -> 'checks', '[]'::jsonb), true);
      get diagnostics v_rows = row_count;
      v_changed := v_changed or v_rows > 0;
    end if;

    -- The module and the place are on the agreement from the date the terms take effect, and
    -- the stop carries this service's toolset under them (matched alias-aware: schedules store
    -- general_patrol, agreements patrol).
    select m.id into v_module_id from public.service_agreement_modules m
    where m.service_agreement_id = v_schedule.service_agreement_id
      and m.module_key = any(array[v_terms ->> 'module_key', v_map.toolset_key,
        case when v_map.toolset_key = 'general_patrol' then 'patrol' end])
    order by (m.module_key = v_terms ->> 'module_key') desc, m.enabled desc
    limit 1;
    if v_module_id is null then
      insert into public.service_agreement_modules(service_agreement_id, module_key, enabled)
      values (v_schedule.service_agreement_id, v_terms ->> 'module_key', true)
      on conflict (service_agreement_id, module_key) do update set enabled = true
      returning id into v_module_id;
    else
      update public.service_agreement_modules set enabled = true where id = v_module_id and not enabled;
    end if;
    v_enabled := coalesce((select array_agg(sam.module_key order by sam.module_key)
      from public.service_agreement_modules sam where sam.service_agreement_id = v_schedule.service_agreement_id and sam.enabled), '{}');
    update public.service_agreements set enabled_modules = v_enabled
    where id = v_schedule.service_agreement_id and enabled_modules is distinct from v_enabled;

    select l.id into v_sal_id from public.service_agreement_locations l
    where l.service_agreement_id = v_schedule.service_agreement_id and l.status = 'active'
      and l.site_id is not distinct from v_site and l.zone_id is not distinct from v_zone
    limit 1;
    if v_sal_id is null then
      insert into public.service_agreement_locations(service_agreement_id, site_id, zone_id, status, created_by)
      values (v_schedule.service_agreement_id, v_site, v_zone, 'active', v_version.requested_by)
      returning id into v_sal_id;
    end if;

    if v_config.id is not null then
      -- Retire the toolset this service carried before (from the schedule or an earlier
      -- version); other modules added to the stop elsewhere are left alone.
      update public.patrol_route_stop_modules m set active = false, updated_at = clock_timestamp()
      where m.patrol_config_id = v_config.id and m.active and m.module_key <> v_map.toolset_key
        and (m.module_key = v_schedule.module_key
             or m.module_key in (select t.toolset_key from public.place_service_term_versions pv
                                 cross join lateral public.place_service_module_mapping(pv.terms ->> 'module_key') t
                                 where pv.delivery_schedule_id = v_schedule.id and pv.status = 'approved'));
      get diagnostics v_rows = row_count;
      v_changed := v_changed or v_rows > 0;
      insert into public.patrol_route_stop_modules as m(organization_id, patrol_config_id, module_key,
        service_agreement_module_id, service_agreement_location_id)
      values (v_config.organization_id, v_config.id, v_map.toolset_key, v_module_id, v_sal_id)
      on conflict (patrol_config_id, module_key) do update
        set active = true, service_agreement_module_id = excluded.service_agreement_module_id,
            service_agreement_location_id = excluded.service_agreement_location_id, updated_at = clock_timestamp()
        where (m.active, m.service_agreement_module_id, m.service_agreement_location_id)
          is distinct from (true, excluded.service_agreement_module_id, excluded.service_agreement_location_id);
      get diagnostics v_rows = row_count;
      v_changed := v_changed or v_rows > 0;
    end if;
  end if;

  if v_changed and v_config.id is not null then
    perform public.place_service_regenerate_stops(v_config.id, v_today);
  end if;
  return v_changed;
end;
$$;

-- Creates the schedule and patrol config of a new service, inactive until its terms are
-- projected on the effective date. Called before the version that names it is recorded.
CREATE OR REPLACE FUNCTION public.place_service_create_schedule(p_agreement_id uuid, p_terms jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_agreement public.service_agreements%rowtype;
  v_map record;
  v_site uuid := nullif(p_terms -> 'anchor' ->> 'site_id', '')::uuid;
  v_zone uuid := nullif(p_terms -> 'anchor' ->> 'zone_id', '')::uuid;
  v_days integer[] := coalesce(public.place_service_json_int_array(p_terms -> 'days' -> 'weekdays'),
    public.place_service_json_int_array(p_terms -> 'days' -> 'allowed'));
  v_months integer[] := coalesce(public.place_service_json_int_array(p_terms -> 'months'), array[]::integer[]);
  v_instructions text := nullif(btrim(coalesce(p_terms ->> 'officer_instructions', '')), '');
  v_schedule_id uuid;
begin
  select * into v_agreement from public.service_agreements a where a.id = p_agreement_id;
  if not found then
    raise exception 'Service agreement not found' using errcode = 'P0002';
  end if;
  select * into v_map from public.place_service_module_mapping(p_terms ->> 'module_key');
  insert into public.service_agreement_delivery_schedules(service_agreement_id, site_id, zone_id, module_key, capability_key,
    work_model, active_days, active_months, visits_per_shift, min_gap_between_visits_minutes, window_start, window_end,
    dwell_minutes, preferred_stop_order, pricing_basis, officer_instructions, active)
  values (v_agreement.id, v_site, v_zone, v_map.toolset_key, v_map.capability_key,
    case when v_map.capability_key = 'alarm_response' then 'on_demand_callout' else 'scheduled_patrol' end,
    v_days, v_months, (p_terms ->> 'visits_per_shift')::int, (p_terms ->> 'min_gap_minutes')::int, null, null,
    (p_terms ->> 'dwell_minutes')::int, 0, 'standard_rate_rule', v_instructions, false)
  returning id into v_schedule_id;
  if v_map.capability_key <> 'alarm_response' then
    insert into public.client_site_patrol_config(organization_id, site_id, zone_id, module_key, active_days, visits_per_shift,
      min_gap_between_visits_minutes, time_window_type, active_months, dwell_minutes, sla_arrive_within_minutes,
      sla_depart_within_minutes, preferred_stop_order, officer_instructions, required_actions, delivery_schedule_id, active)
    values (v_agreement.provider_organization_id, v_site, v_zone, v_map.config_module_key, v_days,
      (p_terms ->> 'visits_per_shift')::int, (p_terms ->> 'min_gap_minutes')::int, 'fixed', v_months,
      (p_terms ->> 'dwell_minutes')::int, 30, 45, 0, v_instructions, coalesce(p_terms -> 'checks', '[]'::jsonb),
      v_schedule_id, false);
  end if;
  insert into public.patrol_schedule_draw_seeds(delivery_schedule_id) values (v_schedule_id)
  on conflict (delivery_schedule_id) do nothing;
  return v_schedule_id;
end;
$$;

COMMENT ON FUNCTION public.place_service_create_schedule(uuid, jsonb) IS
  'Creates the inactive delivery schedule, patrol config and draw seed for a new place service from normalised terms. The agreement module, agreement place and stop module follow when the terms are projected on their effective date.';

CREATE OR REPLACE FUNCTION public.apply_place_service_version(p_version_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_version public.place_service_term_versions%rowtype;
  v_projected boolean := false;
begin
  select * into v_version from public.place_service_term_versions v where v.id = p_version_id;
  if not found then
    raise exception 'Change not found' using errcode = 'P0002';
  end if;
  if v_version.status <> 'approved' then
    raise exception 'Only approved changes can be applied' using errcode = 'P0001';
  end if;
  if v_version.service_kind <> 'patrol' then
    raise exception 'Static guarding terms are applied by apply_place_static_post_version' using errcode = 'P0001';
  end if;
  if v_version.delivery_schedule_id is null then
    raise exception 'This change has no service schedule' using errcode = 'P0001';
  end if;
  insert into public.patrol_schedule_draw_seeds(delivery_schedule_id) values (v_version.delivery_schedule_id)
  on conflict (delivery_schedule_id) do nothing;
  -- Everything that changes what a stop generates waits for the effective date (the roll).
  if v_version.applied_effective_from <= public.place_service_today() then
    v_projected := public.place_service_project_schedule(v_version.delivery_schedule_id);
  end if;
  return jsonb_build_object('version_id', v_version.id, 'delivery_schedule_id', v_version.delivery_schedule_id,
    'applied_effective_from', v_version.applied_effective_from, 'projected', v_projected);
end;
$$;

COMMENT ON FUNCTION public.apply_place_service_version(uuid) IS
  'Applies an approved patrol version whose schedule already exists: ensures the draw seed and, when the version is due, projects the terms (schedule, config, agreement module and place, stop module) onto the live rows. Future versions are projected by roll_place_service_terms on their date.';

CREATE OR REPLACE FUNCTION public.roll_place_service_terms()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_today date := public.place_service_today();
  v_schedule uuid;
  v_count integer := 0;
begin
  -- A week of look-back so a missed run still brings the live rows up to date.
  for v_schedule in
    select distinct v.delivery_schedule_id from public.place_service_term_versions v
    where v.status = 'approved' and v.delivery_schedule_id is not null
      and v.applied_effective_from between v_today - 7 and v_today
    order by 1
  loop
    if public.place_service_project_schedule(v_schedule) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

COMMENT ON FUNCTION public.roll_place_service_terms() IS
  'Hourly: projects approved versions that took effect in the last seven days onto the live schedule and config. Returns the number of schedules that changed.';

-- Internal grants.
DO $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.place_service_today()',
    'public.place_service_json_int(jsonb)',
    'public.place_service_json_int_array(jsonb)',
    'public.place_service_json_time(jsonb)',
    'public.place_service_module_mapping(text)',
    'public.place_service_normalise_endpoint(jsonb)',
    'public.normalise_place_service_terms(uuid, uuid, jsonb)',
    'public.place_service_version_at(uuid, date)',
    'public.place_service_terms_at(uuid, date)',
    'public.place_service_live_terms(uuid)',
    'public.place_service_drawn_days(uuid, date, integer[], integer)',
    'public.place_service_runs_on(jsonb, uuid, date)',
    'public.place_service_window_endpoint(jsonb, date, geometry)',
    'public.place_service_window_at(jsonb, date, geometry, timestamptz, timestamptz)',
    'public.place_service_regenerate_stops(uuid, date)',
    'public.place_service_project_schedule(uuid)',
    'public.place_service_create_schedule(uuid, jsonb)',
    'public.apply_place_service_version(uuid)',
    'public.roll_place_service_terms()'
  ] loop
    execute format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    execute format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  end loop;
end;
$$;

-- Authenticated RPCs.

CREATE OR REPLACE FUNCTION public.get_place_services(p_location_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_actor uuid := auth.uid();
  v_today date := public.place_service_today();
  v_location public.locations%rowtype;
  v_agreement_ids uuid[];
  v_provider uuid;
  v_agreements jsonb;
  v_services jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select * into v_location from public.locations l where l.id = p_location_id;
  if not found then
    raise exception 'Location not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(a.id order by a.name, a.id), array[]::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'provider_organization_id', a.provider_organization_id, 'name', a.name)
           order by a.name, a.id), '[]'::jsonb),
         (array_agg(a.provider_organization_id order by a.name, a.id))[1]
    into v_agreement_ids, v_agreements, v_provider
  from public.service_agreements a
  where a.client_organization_id = v_location.organization_id
    and a.agreement_type = 'operational'
    and (a.ends_on is null or a.ends_on >= v_today)
    and public.is_admin_for_org(a.provider_organization_id);
  if cardinality(v_agreement_ids) = 0 then
    return jsonb_build_object('location', null, 'anchors', '[]'::jsonb, 'agreements', '[]'::jsonb, 'services', '[]'::jsonb,
      'modules', '[]'::jsonb, 'check_types', '[]'::jsonb, 'inactive_check_types', '[]'::jsonb, 'seasons', '[]'::jsonb, 'operating_branches', '[]'::jsonb,
      'settings', null, 'can_manage', false);
  end if;

  with schedules as (
    select s.*, c.id as config_id, public.place_service_version_at(s.id, v_today) as current_version
    from public.service_agreement_delivery_schedules s
    left join public.client_site_patrol_config c on c.delivery_schedule_id = s.id
    left join public.client_sites cs on cs.id = s.site_id
    left join public.location_zones z on z.id = s.zone_id
    where s.service_agreement_id = any(v_agreement_ids)
      and coalesce(cs.location_id, z.location_id) = p_location_id
      and (s.active
        or exists (select 1 from public.place_service_term_versions v where v.delivery_schedule_id = s.id
          and (v.status = 'pending' or (v.status = 'approved' and v.applied_effective_from > v_today))))
  ), items as (
    select s.created_at as sort_at, jsonb_build_object(
      'delivery_schedule_id', s.id,
      'service_agreement_id', s.service_agreement_id,
      'service_kind', coalesce((s.current_version).service_kind, 'patrol'),
      'module_key', coalesce(t.terms ->> 'module_key', s.module_key),
      'anchor', jsonb_build_object('site_id', s.site_id, 'zone_id', s.zone_id),
      'active', s.active,
      'terms', t.terms,
      'effective_from', (s.current_version).applied_effective_from,
      'pending', (select jsonb_build_object('version_id', v.id, 'change_kind', v.change_kind, 'effective_from', v.effective_from,
          'terms', v.terms, 'requested_by', v.requested_by, 'requested_by_name', up.display_name)
        from public.place_service_term_versions v left join public.user_profiles up on up.id = v.requested_by
        where v.delivery_schedule_id = s.id and v.status = 'pending' limit 1),
      'responsibility', (select jsonb_build_object('work_unit_id', r.work_unit_id, 'work_unit_name', u.name,
          'patrol_route_id', r.patrol_route_id, 'effective_from', r.effective_from)
        from public.patrol_config_responsibilities r left join public.roster_work_units u on u.id = r.work_unit_id
        where r.patrol_config_id = s.config_id and r.superseded_at is null and r.effective_from <= v_today
          and (r.effective_to is null or r.effective_to >= v_today)
        order by r.effective_from desc limit 1),
      'work_unit', (select jsonb_build_object('id', u.id, 'name', u.name, 'active', u.active)
        from public.roster_work_units u where u.id = (s.current_version).work_unit_id)) as item
    from schedules s
    cross join lateral (select coalesce(case when (s.current_version).id is not null and (s.current_version).change_kind <> 'end'
      then (s.current_version).terms end, public.place_service_live_terms(s.id)) as terms) t
    union all
    -- Pending new services have no schedule yet.
    select v.requested_at, jsonb_build_object(
      'delivery_schedule_id', null, 'service_agreement_id', v.service_agreement_id, 'service_kind', v.service_kind,
      'module_key', v.terms ->> 'module_key', 'anchor', v.terms -> 'anchor', 'active', false, 'terms', null, 'effective_from', null,
      'pending', jsonb_build_object('version_id', v.id, 'change_kind', v.change_kind, 'effective_from', v.effective_from,
        'terms', v.terms, 'requested_by', v.requested_by, 'requested_by_name', up.display_name),
      'responsibility', null, 'work_unit', null)
    from public.place_service_term_versions v left join public.user_profiles up on up.id = v.requested_by
    where v.location_id = p_location_id and v.status = 'pending' and v.delivery_schedule_id is null
      and v.service_agreement_id = any(v_agreement_ids)
  )
  select coalesce(jsonb_agg(item order by sort_at, item ->> 'delivery_schedule_id'), '[]'::jsonb) into v_services from items;

  return jsonb_build_object(
    'location', jsonb_build_object('id', v_location.id, 'name', v_location.name, 'organization_id', v_location.organization_id),
    'anchors', coalesce((select jsonb_agg(a order by a ->> 'kind', a ->> 'name', a ->> 'id') from (
        select jsonb_build_object('kind', 'site', 'id', s.id, 'name', s.name,
          'has_point', public.place_anchor_point(s.id, null) is not null) as a
        from public.client_sites s
        where s.location_id = p_location_id and s.active and s.client_organization_id = v_location.organization_id
        union all
        select jsonb_build_object('kind', 'zone', 'id', z.id, 'name', z.name,
          'has_point', public.place_anchor_point(null, z.id) is not null)
        from public.location_zones z
        where z.location_id = p_location_id and z.is_active and not z.is_verification_point) x), '[]'::jsonb),
    'agreements', v_agreements,
    'services', v_services,
    'modules', coalesce((select jsonb_agg(jsonb_build_object('module_key', m.module_key, 'toolset_key', mm.toolset_key) order by m.module_key)
        from public.module_catalog m cross join lateral public.place_service_module_mapping(m.module_key) mm
        where m.active and (m.module_key = 'static_guarding' or mm.delivered_as_visits)), '[]'::jsonb),
    'check_types', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'check_key', t.check_key, 'label', t.label,
          'needs_photo', t.needs_photo, 'needs_note', t.needs_note, 'is_global', t.organization_id is null)
        order by t.organization_id nulls first, t.label)
        from public.patrol_check_types t where t.active and (t.organization_id is null or t.organization_id = v_provider)), '[]'::jsonb),
    'inactive_check_types', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'check_key', t.check_key, 'label', t.label,
          'needs_photo', t.needs_photo, 'needs_note', t.needs_note, 'is_global', false) order by t.label)
        from public.patrol_check_types t where not t.active and t.organization_id = v_provider), '[]'::jsonb),
    'seasons', coalesce((select jsonb_agg(jsonb_build_object('season_key', s.season_key, 'label', s.label, 'months', to_jsonb(s.months))
        order by s.sort_order) from public.place_service_seasons s), '[]'::jsonb),
    'operating_branches', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by (o.id = v_provider) desc, o.name)
        from public.organizations o where o.id = any(public.get_descendant_organizations(v_provider))), '[]'::jsonb),
    'settings', public.get_organization_operating_settings(v_provider),
    'can_manage', true);
end;
$$;

COMMENT ON FUNCTION public.get_place_services(uuid) IS
  'Place services workspace for a location: anchors (sites and areas, with whether a sunrise/sunset point exists), the live operational agreements whose provider the caller administers, the services on them with current terms, any pending change and the responsible run, plus modules, check types (and the provider''s own inactive check types, for reactivation), seasons, operating branches and the provider''s operating settings. A caller who administers no provider there gets can_manage false and empty lists.';

CREATE OR REPLACE FUNCTION public.preview_place_service_change(p_location_id uuid, p_agreement_id uuid,
  p_delivery_schedule_id uuid, p_change_kind text, p_terms jsonb, p_effective_from date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_actor uuid := auth.uid();
  v_today date := public.place_service_today();
  v_agreement public.service_agreements%rowtype;
  v_location public.locations%rowtype;
  v_schedule public.service_agreement_delivery_schedules%rowtype;
  v_config_id uuid;
  v_config_org uuid;
  v_terms jsonb;
  v_point geometry;
  v_needs_approval boolean;
  v_affected jsonb := '[]'::jsonb;
  v_blocked jsonb := '[]'::jsonb;
  v_next_days jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_has_seed boolean := false;
  v_has_responsibility boolean := false;
  v_day date;
  v_runs boolean;
  v_open timestamptz;
  v_close timestamptz;
  v_covered boolean;
  v_snapshot jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select * into v_agreement from public.service_agreements a where a.id = p_agreement_id;
  if not found then
    raise exception 'Service agreement not found' using errcode = 'P0002';
  end if;
  if not public.is_admin_for_org(v_agreement.provider_organization_id) then
    raise exception 'Provider administrator required' using errcode = '42501';
  end if;
  if v_agreement.agreement_type is distinct from 'operational' or (v_agreement.ends_on is not null and v_agreement.ends_on < v_today) then
    raise exception 'Only live operational agreements can carry a delivery schedule' using errcode = 'P0001';
  end if;
  select * into v_location from public.locations l where l.id = p_location_id;
  if not found or v_location.organization_id is distinct from v_agreement.client_organization_id then
    raise exception 'This agreement does not cover this location' using errcode = 'P0001';
  end if;
  if p_change_kind is null or p_change_kind not in ('create', 'update', 'end') then
    raise exception 'Choose create, update or end' using errcode = '22023';
  end if;
  -- Task 7 replaces this guard with static post terms.
  if p_terms ->> 'module_key' = 'static_guarding' or p_terms ->> 'service_kind' = 'static_guarding' then
    raise exception 'Static guarding terms are not available yet' using errcode = 'P0001';
  end if;
  if p_effective_from is null or p_effective_from < v_today then
    raise exception 'Effective from cannot be in the past' using errcode = 'P0001';
  end if;
  if (v_agreement.starts_on is not null and v_agreement.starts_on > p_effective_from)
     or (v_agreement.ends_on is not null and v_agreement.ends_on < p_effective_from) then
    raise exception 'Effective date is outside the approved agreement' using errcode = 'P0001';
  end if;

  if p_change_kind = 'create' then
    if p_delivery_schedule_id is not null then
      raise exception 'A new service cannot name an existing schedule' using errcode = '22023';
    end if;
  else
    select s.* into v_schedule from public.service_agreement_delivery_schedules s
    left join public.client_sites cs on cs.id = s.site_id
    left join public.location_zones z on z.id = s.zone_id
    where s.id = p_delivery_schedule_id and s.service_agreement_id = v_agreement.id
      and coalesce(cs.location_id, z.location_id) = p_location_id;
    if not found then
      raise exception 'Service not found at this location' using errcode = 'P0002';
    end if;
    if v_schedule.module_key = 'static_guarding' then
      raise exception 'Static guarding terms are not available yet' using errcode = 'P0001';
    end if;
    select c.id, c.organization_id into v_config_id, v_config_org
    from public.client_site_patrol_config c where c.delivery_schedule_id = v_schedule.id;
    v_has_seed := exists (select 1 from public.patrol_schedule_draw_seeds d where d.delivery_schedule_id = v_schedule.id);
  end if;

  if p_change_kind = 'end' then
    v_terms := coalesce(public.place_service_terms_at(v_schedule.id, v_today),
      (select v.terms from public.place_service_term_versions v where v.delivery_schedule_id = v_schedule.id
         and v.status = 'approved' and v.change_kind <> 'end'
       order by v.applied_effective_from desc, v.decided_at desc nulls last limit 1),
      public.place_service_live_terms(v_schedule.id));
  else
    v_terms := public.normalise_place_service_terms(v_agreement.id, p_location_id, p_terms);
  end if;
  -- One service of a kind per place and agreement: an existing (or scheduled) service is edited,
  -- and a create waiting for approval blocks another.
  if p_change_kind = 'create' and (
       exists (select 1 from public.service_agreement_delivery_schedules s
               where s.service_agreement_id = v_agreement.id
                 and s.site_id is not distinct from nullif(v_terms -> 'anchor' ->> 'site_id', '')::uuid
                 and s.zone_id is not distinct from nullif(v_terms -> 'anchor' ->> 'zone_id', '')::uuid
                 and s.module_key = (select t.toolset_key from public.place_service_module_mapping(v_terms ->> 'module_key') t)
                 and (s.active or exists (select 1 from public.place_service_term_versions v
                                          where v.delivery_schedule_id = s.id and v.status = 'approved'
                                            and v.change_kind <> 'end' and v.applied_effective_from > v_today)))
       or exists (select 1 from public.place_service_term_versions v
                  cross join lateral public.place_service_module_mapping(v.terms ->> 'module_key') t
                  where v.service_agreement_id = v_agreement.id and v.status = 'pending' and v.change_kind = 'create'
                    and v.terms -> 'anchor' = v_terms -> 'anchor'
                    and t.toolset_key = (select m.toolset_key from public.place_service_module_mapping(v_terms ->> 'module_key') m))) then
    raise exception 'This place already has that service; edit it instead' using errcode = 'P0001';
  end if;
  v_point := public.place_anchor_point(nullif(v_terms -> 'anchor' ->> 'site_id', '')::uuid,
    nullif(v_terms -> 'anchor' ->> 'zone_id', '')::uuid);
  v_needs_approval := coalesce((select s.place_changes_need_second_approver from public.organization_operating_settings s
    where s.organization_id = v_agreement.provider_organization_id), false);

  -- Unstarted shifts whose stops would be regenerated, and locked ones that keep their plan.
  if v_config_id is not null then
    select coalesce(jsonb_agg(item order by item ->> 'date', item ->> 'shift_id') filter (where reason is null), '[]'::jsonb),
           coalesce(jsonb_agg(jsonb_build_object('shift_id', item ->> 'shift_id', 'date', item ->> 'date', 'reason', reason)
             order by item ->> 'date', item ->> 'shift_id') filter (where reason is not null), '[]'::jsonb)
      into v_affected, v_blocked
    from (
      select public.patrol_shift_plan_locked_reason(s.id) as reason,
        jsonb_build_object('shift_id', s.id, 'date', (s.scheduled_start at time zone 'Pacific/Auckland')::date,
          'work_unit_name', u.name, 'scheduled_start', s.scheduled_start, 'scheduled_end', s.scheduled_end,
          'status', s.status, 'updated_at', s.updated_at) as item
      from public.shifts s
      left join public.roster_work_units u on u.id = public.patrol_shift_work_unit_id(s.id)
      where s.organization_id = v_config_org
        and s.status <> 'cancelled'
        and (s.scheduled_start at time zone 'Pacific/Auckland')::date >= p_effective_from
        and (public.patrol_config_serves(v_config_id, (s.scheduled_start at time zone 'Pacific/Auckland')::date,
               s.patrol_route_id, public.patrol_shift_work_unit_id(s.id))
             or exists (select 1 from public.shift_stops st where st.shift_id = s.id and st.patrol_config_id = v_config_id))
    ) candidates;
    v_has_responsibility := exists (select 1 from public.patrol_config_responsibilities r
      where r.patrol_config_id = v_config_id and r.superseded_at is null
        and (r.effective_to is null or r.effective_to >= p_effective_from));
  end if;

  -- The next 28 days from the effective date.
  for v_day in select generate_series(p_effective_from, p_effective_from + 27, interval '1 day')::date loop
    if p_change_kind = 'end' then
      v_runs := false;
    else
      v_runs := public.place_service_runs_on(v_terms, case when v_has_seed then v_schedule.id end, v_day);
    end if;
    v_open := null;
    v_close := null;
    if coalesce(v_runs, false) then
      select w.window_open, w.window_close into v_open, v_close
      from public.place_service_window_at(v_terms, v_day, v_point, null, null) w;
      if not found then
        -- No sunrise or sunset that day: nothing can be delivered.
        v_runs := false;
      end if;
    end if;
    v_covered := v_config_id is not null and exists (select 1 from public.shifts s
      where s.organization_id = v_config_org and s.status <> 'cancelled'
        and (s.scheduled_start at time zone 'Pacific/Auckland')::date = v_day
        and public.patrol_config_serves(v_config_id, v_day, s.patrol_route_id, public.patrol_shift_work_unit_id(s.id)));
    v_next_days := v_next_days || jsonb_build_object('date', v_day,
      'patrols', case when v_runs is null then null when v_runs then (v_terms ->> 'visits_per_shift')::int else 0 end,
      'window_open', v_open, 'window_close', v_close, 'covered', v_covered);
    if v_runs and not v_covered and v_has_responsibility then
      v_warnings := v_warnings || to_jsonb('No rostered shift for the responsible run on ' || to_char(v_day, 'YYYY-MM-DD'));
    end if;
  end loop;
  if p_change_kind <> 'end' and not v_has_responsibility then
    v_warnings := to_jsonb('No patrol run is responsible for this service yet'::text) || v_warnings;
  end if;
  if p_change_kind <> 'end' and v_terms -> 'days' ->> 'mode' = 'random' and not v_has_seed then
    v_warnings := v_warnings || to_jsonb('Random days are drawn once the service is saved'::text);
  end if;

  v_snapshot := jsonb_build_object('actor', v_actor, 'location', p_location_id, 'agreement', v_agreement.id,
    'schedule', p_delivery_schedule_id, 'change_kind', p_change_kind, 'terms', v_terms, 'effective_from', p_effective_from,
    'needs_approval', v_needs_approval, 'affected', v_affected, 'blocked', v_blocked,
    'latest_version', (select v.id from public.place_service_term_versions v
      where p_delivery_schedule_id is not null and v.delivery_schedule_id = p_delivery_schedule_id
      order by v.requested_at desc, v.id desc limit 1),
    'stop_modules', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb)
      from public.patrol_route_stop_modules m where m.patrol_config_id = v_config_id));

  return jsonb_build_object(
    'normalised_terms', v_terms,
    'applies_from', p_effective_from,
    'needs_approval', v_needs_approval,
    'affected', v_affected,
    'blocked', v_blocked,
    'next_days', v_next_days,
    'warnings', v_warnings,
    'preview_fingerprint', md5(v_snapshot::text));
end;
$$;

COMMENT ON FUNCTION public.preview_place_service_change(uuid, uuid, uuid, text, jsonb, date) IS
  'Previews a create, update or end of a place service as a provider administrator: normalised terms, whether a second approver is needed, unstarted shifts whose pending stops would be regenerated (affected) and locked ones (blocked), the next 28 days (patrols, window, covered by a rostered shift) and warnings. The preview_fingerprint must be passed to save_place_service_change.';

CREATE OR REPLACE FUNCTION public.save_place_service_change(p_client_request_id uuid, p_location_id uuid, p_agreement_id uuid,
  p_delivery_schedule_id uuid, p_change_kind text, p_terms jsonb, p_effective_from date, p_reason text, p_preview_fingerprint text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_existing public.place_service_term_versions%rowtype;
  v_request_fingerprint text;
  v_preview jsonb;
  v_needs_approval boolean;
  v_version_id uuid := gen_random_uuid();
  v_action_id uuid;
  v_status text;
  v_result jsonb;
  v_stored jsonb;
  v_version public.place_service_term_versions%rowtype;
  v_schedule_id uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'client_request_id is required' using errcode = '22023';
  end if;
  select * into v_agreement from public.service_agreements a where a.id = p_agreement_id;
  if not found then
    raise exception 'Service agreement not found' using errcode = 'P0002';
  end if;
  if not public.is_admin_for_org(v_agreement.provider_organization_id) then
    raise exception 'Provider administrator required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('place_service_change:' || p_client_request_id::text, 0));

  v_request_fingerprint := md5(jsonb_build_object('actor', v_actor, 'location', p_location_id, 'agreement', p_agreement_id,
    'schedule', p_delivery_schedule_id, 'change_kind', p_change_kind, 'terms', p_terms, 'effective_from', p_effective_from,
    'reason', v_reason)::text);

  -- Replay of the same request returns the first result; a different payload is refused.
  select * into v_existing from public.place_service_term_versions v where v.client_request_id = p_client_request_id;
  if found then
    if v_existing.requested_by is distinct from v_actor or v_existing.request_fingerprint is distinct from v_request_fingerprint then
      raise exception 'This request ID was already used for a different change' using errcode = '42501';
    end if;
    select a.metadata -> 'result' into v_stored from public.audit_log a
    where a.action in ('place_service_change_approved', 'place_service_change_pending', 'place_service_change_rejected')
      and a.metadata ->> 'kind' = 'save' and a.metadata ->> 'client_request_id' = p_client_request_id::text
    limit 1;
    return coalesce(v_stored, jsonb_build_object('version_id', v_existing.id, 'status', v_existing.status,
      'applied_effective_from', v_existing.applied_effective_from, 'delivery_schedule_id', v_existing.delivery_schedule_id))
      || jsonb_build_object('replayed', true);
  end if;

  if p_terms ->> 'module_key' = 'static_guarding' or p_terms ->> 'service_kind' = 'static_guarding' then
    raise exception 'Static guarding terms are not available yet' using errcode = 'P0001';
  end if;

  -- Serialise changes to one agreement and one service; creates also per place.
  perform 1 from public.service_agreements a where a.id = v_agreement.id for update;
  if p_change_kind = 'create' then
    perform pg_advisory_xact_lock(hashtextextended('place_service_create:' || v_agreement.id::text || ':'
      || coalesce(p_location_id::text, ''), 0));
  end if;
  if p_delivery_schedule_id is not null then
    perform 1 from public.service_agreement_delivery_schedules s where s.id = p_delivery_schedule_id for update;
    if exists (select 1 from public.place_service_term_versions v
               where v.delivery_schedule_id = p_delivery_schedule_id and v.status = 'pending') then
      raise exception 'A change to this service is already waiting for approval' using errcode = 'P0001';
    end if;
  end if;

  v_preview := public.preview_place_service_change(p_location_id, p_agreement_id, p_delivery_schedule_id, p_change_kind,
    p_terms, p_effective_from);
  if p_preview_fingerprint is null or v_preview ->> 'preview_fingerprint' is distinct from p_preview_fingerprint then
    raise exception 'Place services changed; reload and confirm a fresh preview' using errcode = '40001';
  end if;
  v_needs_approval := (v_preview ->> 'needs_approval')::boolean;

  if v_needs_approval then
    v_status := 'pending';
    insert into public.bob_agentic_actions(organization_id, user_id, triggered_by, action_type, status, proposed_payload,
      context_table, context_record_id, context_summary, idempotency_key)
    values (v_agreement.provider_organization_id, v_actor, v_actor, 'place_service_change', 'pending',
      jsonb_build_object('version_id', v_version_id, 'location_id', p_location_id, 'change_kind', p_change_kind,
        'effective_from', p_effective_from, 'terms', v_preview -> 'normalised_terms'),
      'place_service_term_versions', v_version_id,
      format('%s %s service at %s from %s', initcap(p_change_kind), coalesce(v_preview -> 'normalised_terms' ->> 'module_key', 'place'),
        (select l.name from public.locations l where l.id = p_location_id), p_effective_from),
      'place_service_change:' || p_client_request_id::text)
    returning id into v_action_id;
    insert into public.place_service_term_versions(id, organization_id, service_agreement_id, location_id, delivery_schedule_id,
      service_kind, change_kind, effective_from, terms, status, reason, requested_by, client_request_id, request_fingerprint,
      approval_action_id)
    values (v_version_id, v_agreement.provider_organization_id, v_agreement.id, p_location_id, p_delivery_schedule_id,
      'patrol', p_change_kind, p_effective_from, v_preview -> 'normalised_terms', 'pending', v_reason, v_actor,
      p_client_request_id, v_request_fingerprint, v_action_id);
  else
    v_status := 'approved';
    v_schedule_id := p_delivery_schedule_id;
    if p_change_kind = 'create' then
      v_schedule_id := public.place_service_create_schedule(v_agreement.id, v_preview -> 'normalised_terms');
    end if;
    insert into public.place_service_term_versions(id, organization_id, service_agreement_id, location_id, delivery_schedule_id,
      service_kind, change_kind, effective_from, applied_effective_from, terms, status, reason, requested_by, client_request_id,
      request_fingerprint, decided_by, decided_at)
    values (v_version_id, v_agreement.provider_organization_id, v_agreement.id, p_location_id, v_schedule_id,
      'patrol', p_change_kind, p_effective_from, p_effective_from, v_preview -> 'normalised_terms', 'approved', v_reason, v_actor,
      p_client_request_id, v_request_fingerprint, v_actor, clock_timestamp());
    perform public.apply_place_service_version(v_version_id);
  end if;

  select * into v_version from public.place_service_term_versions v where v.id = v_version_id;
  v_result := jsonb_build_object('version_id', v_version.id, 'status', v_version.status,
    'applied_effective_from', v_version.applied_effective_from, 'delivery_schedule_id', v_version.delivery_schedule_id);

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_agreement.provider_organization_id, v_actor, 'place_service_change_' || v_status, 'place_service_term_versions',
    v_version.id, jsonb_build_object('kind', 'save', 'client_request_id', p_client_request_id, 'version_id', v_version.id,
      'location_id', p_location_id, 'agreement_id', v_agreement.id, 'change_kind', p_change_kind,
      'effective_from', p_effective_from, 'result', v_result));

  return v_result;
end;
$$;

COMMENT ON FUNCTION public.save_place_service_change(uuid, uuid, uuid, uuid, text, jsonb, date, text, text) IS
  'Saves a create, update or end of a place service as a dated version after a fresh preview. With place_changes_need_second_approver on, the version waits as pending with a place_service_change approval action; otherwise it is approved and applied from its effective date. Audited as place_service_change_<status>; a replay of the same request ID with the same payload returns the first result.';

CREATE OR REPLACE FUNCTION public.decide_place_service_change(p_client_request_id uuid, p_version_id uuid, p_decision text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
declare
  v_actor uuid := auth.uid();
  v_version public.place_service_term_versions%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_stored public.audit_log%rowtype;
  v_status text;
  v_applied date;
  v_result jsonb;
  v_schedule_id uuid;
  v_work_unit_id uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'client_request_id is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('place_service_decision:' || p_client_request_id::text, 0));

  select * into v_stored from public.audit_log a
  where a.action in ('place_service_change_approved', 'place_service_change_rejected', 'place_service_change_withdrawn')
    and a.metadata ->> 'kind' = 'decision' and a.metadata ->> 'client_request_id' = p_client_request_id::text
  limit 1;
  if found then
    if v_stored.actor_user_id is distinct from v_actor or v_stored.metadata ->> 'version_id' is distinct from p_version_id::text
       or v_stored.metadata ->> 'decision' is distinct from p_decision then
      raise exception 'This request ID was already used for a different decision' using errcode = '42501';
    end if;
    return (v_stored.metadata -> 'result') || jsonb_build_object('replayed', true);
  end if;

  select * into v_version from public.place_service_term_versions v where v.id = p_version_id for update;
  if not found then
    raise exception 'Change not found' using errcode = 'P0002';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject', 'withdraw') then
    raise exception 'Choose approve, reject or withdraw' using errcode = '22023';
  end if;
  if p_decision = 'withdraw' then
    -- Only the person who asked can take a pending change back, while still an administrator there.
    if v_version.requested_by is distinct from v_actor or not public.is_admin_for_org(v_version.organization_id) then
      raise exception 'Only the person who asked for this change can withdraw it' using errcode = '42501';
    end if;
  else
    if not public.can_approve_action(v_actor, v_version.organization_id) then
      raise exception 'Not authorised to approve changes for this organisation' using errcode = '42501';
    end if;
    if v_version.requested_by = v_actor then
      raise exception 'You cannot approve your own change' using errcode = 'P0001';
    end if;
  end if;
  if v_version.status <> 'pending' then
    raise exception 'This change has already been decided' using errcode = 'P0001';
  end if;
  if p_decision = 'reject' and v_reason is null then
    raise exception 'Give a reason for rejecting this change' using errcode = 'P0001';
  end if;

  if p_decision = 'approve' then
    v_status := 'approved';
    v_applied := greatest(v_version.effective_from, public.place_service_today());
    v_schedule_id := v_version.delivery_schedule_id;
    if v_version.service_kind = 'static_guarding' then
      -- Task 7: creates or updates the post's work unit while the version is still pending and
      -- returns its id, recorded with the decision below.
      v_work_unit_id := public.apply_place_static_post_version(p_version_id);
    else
      -- The catalogue may have changed since the save: checks, places and modules must still be active.
      if v_version.change_kind <> 'end' then
        perform public.normalise_place_service_terms(v_version.service_agreement_id, v_version.location_id, v_version.terms);
      end if;
      if v_version.change_kind = 'create' and v_schedule_id is null then
        v_schedule_id := public.place_service_create_schedule(v_version.service_agreement_id, v_version.terms);
      end if;
    end if;
    update public.place_service_term_versions
    set status = 'approved', applied_effective_from = v_applied, decided_by = v_actor, decided_at = clock_timestamp(),
        decision_reason = v_reason, delivery_schedule_id = v_schedule_id,
        work_unit_id = coalesce(work_unit_id, v_work_unit_id)
    where id = v_version.id;
    if v_version.service_kind <> 'static_guarding' then
      perform public.apply_place_service_version(p_version_id);
    end if;
    select * into v_version from public.place_service_term_versions v where v.id = p_version_id;
    if v_version.approval_action_id is not null then
      update public.bob_agentic_actions
      set status = 'applied', approved_by = v_actor, approved_at = clock_timestamp(), applied_at = clock_timestamp(),
          result_record_id = v_version.id, result_table = 'place_service_term_versions'
      where id = v_version.approval_action_id;
    end if;
  elsif p_decision = 'withdraw' then
    v_status := 'withdrawn';
    update public.place_service_term_versions
    set status = 'withdrawn', decided_by = v_actor, decided_at = clock_timestamp(), decision_reason = v_reason
    where id = v_version.id;
    select * into v_version from public.place_service_term_versions v where v.id = p_version_id;
    if v_version.approval_action_id is not null then
      -- The approval queue has no withdrawn state; rejected takes it out of the queue.
      update public.bob_agentic_actions
      set status = 'rejected', rejection_reason = 'Withdrawn by the person who asked for it' || coalesce(': ' || v_reason, '')
      where id = v_version.approval_action_id;
    end if;
  else
    v_status := 'rejected';
    update public.place_service_term_versions
    set status = 'rejected', decided_by = v_actor, decided_at = clock_timestamp(), decision_reason = v_reason
    where id = v_version.id;
    select * into v_version from public.place_service_term_versions v where v.id = p_version_id;
    if v_version.approval_action_id is not null then
      update public.bob_agentic_actions set status = 'rejected', rejection_reason = v_reason
      where id = v_version.approval_action_id;
    end if;
  end if;

  v_result := jsonb_build_object('version_id', v_version.id, 'status', v_version.status,
    'applied_effective_from', v_version.applied_effective_from, 'delivery_schedule_id', v_version.delivery_schedule_id);
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_version.organization_id, v_actor, 'place_service_change_' || v_status, 'place_service_term_versions', v_version.id,
    jsonb_build_object('kind', 'decision', 'client_request_id', p_client_request_id, 'version_id', v_version.id,
      'decision', p_decision, 'location_id', v_version.location_id, 'agreement_id', v_version.service_agreement_id,
      'change_kind', v_version.change_kind, 'effective_from', v_version.effective_from, 'result', v_result));
  return v_result;
end;
$$;

COMMENT ON FUNCTION public.decide_place_service_change(uuid, uuid, text, text) IS
  'Approves or rejects a pending place service change as an approver other than the requester, or withdraws it as the administrator who asked for it. Approval applies the terms from the later of the requested date and today and marks the approval action applied; rejection needs a reason; withdrawal leaves the current service as it is and takes the approval action out of the queue. Audited as place_service_change_<status>; a replay of the same request ID returns the first result.';

REVOKE ALL ON FUNCTION public.get_place_services(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_place_services(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.preview_place_service_change(uuid, uuid, uuid, text, jsonb, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_place_service_change(uuid, uuid, uuid, text, jsonb, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_place_service_change(uuid, uuid, uuid, uuid, text, jsonb, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_place_service_change(uuid, uuid, uuid, uuid, text, jsonb, date, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.decide_place_service_change(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_place_service_change(uuid, uuid, text, text) TO authenticated, service_role;

-- The approval queue row is what the second approver reads, so the Data API roles must not be
-- able to forge, rewrite or close it; only the security-definer save and decide functions write it.
CREATE OR REPLACE FUNCTION public.guard_place_service_approval_actions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
begin
  if current_user in ('anon', 'authenticated')
     and ((tg_op <> 'INSERT' and old.action_type = 'place_service_change')
       or (tg_op <> 'DELETE' and new.action_type = 'place_service_change')) then
    raise exception 'Place service approvals can only change through their own functions' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

CREATE OR REPLACE TRIGGER guard_place_service_approval_actions
  BEFORE INSERT OR UPDATE OR DELETE ON public.bob_agentic_actions
  FOR EACH ROW EXECUTE FUNCTION public.guard_place_service_approval_actions();
REVOKE ALL ON FUNCTION public.guard_place_service_approval_actions() FROM PUBLIC, anon, authenticated;

-- Hourly roll of approved versions onto the live rows (skipped where pg_cron is absent).
DO $$
declare
  v_job bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    select jobid into v_job from cron.job where jobname = 'place-service-terms-roll' limit 1;
    if v_job is not null then
      perform cron.unschedule(v_job);
    end if;
    perform cron.schedule('place-service-terms-roll', '7 * * * *', 'SELECT public.roll_place_service_terms()');
  end if;
end;
$$;
