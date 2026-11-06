-- Isolated Postgres fixture only; never run against an application database.
create schema if not exists auth;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create function public.is_report_provider_custodian_for_org(uuid) returns boolean language sql stable as $$
  select $1::text = current_setting('fixture.provider',true)
$$;
create table service_agreements(id uuid primary key,provider_organization_id uuid,client_organization_id uuid);
create table service_agreement_locations(id uuid primary key,service_agreement_id uuid,site_id uuid,zone_id uuid,status text);
create table service_agreement_modules(id uuid primary key,service_agreement_id uuid);
create table shifts(id uuid primary key,organization_id uuid,service_agreement_module_id uuid);
create table shift_stops(id uuid primary key,shift_id uuid,organization_id uuid,site_id uuid,zone_id uuid,actual_departed_at timestamptz);
create table shift_stop_modules(id uuid primary key,organization_id uuid,shift_stop_id uuid,service_agreement_module_id uuid,service_agreement_location_id uuid,module_key text,status text);
create table shift_stop_actions(id uuid primary key,organization_id uuid,shift_stop_module_id uuid,action_type text,notes text);
create table officer_field_reports(id uuid primary key,organization_id uuid,client_event_id uuid,status text,reviewed_at timestamptz,reviewed_by uuid,investigation_id uuid,reported_at timestamptz,report_type text,site_id uuid,zone_id uuid,shift_id uuid,description text);
create table dispatch_jobs(id uuid primary key,organization_id uuid,service_agreement_id uuid,client_request_id uuid,shift_stop_id uuid,investigation_id uuid,status text,completed_at timestamptz,client_site_id uuid,zone_id uuid,outcome_notes text);
create table location_events(id uuid primary key,organization_id uuid,occurred_at timestamptz,client_site_id uuid,zone_id uuid,source text,external_ref text,payload jsonb);
create table observations(id uuid primary key,organization_id uuid,observed_at timestamptz,site_id uuid,zone_id uuid,external_refs jsonb);
create table incidents(id uuid primary key,organization_id uuid,occurred_at timestamptz,client_site_id uuid,zone_id uuid,is_staff_sensitive boolean,dispatch_job_id uuid,investigation_id uuid);
create table shift_debriefs(id uuid primary key,organization_id uuid,shift_id uuid,submitted_at timestamptz,summary text);
create table hunter_kill_returns(organization_id uuid,client_organization_id uuid,hunting_area text,return_type text,animals jsonb,total_animals integer,hunt_date date,withdrawn_at timestamptz);
create function public.build_agreement_activity_report_core(uuid,timestamptz,timestamptz,integer) returns jsonb
language sql as $$ select '{"report":{"version":2,"totals":{"entries":7}},"lines":{"version":2,"lines":[]}}'::jsonb $$;

-- APPLY MIGRATION HERE

create function fixture_check(label text,ok boolean) returns void language plpgsql as $$
begin if not coalesce(ok,false) then raise exception 'FAIL: %',label; end if; raise notice 'ok: %',label; end $$;
do $$
declare
  provider uuid := '10000000-0000-0000-0000-000000000001';
  client uuid := '20000000-0000-0000-0000-000000000001';
  contract uuid := '30000000-0000-0000-0000-000000000001';
  other_contract uuid := '30000000-0000-0000-0000-000000000002';
  site uuid := '40000000-0000-0000-0000-000000000001';
  link uuid := '50000000-0000-0000-0000-000000000001';
  module uuid := '60000000-0000-0000-0000-000000000001';
  shift uuid := '70000000-0000-0000-0000-000000000001';
  stop uuid := '80000000-0000-0000-0000-000000000001';
  task uuid := '90000000-0000-0000-0000-000000000001';
  job uuid := 'a0000000-0000-0000-0000-000000000001';
  report uuid := 'b0000000-0000-0000-0000-000000000001';
  request uuid := 'c0000000-0000-0000-0000-000000000001';
  actor uuid := 'd0000000-0000-0000-0000-000000000001';
  result jsonb;
  denied boolean;
begin
  insert into service_agreements values(contract,provider,client),(other_contract,provider,gen_random_uuid());
  insert into service_agreement_locations values(link,contract,site,null,'active');
  insert into service_agreement_modules values(module,contract);
  insert into shifts values(shift,provider,module);
  insert into shift_stops values(stop,shift,provider,site,null,'2026-11-02T10:00:00+13');
  insert into shift_stop_modules values(task,provider,stop,module,link,'static_guarding','completed');
  insert into shift_stop_actions values(gen_random_uuid(),provider,task,'static_post_arrived','PRIVATE'),
    (gen_random_uuid(),provider,task,'static_post_departed','PRIVATE'),
    (gen_random_uuid(),provider,task,'static_post_departed','PRIVATE');
  insert into shift_debriefs values(gen_random_uuid(),provider,shift,'2026-11-02T11:00:00+13','PRIVATE');
  insert into dispatch_jobs values(job,provider,contract,null,null,null,'completed','2026-11-02T10:00:00+13',site,null,'PRIVATE');
  insert into officer_field_reports values(report,provider,request,'reviewed',now(),actor,null,'2026-11-02T10:00:00+13','incident',site,null,shift,'PRIVATE');
  insert into officer_field_reports select gen_random_uuid(),provider,request,'reviewed',now(),actor,null,'2026-11-02T10:00:00+13','incident',site,null,shift,'PRIVATE';
  insert into officer_field_reports select gen_random_uuid(),provider,gen_random_uuid(),'submitted',null,null,null,'2026-11-02T10:00:00+13','incident',site,null,shift,'PRIVATE';
  insert into officer_field_reports select gen_random_uuid(),provider,gen_random_uuid(),'reviewed',now(),actor,null,'2026-11-02T10:00:00+13','maintenance',site,null,shift,'PRIVATE';
  insert into officer_field_reports select gen_random_uuid(),provider,gen_random_uuid(),'reviewed',now(),actor,null,'2026-11-02T10:00:00+13','health_safety',site,null,shift,'PRIVATE';
  result := report_service_delivery_summary(contract,'2026-11-01T00:00:00+13','2026-11-08T00:00:00+13');
  perform fixture_check('provider custody attributes to client agreement',result#>>'{client,counts,completedDispatch,recorded}'='1');
  perform fixture_check('arrive/depart/retries count one completed attendance',result#>>'{client,counts,completedStatic,recorded}'='1');
  perform fixture_check('same client event deduplicates imported field reports',result#>>'{client,counts,reviewedReports,recorded}'='1');
  perform fixture_check('submitted report stays internal',result#>>'{internal,awaitingReview}'='1');
  perform fixture_check('handover presence stays internal',result#>>'{internal,handoversReceived}'='1' and not (result->'client')?'internal');
  perform fixture_check('no private prose crosses projection',result::text not like '%PRIVATE%');
  perform fixture_check('maintenance and staff H&S excluded',result#>>'{client,counts,reviewedReports,recorded}'='1');
  insert into location_events values(gen_random_uuid(),provider,'2026-11-02T10:00:00+13',site,null,'dispatch_job',job::text,'{}');
  insert into observations values(gen_random_uuid(),provider,'2026-11-02T10:00:00+13',site,null,jsonb_build_object('officer_field_report_id',report));
  result := report_service_delivery_summary(contract,'2026-11-01T00:00:00+13','2026-11-08T00:00:00+13');
  perform fixture_check('dispatch mirror is overlap not additional activity',result#>>'{client,counts,completedDispatch,additional}'='0');
  perform fixture_check('observation provenance is overlap not additional activity',result#>>'{client,counts,reviewedReports,additional}'='0');
  result := build_agreement_activity_report(contract,'2026-11-01T00:00:00+13','2026-11-08T00:00:00+13',2000);
  perform fixture_check('pack keeps original activity totals',result#>>'{report,totals,entries}'='7');
  perform fixture_check('pack freezes safe service supplement',result#>>'{report,serviceDelivery,version}'='1');
  perform fixture_check('pack omits private handover counts',not (result#>'{report,serviceDelivery}')?'internal');
  insert into service_agreement_locations values(gen_random_uuid(),other_contract,site,null,'active');
  insert into dispatch_jobs values(gen_random_uuid(),provider,null,null,null,null,'completed','2026-11-02T10:00:00+13',site,null,'PRIVATE');
  insert into dispatch_jobs values(gen_random_uuid(),provider,other_contract,null,null,null,'completed','2026-11-02T10:00:00+13',site,null,'PRIVATE');
  result := report_service_delivery_summary(contract,'2026-11-01T00:00:00+13','2026-11-08T00:00:00+13');
  perform fixture_check('shared place cannot steal another or unassigned contract job',result#>>'{client,counts,completedDispatch,recorded}'='1');
  update shift_stop_modules set status='pending' where id=task;
  result := report_service_delivery_summary(contract,'2026-11-01T00:00:00+13','2026-11-08T00:00:00+13');
  perform fixture_check('unfinished static module is not completed service',result#>>'{client,counts,completedStatic,recorded}'='0');
  result := report_service_delivery_summary(contract,'2026-11-03T00:00:00+13','2026-11-08T00:00:00+13');
  perform fixture_check('window excludes earlier work',result#>>'{client,counts,completedDispatch,recorded}'='0');
  denied:=false;
  begin perform get_agreement_service_delivery_summary(array[contract],now()-interval '1 day',now());
  exception when others then denied:=true; end;
  perform fixture_check('unauthenticated caller denied',denied);
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('fixture.provider',provider::text,true);
  result := get_agreement_service_delivery_summary(array[contract,contract],'2026-11-01T00:00:00+13','2026-11-08T00:00:00+13');
  perform fixture_check('authenticated provider and duplicate contract IDs',jsonb_array_length(result)=1);
  perform set_config('fixture.provider',client::text,true);
  denied:=false;
  begin perform get_agreement_service_delivery_summary(array[contract],now()-interval '1 day',now());
  exception when others then denied:=true; end;
  perform fixture_check('client/noncustodian cannot read internal counts',denied);
  perform fixture_check('authenticated cannot call internal assembler directly',not has_function_privilege('authenticated','public.report_service_delivery_summary(uuid,timestamptz,timestamptz)','execute'));
end $$;
