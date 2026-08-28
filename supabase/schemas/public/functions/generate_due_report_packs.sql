create or replace function public.generate_due_report_packs (
  p_period_start date,
  p_period_end   date
)
  returns integer
  language plpgsql
  security definer
  AS $function$
declare
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
  for v_agreement in
    select id, organization_id, provider_organization_id, monthly_report_template_code
    from service_agreements
    where monthly_report_template_code is not null
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
      period_start, period_end, status, data, generated_at, updated_at
    ) values (
      v_agreement.provider_organization_id, v_agreement.id,
      v_agreement.monthly_report_template_code,
      p_period_start, p_period_end, 'generated', v_data, now(), now()
    )
    on conflict (service_agreement_id, template_code, period_start)
    do update set
      data = excluded.data,
      status = case when monthly_report_packs.status = 'sent' then 'sent' else 'generated' end,
      generated_at = now(),
      updated_at = now();

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

grant execute on function "public"."generate_due_report_packs"(date, date) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."generate_due_report_packs"(date, date) is 'Assembles + upserts monthly_report_packs for every agreement with a template code over the given period. Mirrors the client-side assembler so generation can be scheduled (pg_cron). Does not re-downgrade an already-sent pack.';
