-- generate_due_report_packs selected a non-existent "organization_id" column
-- from service_agreements (which only has provider_organization_id /
-- client_organization_id), breaking every invocation with
-- "column organization_id does not exist". The column was never referenced
-- in the loop body -- only provider_organization_id, id, and
-- monthly_report_template_code are used. Confirmed live via a real
-- authenticated invocation (grand_master), not just static review.
CREATE OR REPLACE FUNCTION "public"."generate_due_report_packs"("p_period_start" "date", "p_period_end" "date") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO 'public'
    AS $$
declare
  v_actor       uuid := auth.uid();
  v_provider    uuid;
  v_agreement   record;
  v_count       integer := 0;
  v_data        jsonb;
  v_start_ts    timestamptz := p_period_start::timestamptz;
  v_end_ts      timestamptz := (p_period_end::timestamptz + interval '1 day' - interval '1 second');
  v_sla_met     integer;
  v_sla_breached integer;
  v_sla_running integer;
  v_inc_total   integer;
  v_inc_by_sev  jsonb;
  v_checkpoints integer;
  v_breaches    integer;
  v_facilities  jsonb;
begin
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end or p_period_end - p_period_start > 366 then
    raise exception 'Select a valid report period of 366 days or less';
  end if;
  select organization_id into v_provider from user_profiles where id = v_actor and deactivated_at is null;
  if v_provider is null or not is_admin_for_org(v_provider) then raise exception 'Active provider administrator required'; end if;
  for v_agreement in
    select id, provider_organization_id, monthly_report_template_code
    from service_agreements
    where provider_organization_id = v_provider
      and monthly_report_template_code is not null
  loop
    -- SLA performance for this agreement over the period.
    select
      count(*) filter (where status = 'met'),
      count(*) filter (where status = 'breached'),
      count(*) filter (where status = 'running')
    into v_sla_met, v_sla_breached, v_sla_running
    from sla_clocks
    where service_agreement_id = v_agreement.id
      and started_at >= v_start_ts and started_at <= v_end_ts;

    -- Incidents over the period (org-wide).
    select count(*),
           coalesce(jsonb_object_agg(severity, n), '{}'::jsonb)
    into v_inc_total, v_inc_by_sev
    from (
      select severity, count(*) as n
      from incidents
      where organization_id = v_agreement.provider_organization_id
        and occurred_at >= v_start_ts and occurred_at <= v_end_ts
      group by severity
    ) s;

    select count(*) into v_checkpoints
    from patrol_checkpoint_visits
    where organization_id = v_agreement.provider_organization_id
      and visited_at >= v_start_ts and visited_at <= v_end_ts;

    select count(*) into v_breaches
    from breach_alerts
    where organization_id = v_agreement.provider_organization_id
      and created_at >= v_start_ts and created_at <= v_end_ts;

    -- Per-facility patrol completion from shift_stops.
    select coalesce(jsonb_agg(jsonb_build_object(
             'siteName', site_name,
             'expected', expected,
             'completed', completed
           ) order by site_name), '[]'::jsonb)
    into v_facilities
    from (
      select coalesce(cs.name, 'Unknown site') as site_name,
             count(*) as expected,
             count(*) filter (where ss.status = 'completed') as completed
      from shift_stops ss
      left join client_sites cs on cs.id = ss.site_id
      where ss.organization_id = v_agreement.provider_organization_id
        and ss.sla_arrive_by >= v_start_ts and ss.sla_arrive_by <= v_end_ts
      group by coalesce(cs.name, 'Unknown site')
    ) f;

    v_data := jsonb_build_object(
      'slaMet', coalesce(v_sla_met, 0),
      'slaBreached', coalesce(v_sla_breached, 0),
      'slaRunning', coalesce(v_sla_running, 0),
      'incidentsTotal', coalesce(v_inc_total, 0),
      'incidentsBySeverity', coalesce(v_inc_by_sev, '{}'::jsonb),
      'checkpointVisits', coalesce(v_checkpoints, 0),
      'breachAlerts', coalesce(v_breaches, 0),
      'facilities', coalesce(v_facilities, '[]'::jsonb)
    );

    insert into monthly_report_packs (
      organization_id, service_agreement_id, template_code,
      period_start, period_end, status, data, generated_at, generated_by, updated_at
    ) values (
      v_agreement.provider_organization_id, v_agreement.id,
      v_agreement.monthly_report_template_code,
      p_period_start, p_period_end, 'generated', v_data, now(), v_actor, now()
    )
    on conflict (service_agreement_id, template_code, period_start)
    do update set
      data = excluded.data,
      status = case when monthly_report_packs.status = 'sent' then 'sent' else 'generated' end,
      generated_at = now(),
      generated_by = v_actor,
      updated_at = now();

    v_count := v_count + 1;
  end loop;
  insert into audit_log(organization_id, actor_user_id, action, target_table, metadata)
  values(v_provider, v_actor, 'monthly_report_packs_generated', 'monthly_report_packs', jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'pack_count', v_count));

  return v_count;
end;
$$;
