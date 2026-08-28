create or replace function public.dispatch_job_create_sla_clock()
  returns trigger
  language plpgsql
  security definer
  AS $function$
declare
  v_agreement_id uuid;
  v_obligation_id uuid;
begin
  -- Only meter jobs that carry an SLA target.
  if new.sla_minutes is null then
    return new;
  end if;

  -- Resolve the service agreement for the job's site (best effort).
  if new.client_site_id is not null then
    select sfc.service_agreement_id
      into v_agreement_id
    from site_financial_config sfc
    where sfc.site_id = new.client_site_id
      and sfc.service_agreement_id is not null
    order by sfc.active desc nulls last, sfc.created_at desc
    limit 1;
  end if;

  -- Resolve the governing response_time obligation for that agreement.
  if v_agreement_id is not null then
    select ao.id
      into v_obligation_id
    from agreement_obligations ao
    where ao.service_agreement_id = v_agreement_id
      and ao.obligation_type = 'response_time'
      and ao.active = true
    order by ao.created_at
    limit 1;
  end if;

  insert into sla_clocks (
    organization_id, service_agreement_id, obligation_id,
    dispatch_job_id, site_id, started_at, target_minutes, status
  ) values (
    new.organization_id, v_agreement_id, v_obligation_id,
    new.id, new.client_site_id, coalesce(new.created_at, now()),
    new.sla_minutes, 'running'
  );

  return new;
end;
$function$;

grant execute on function "public"."dispatch_job_create_sla_clock"() to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."dispatch_job_create_sla_clock"() is 'AFTER INSERT on dispatch_jobs: creates a running sla_clocks row when sla_minutes is set, resolving the response_time obligation via site -> agreement (best effort).';
