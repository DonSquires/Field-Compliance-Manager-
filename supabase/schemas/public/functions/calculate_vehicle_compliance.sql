create or replace function public.calculate_vehicle_compliance (
  p_plate   text,
  p_zone_id uuid,
  p_org_id  uuid
)
  returns jsonb
  language plpgsql
  stable
  security definer
  AS $function$
declare
  v_rules             zone_compliance_matrix%rowtype;
  v_zone              location_zones%rowtype;
  v_scv               canonical_scv%rowtype;
  v_streak            integer := 0;   -- current consecutive-night streak
  v_nights_month      integer := 0;   -- distinct verified nights this calendar month
  v_is_compliant      boolean := true;
  v_reason            text := 'compliant';
  v_month_start_date  date := date_trunc('month', current_date)::date;
  v_rule_type         text;
  v_scv_exempts       boolean := true;
begin
  -- Fetch zone rule_type + scv_exempts_restriction (0191).
  select * into v_zone from location_zones where id = p_zone_id;
  if found then
    v_rule_type   := coalesce(v_zone.rule_type, 'overnight_limited');
    v_scv_exempts := coalesce(v_zone.scv_exempts_restriction, true);
  else
    v_rule_type   := 'overnight_limited';
    v_scv_exempts := true;
  end if;

  -- ── GATE 1: prohibited / day_visit_only (unchanged from 0194) ────────────
  if v_rule_type in ('prohibited', 'day_visit_only') then
    select count(distinct overnight_date)
    into v_streak
    from vehicle_overnight_sessions
    where
      plate_number = p_plate
      and zone_id = p_zone_id
      and organization_id = p_org_id
      and verification_status = 'verified_overnight'
      and overnight_date >= v_month_start_date;

    if v_streak > 0 then
      return jsonb_build_object(
        'is_compliant',      false,
        'reason',            'no_overnight_permitted',
        'nights_this_zone',  v_streak,
        'nights_this_month', v_streak,
        'limit_consecutive', null,
        'limit_monthly',     null,
        'scv_required',      false,
        'is_scv',            false
      );
    end if;
    return jsonb_build_object(
      'is_compliant',      true,
      'reason',            'no_overnight_yet',
      'nights_this_zone',  0,
      'nights_this_month', 0,
      'limit_consecutive', null,
      'limit_monthly',     null,
      'scv_required',      false,
      'is_scv',            false
    );
  end if;

  -- ── GATE 2: restricted / SCV gate (unchanged from 0194) ──────────────────
  if v_rule_type = 'restricted' and v_scv_exempts then
    select * into v_scv
    from canonical_scv
    where
      plate_number = p_plate
      and certificate_status = 'active'
      and (expiry_date is null or expiry_date >= current_date);

    if not found then
      return jsonb_build_object(
        'is_compliant',      false,
        'reason',            'no_scv_certificate',
        'nights_this_zone',  0,
        'nights_this_month', 0,
        'limit_consecutive', null,
        'limit_monthly',     null,
        'scv_required',      true,
        'is_scv',            false
      );
    end if;
  end if;

  -- ── Night-count path (unrestricted / overnight_limited / restricted+SCV) ──

  -- Get current compliance rules.
  select * into v_rules
  from zone_compliance_matrix
  where
    zone_id = p_zone_id
    and organization_id = p_org_id
    and is_current = true
    and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by version desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'is_compliant', true,
      'reason', 'no_rules_configured',
      'nights_this_zone', 0,
      'nights_this_month', 0,
      'limit_consecutive', null,
      'limit_monthly', null,
      'scv_required', false,
      'is_scv', (v_scv.id is not null)
    );
  end if;

  -- SCV gate for overnight_limited zones (unchanged from 0194).
  if v_rule_type not in ('restricted') and v_rules.scv_required then
    if v_scv.id is null then
      select * into v_scv
      from canonical_scv
      where
        plate_number = p_plate
        and certificate_status = 'active'
        and (expiry_date is null or expiry_date >= current_date);

      if not found then
        return jsonb_build_object(
          'is_compliant', false,
          'reason', 'no_scv_certificate',
          'nights_this_zone', 0,
          'nights_this_month', 0,
          'limit_consecutive', v_rules.max_consecutive_nights,
          'limit_monthly', v_rules.max_nights_per_month,
          'scv_required', true,
          'is_scv', false
        );
      end if;
    end if;
  end if;

  -- ── COUNTER 1: consecutive streak (THE FIX) ──────────────────────────────
  -- Reads from vehicle_overnight_sessions for BOTH verification modes.
  -- For two_photo_verified: sessions created by the two-photo morning scan.
  -- For single_daily_observation: sessions created by process-officer-scan
  --   using the movement-check result (stationary -> verified_overnight).
  -- For historical import (#79): sessions with evidence_strength='inferred'.
  -- All three produce verified_overnight rows; the streak algorithm is identical.
  --
  -- Algorithm: subtract ROW_NUMBER() (as an interval) from each date.
  -- Consecutive dates produce the same anchor (streak_group); a gap of >=1
  -- day produces a different anchor. Current streak = count of dates in the
  -- group containing max(overnight_date). No cursor, no loop.
  with dated as (
    select distinct overnight_date
    from vehicle_overnight_sessions
    where
      plate_number = p_plate
      and zone_id = p_zone_id
      and organization_id = p_org_id
      and verification_status = 'verified_overnight'
  ),
  grouped as (
    select
      overnight_date,
      overnight_date
        - (row_number() over (order by overnight_date))::integer * interval '1 day'
        as streak_group
    from dated
  ),
  current_group as (
    select streak_group
    from grouped
    order by overnight_date desc
    limit 1
  )
  select coalesce(count(*), 0)
  into v_streak
  from grouped
  where streak_group = (select streak_group from current_group);

  -- ── COUNTER 2: monthly total ────────────────────────────────────────────────
  -- Distinct verified overnight nights since the 1st of the calendar month,
  -- regardless of gaps or streaks. Resets on the 1st.
  select coalesce(count(distinct overnight_date), 0)
  into v_nights_month
  from vehicle_overnight_sessions
  where
    plate_number = p_plate
    and organization_id = p_org_id
    and verification_status = 'verified_overnight'
    and overnight_date >= v_month_start_date;

  -- ── Limit comparisons ────────────────────────────────────────────────────────────
  -- BREACH fires when the count EXCEEDS the limit (> not >=).
  -- Owner-confirmed: limit=3 means 3 nights are allowed; the 4th breaches.
  -- Consecutive checked first; if both trip simultaneously, consecutive wins.

  if v_rules.max_consecutive_nights is not null
    and v_streak > v_rules.max_consecutive_nights then
    v_is_compliant := false;
    v_reason := 'consecutive_night_limit_exceeded';
  end if;

  if v_is_compliant
    and v_rules.max_nights_per_month is not null
    and v_nights_month > v_rules.max_nights_per_month then
    v_is_compliant := false;
    v_reason := 'monthly_limit_exceeded';
  end if;

  -- nights_this_zone = streak (what the consecutive limit is about).
  -- nights_this_month = monthly total (what the monthly limit is about).
  -- process-officer-scan Step 8a at_risk detection reads both and fires
  -- when streak == max_consecutive_nights OR total == max_nights_per_month
  -- (AT the limit, next night would breach) -- no code change needed there.
  return jsonb_build_object(
    'is_compliant',      v_is_compliant,
    'reason',            v_reason,
    'nights_this_zone',  v_streak,
    'nights_this_month', v_nights_month,
    'limit_consecutive', v_rules.max_consecutive_nights,
    'limit_monthly',     v_rules.max_nights_per_month,
    'scv_required',      coalesce(v_rules.scv_required, false),
    'is_scv',            (v_scv.id is not null)
  );
end;
$function$;

grant execute on function "public"."calculate_vehicle_compliance"(text, uuid, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."calculate_vehicle_compliance"(text, uuid, uuid) is 'Compliance engine. Layer 2 (0195): two independent counters. (1) Consecutive streak (nights_this_zone): length of the current unbroken run of verified_overnight sessions, using ROW_NUMBER()-subtraction streak-group algorithm -- resets to 1 after any gap. Breach fires when streak > max_consecutive_nights (the 4th night breaches when limit is 3). (2) Monthly total (nights_this_month): count(distinct overnight_date) from verified sessions since the 1st of the calendar month, regardless of gaps. Breach fires when total > max_nights_per_month. Both limits are independent; consecutive checked first. Unified source: both two_photo_verified and single_daily_observation modes read from vehicle_overnight_sessions (sessions created by process-officer-scan using movement-check for live single-daily orgs, or by historical import with evidence_strength=inferred). Layer 1 (0194) rule_type gate runs first. Layer 0 (0193) verified-session source. #74.';
