create or replace function public.evaluate_parking_compliance (
  p_org_id                  uuid,
  p_zone_id                 uuid,
  p_plate                   text,
  p_is_disabled_bay         boolean default false,
  p_sign_time_limit_minutes integer default null::integer
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_zone_limit integer;
  v_zone_multiplier numeric;
  v_org_default integer;
  v_grace integer;
  v_effective_limit integer;
  v_chalk record;
  v_minutes_elapsed numeric;  -- C6 fix: was integer, now numeric
  v_is_overstay boolean;
  v_is_repeat boolean;
  v_repeat_count integer;
begin
  -- 1. Get zone parking rules
  select parking_time_limit_minutes, parking_disabled_multiplier
  into v_zone_limit, v_zone_multiplier
  from location_zones
  where id = p_zone_id;

  -- 2. Get org defaults
  select default_time_limit_minutes, grace_period_minutes
  into v_org_default, v_grace
  from parking_module_config
  where organization_id = p_org_id;

  v_org_default := coalesce(v_org_default, 60);
  v_grace := coalesce(v_grace, 5);
  v_zone_multiplier := coalesce(v_zone_multiplier, 1);

  -- 3. Resolve effective time limit: sign OCR > zone default > org default
  v_effective_limit := coalesce(p_sign_time_limit_minutes, v_zone_limit, v_org_default);

  -- 4. Apply disabled multiplier if disabled bay
  if p_is_disabled_bay then
    v_effective_limit := round(v_effective_limit * v_zone_multiplier);
  end if;

  -- 5. Find most recent active chalk record for this plate in this org
  -- C3 fix: when p_zone_id is specified, only match chalk records with
  -- the SAME zone_id — do NOT match null zone_id records against a
  -- specific zone query (that was a false cross-zone match bug).
  select * into v_chalk
  from parking_chalk_records
  where organization_id = p_org_id
    and plate = upper(p_plate)
    and status = 'active'
    and (
      p_zone_id is null
      or zone_id = p_zone_id
    )
  order by chalked_at desc
  limit 1;

  -- 6. Check overstay
  v_is_overstay := false;
  v_minutes_elapsed := null;
  if v_chalk.id is not null then
    v_minutes_elapsed := extract(epoch from (now() - v_chalk.chalked_at)) / 60.0;
    v_is_overstay := v_minutes_elapsed > (v_effective_limit + v_grace);
  end if;

  -- 7. Check repeat offender (other chalk records today, any status except compliant)
  -- Timezone-aware date boundary for Pacific/Auckland consistency.
  -- QA review fix: the original expression
  --   (current_timestamp at time zone 'Pacific/Auckland')::date::timestamptz
  -- was incorrect — casting a date to timestamptz re-interprets it in the
  -- SESSION timezone (UTC on Supabase), placing the boundary ~12h after
  -- true Auckland midnight. The correct idiom:
  --   date_trunc('day', current_timestamp at time zone 'Pacific/Auckland')
  --     at time zone 'Pacific/Auckland'
  -- Worked example: scan at 2026-07-15 23:55 NZST (= 11:55 UTC):
  --   current_timestamp at time zone 'Pacific/Auckland' → 2026-07-15 23:55:00
  --   date_trunc('day', ...) → 2026-07-15 00:00:00 (Auckland midnight, no tz)
  --   ... at time zone 'Pacific/Auckland' → 2026-07-14 12:00:00+00 (UTC)
  -- So chalked_at >= that value means "chalked at or after midnight NZST today". ✓
  select count(*) into v_repeat_count
  from parking_chalk_records
  where organization_id = p_org_id
    and plate = upper(p_plate)
    and chalked_at >= date_trunc('day', current_timestamp at time zone 'Pacific/Auckland') at time zone 'Pacific/Auckland'
    and status != 'compliant'
    and (v_chalk.id is null or id != v_chalk.id);

  v_is_repeat := v_repeat_count > 0;

  return jsonb_build_object(
    'verdict',                  case
                                  when v_is_overstay and v_is_repeat then 'repeat_offender'
                                  when v_is_overstay then 'overstay'
                                  when v_chalk.id is not null then 'watch'
                                  else 'clear'
                                end,
    'effective_limit_minutes',  v_effective_limit,
    'grace_period_minutes',     v_grace,
    'chalked_at',               v_chalk.chalked_at,
    'minutes_elapsed',          v_minutes_elapsed,
    'is_overstay',              v_is_overstay,
    'is_repeat',                v_is_repeat,
    'repeat_count',             v_repeat_count,
    'recommended_action',       case
                                  when v_is_overstay and v_is_repeat then 'infringement'
                                  when v_is_overstay then 'infringement'
                                  when v_chalk.id is not null then 'warning'
                                  else 'none'
                                end
  );
end;
$function$;

grant execute on function "public"."evaluate_parking_compliance"(uuid, uuid, text, boolean, integer) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."evaluate_parking_compliance"(uuid, uuid, text, boolean, integer) is 'Evaluate parking compliance for a plate in a zone. Resolves effective time limit (sign OCR > zone default > org default), applies disabled multiplier, checks overstay and repeat offender status. Called by process-officer-scan when module_key=parking_enforcement. Issue #116. Fixed in 0233: C6 (numeric precision), C3 (zone filter tightening).';
