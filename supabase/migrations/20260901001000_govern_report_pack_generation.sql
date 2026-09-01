create or replace function public.generate_due_report_packs(p_period_start date, p_period_end date)
returns integer language plpgsql security definer set search_path=public as $$
declare
  v_actor uuid:=auth.uid();v_provider uuid;v_agreement record;v_count integer:=0;v_data jsonb;
  v_start_ts timestamptz:=p_period_start::timestamptz;v_end_ts timestamptz:=(p_period_end::timestamptz+interval '1 day'-interval '1 second');
  v_sla_met integer;v_sla_breached integer;v_sla_running integer;v_inc_total integer;v_inc_by_sev jsonb;v_checkpoints integer;v_breaches integer;v_facilities jsonb;
begin
  if p_period_start is null or p_period_end is null or p_period_start>p_period_end or p_period_end-p_period_start>366 then raise exception 'Select a valid report period of 366 days or less';end if;
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active provider administrator required';end if;
  for v_agreement in select id,organization_id,provider_organization_id,monthly_report_template_code from public.service_agreements where provider_organization_id=v_provider and monthly_report_template_code is not null loop
    select count(*) filter(where status='met'),count(*) filter(where status='breached'),count(*) filter(where status='running') into v_sla_met,v_sla_breached,v_sla_running from public.sla_clocks where service_agreement_id=v_agreement.id and started_at>=v_start_ts and started_at<=v_end_ts;
    select count(*),coalesce(jsonb_object_agg(severity,n),'{}'::jsonb) into v_inc_total,v_inc_by_sev from(select severity,count(*) n from public.incidents where organization_id=v_provider and occurred_at>=v_start_ts and occurred_at<=v_end_ts group by severity)s;
    select count(*) into v_checkpoints from public.patrol_checkpoint_visits where organization_id=v_provider and visited_at>=v_start_ts and visited_at<=v_end_ts;
    select count(*) into v_breaches from public.breach_alerts where organization_id=v_provider and created_at>=v_start_ts and created_at<=v_end_ts;
    select coalesce(jsonb_agg(jsonb_build_object('siteName',site_name,'expected',expected,'completed',completed) order by site_name),'[]'::jsonb) into v_facilities from(select coalesce(cs.name,'Unknown site') site_name,count(*) expected,count(*) filter(where ss.status='completed') completed from public.shift_stops ss left join public.client_sites cs on cs.id=ss.site_id where ss.organization_id=v_provider and ss.sla_arrive_by>=v_start_ts and ss.sla_arrive_by<=v_end_ts group by coalesce(cs.name,'Unknown site'))f;
    v_data:=jsonb_build_object('slaMet',coalesce(v_sla_met,0),'slaBreached',coalesce(v_sla_breached,0),'slaRunning',coalesce(v_sla_running,0),'incidentsTotal',coalesce(v_inc_total,0),'incidentsBySeverity',coalesce(v_inc_by_sev,'{}'::jsonb),'checkpointVisits',coalesce(v_checkpoints,0),'breachAlerts',coalesce(v_breaches,0),'facilities',coalesce(v_facilities,'[]'::jsonb));
    insert into public.monthly_report_packs(organization_id,service_agreement_id,template_code,period_start,period_end,status,data,generated_at,generated_by,updated_at) values(v_provider,v_agreement.id,v_agreement.monthly_report_template_code,p_period_start,p_period_end,'generated',v_data,now(),v_actor,now()) on conflict(service_agreement_id,template_code,period_start) do update set data=excluded.data,status=case when monthly_report_packs.status='sent' then 'sent' else 'generated' end,generated_at=now(),generated_by=v_actor,updated_at=now();
    v_count:=v_count+1;
  end loop;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,metadata) values(v_provider,v_actor,'monthly_report_packs_generated','monthly_report_packs',jsonb_build_object('period_start',p_period_start,'period_end',p_period_end,'pack_count',v_count));
  return v_count;
end;$$;
revoke all on function public.generate_due_report_packs(date,date) from public,anon;
grant execute on function public.generate_due_report_packs(date,date) to authenticated,service_role;