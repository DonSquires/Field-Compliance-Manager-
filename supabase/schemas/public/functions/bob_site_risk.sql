create or replace function public.bob_site_risk (
  p_site_id       uuid,
  p_radius_m      integer default 500,
  p_unrestricted  boolean default false,
  p_scope_org_ids uuid[]  default null::uuid[]
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_site        client_sites%rowtype;
  v_point       geography;
  v_radius      integer := greatest(50, least(coalesce(p_radius_m, 500), 5000));
  v_now         timestamptz := now();
  v_signals     jsonb := '[]'::jsonb;
begin
  select * into v_site from client_sites where id = p_site_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'site_not_found');
  end if;

  if v_site.center_point is not null then
    v_point := v_site.center_point::geography;
  elsif v_site.gps_lat is not null and v_site.gps_lng is not null then
    v_point := st_setsrid(st_makepoint(v_site.gps_lng, v_site.gps_lat), 4326)::geography;
  else
    v_point := null;
  end if;

  with sources as (
    select 'observation'::text as source, 'intrinsic'::text as scope,
           o.organization_id, coalesce(nullif(o.compliance_reason,''),'observation')::text as severity_hint,
           o.observed_at as occurred_at, null::numeric as distance_m,
           o.plate_number::text as detail
    from observations o
    where o.site_id = p_site_id

    union all

    select 'observation'::text, 'proximity'::text, o.organization_id, coalesce(nullif(o.compliance_reason,''),'observation')::text,
           o.observed_at,
           round(st_distance(o.gps_point::geography, v_point)::numeric, 0),
           o.plate_number::text
    from observations o
    where v_point is not null and o.site_id is distinct from p_site_id
      and o.gps_point is not null
      and st_dwithin(o.gps_point::geography, v_point, v_radius)

    union all

    select 'incident'::text,
           case when i.client_site_id = p_site_id then 'intrinsic' else 'proximity' end::text,
           i.organization_id, i.severity::text, i.occurred_at,
           round(st_distance(
             case when ics.center_point is not null then ics.center_point::geography
                  else st_setsrid(st_makepoint(ics.gps_lng, ics.gps_lat),4326)::geography end,
             v_point)::numeric, 0) as distance_m,
           i.incident_type::text
    from incidents i
    join client_sites ics on ics.id = i.client_site_id
    where v_point is not null
      and (ics.center_point is not null
           or (ics.gps_lat is not null and ics.gps_lng is not null))
      and st_dwithin(
            case when ics.center_point is not null then ics.center_point::geography
                 else st_setsrid(st_makepoint(ics.gps_lng, ics.gps_lat),4326)::geography end,
            v_point, v_radius)

    union all

    select 'field_report'::text, case when r.site_id = p_site_id then 'intrinsic' else 'proximity' end::text,
           r.organization_id, r.severity::text, r.reported_at,
           case when r.gps_lat is null then null
                else round(st_distance(st_setsrid(st_makepoint(r.gps_lng, r.gps_lat),4326)::geography, v_point)::numeric,0) end,
           r.report_type::text
    from officer_field_reports r
    where (r.site_id = p_site_id)
       or (v_point is not null and r.gps_lat is not null
           and st_dwithin(st_setsrid(st_makepoint(r.gps_lng, r.gps_lat),4326)::geography, v_point, v_radius))

    union all

    select case ef.entity_type
             when 'place' then 'location_flag'
             when 'vehicle' then 'vehicle_flag'
             else 'entity_flag'
           end::text,
           case when ef.entity_type = 'place' and ef.entity_id = p_site_id then 'intrinsic'
                else 'proximity' end::text,
           ef.organization_id, ef.alert_level::text, ef.raised_at,
           case when ef.entity_type = 'place' then
             (select round(st_distance(
               case when efs.center_point is not null then efs.center_point::geography
                    else st_setsrid(st_makepoint(efs.gps_lng, efs.gps_lat),4326)::geography end,
               v_point)::numeric, 0)
              from client_sites efs where efs.id = ef.entity_id
                and (efs.center_point is not null or (efs.gps_lat is not null and efs.gps_lng is not null)))
           else null end,
           ef.flag_type::text
    from entity_flags ef
    where ef.active
      and ((ef.entity_type = 'place' and ef.entity_id = p_site_id)
        or (ef.entity_type = 'place' and v_point is not null
            and exists (
              select 1 from client_sites efs
              where efs.id = ef.entity_id
                and (efs.center_point is not null or (efs.gps_lat is not null and efs.gps_lng is not null))
                and st_dwithin(
                  case when efs.center_point is not null then efs.center_point::geography
                       else st_setsrid(st_makepoint(efs.gps_lng, efs.gps_lat),4326)::geography end,
                  v_point, v_radius)))
        or (ef.entity_type in ('vehicle', 'person', 'staff')))

    union all

    select 'welfare_alert'::text, 'proximity'::text, wa.organization_id, wa.alert_type::text, wa.triggered_at,
           case when wa.gps_lat is null then null
                else round(st_distance(st_setsrid(st_makepoint(wa.gps_lng, wa.gps_lat),4326)::geography, v_point)::numeric,0) end,
           wa.alert_type::text
    from welfare_alerts wa
    where v_point is not null and wa.gps_lat is not null
      and st_dwithin(st_setsrid(st_makepoint(wa.gps_lng, wa.gps_lat),4326)::geography, v_point, v_radius)

    union all
    select 'noise_assessment'::text, 'intrinsic'::text, n.organization_id,
           (case when n.hs_flag_active then 'high' else 'low' end)::text, n.assessed_at, null, n.noise_source::text
    from noise_assessments n where n.site_id = p_site_id

    union all
    select 'smoke_assessment'::text, 'intrinsic'::text, sm.organization_id, coalesce(sm.severity::text,'low')::text, sm.assessed_at, null, sm.smoke_source_type::text
    from smoke_assessments sm where sm.site_id = p_site_id

    union all
    select 'biosecurity_assessment'::text, 'intrinsic'::text, b.organization_id, 'low'::text, b.assessed_at, null, b.species_identified::text
    from biosecurity_assessments b where b.site_id = p_site_id
  ),
  banded as (
    select *,
      case when occurred_at >= v_now - interval '7 days'  then 'active'
           when occurred_at >= v_now - interval '28 days' then 'monitor'
           else 'history' end as band,
      (p_unrestricted
        or p_scope_org_ids is null
        or organization_id = any(p_scope_org_ids)) as in_scope
    from sources
    where occurred_at is not null
  )
  select jsonb_agg(
    jsonb_build_object(
      'source', source,
      'scope', scope,
      'band', band,
      'severity', severity_hint,
      'occurred_at', occurred_at,
      'distance_m', distance_m,
      'in_scope', in_scope,
      'detail', case when in_scope then detail else null end,
      'identity_withheld', (not in_scope)
    )
    order by occurred_at desc
  )
  into v_signals
  from banded;

  return jsonb_build_object(
    'success', true,
    'site_id', p_site_id,
    'site_name', v_site.name,
    'has_point', (v_point is not null),
    'radius_m', v_radius,
    'generated_at', v_now,
    'signals', coalesce(v_signals, '[]'::jsonb)
  );
end;
$function$;

grant execute on function "public"."bob_site_risk"(uuid, integer, boolean, uuid[]) to "postgres", "service_role";

revoke all on function "public"."bob_site_risk"(uuid, integer, boolean, uuid[]) from public;
