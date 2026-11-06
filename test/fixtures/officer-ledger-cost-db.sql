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
create function public.is_admin_for_org(uuid) returns boolean language sql stable as $$
  select $1::text = current_setting('fixture.admin_org',true)
$$;
create type public.report_type as enum ('incident','maintenance','health_safety');
create type public.report_status as enum ('draft','submitted','reviewed','closed');
create type public.report_severity as enum ('low','medium','high','critical');
create table public.organizations(id uuid primary key,name text not null);
create table public.service_agreements(id uuid primary key,provider_organization_id uuid,client_organization_id uuid,name text);
create table public.service_agreement_locations(id uuid primary key,service_agreement_id uuid,site_id uuid,zone_id uuid,status text);
create table public.service_agreement_modules(id uuid primary key,service_agreement_id uuid);
create table public.shifts(id uuid primary key,organization_id uuid,officer_user_id uuid,service_type text,
  scheduled_start timestamptz,actual_start timestamptz,actual_end timestamptz,service_agreement_module_id uuid,
  service_agreement_location_id uuid,zone_id uuid,superseded_by_shift_id uuid);
create table public.shift_stops(id uuid primary key default gen_random_uuid(),shift_id uuid,organization_id uuid,site_id uuid,zone_id uuid);
create table public.shift_breaks(id uuid primary key default gen_random_uuid(),organization_id uuid,shift_id uuid,
  started_at timestamptz,ended_at timestamptz,is_paid boolean);
create table public.officer_field_reports(id uuid primary key,organization_id uuid,officer_id uuid,shift_id uuid,
  report_type public.report_type,severity public.report_severity default 'low',status public.report_status default 'submitted',
  site_id uuid,zone_id uuid,title text,description text,immediate_action text,persons_involved jsonb default '[]',
  gps_lat double precision,gps_lng double precision,location_name text,reviewed_by uuid,reviewed_at timestamptz,
  reported_at timestamptz,client_event_id uuid,investigation_id uuid);
create table public.incidents(id uuid primary key default gen_random_uuid(),investigation_id uuid,is_staff_sensitive boolean default false,dispatch_job_id uuid);
create table public.location_events(id uuid primary key default gen_random_uuid(),organization_id uuid not null,client_site_id uuid,zone_id uuid,
  event_type text not null,module_key text,occurred_at timestamptz not null,status text,source text,external_ref text,
  payload jsonb not null default '{}',created_by uuid,
  constraint location_events_place_xor check (client_site_id is not null and zone_id is null or client_site_id is null and zone_id is not null));
create unique index uq_location_events_source_ref on public.location_events(organization_id,event_type,external_ref) where external_ref is not null;
create table public.dispatch_jobs(id uuid primary key,organization_id uuid,service_agreement_id uuid,client_site_id uuid,zone_id uuid,
  job_type text,priority text default 'normal',status text,briefing_notes text,outcome_notes text,completed_at timestamptz,
  on_scene_at timestamptz,created_at timestamptz default now(),investigation_id uuid,module_key text);
create table public.dispatch_job_pay_lines(id uuid primary key default gen_random_uuid(),organization_id uuid,source_dispatch_id uuid,
  rate_rule_id uuid,pay_code text,line_total numeric);
create table public.finance_pl_periods(id uuid primary key,organization_id uuid,period_start date,period_end date);
create table public.finance_service_costs(id uuid primary key default gen_random_uuid(),organization_id uuid,pl_period_id uuid,
  service_agreement_id uuid,cost_type text,shift_id uuid,dispatch_job_id uuid,total_cost numeric);
create table public.timesheets(id uuid primary key default gen_random_uuid(),organization_id uuid,staff_id uuid,shift_id uuid,
  period_start date,period_end date,status text,payroll_snapshot jsonb,hourly_rate_override numeric,created_at timestamptz default now());
create table public.staff_profiles(id uuid primary key,organization_id uuid,user_id uuid,role_code text);
create table public.rate_rules(id uuid primary key default gen_random_uuid(),organization_id uuid,rule_kind text,rate_type text,
  active boolean,amount numeric,role_code text,service_type text,effective_from date,effective_to date,priority integer default 0);

-- APPLY MIGRATION HERE

create function fixture_check(label text,ok boolean) returns void language plpgsql as $$
begin if not coalesce(ok,false) then raise exception 'FAIL: %',label; end if; raise notice 'ok: %',label; end $$;
do $$
declare
  provider uuid := '10000000-0000-0000-0000-000000000001';
  health uuid := '20000000-0000-0000-0000-000000000001';
  gibbons uuid := '20000000-0000-0000-0000-000000000002';
  health_contract uuid := '30000000-0000-0000-0000-000000000001';
  gibbons_contract uuid := '30000000-0000-0000-0000-000000000002';
  ward uuid := '40000000-0000-0000-0000-000000000001';
  mall uuid := '40000000-0000-0000-0000-000000000002';
  other_place uuid := '40000000-0000-0000-0000-000000000003';
  module uuid := '60000000-0000-0000-0000-000000000001';
  officer uuid := '70000000-0000-0000-0000-000000000001';
  other_officer uuid := '70000000-0000-0000-0000-000000000002';
  admin uuid := '70000000-0000-0000-0000-0000000000ad';
  shift_one uuid := '80000000-0000-0000-0000-000000000001';
  shift_two uuid := '80000000-0000-0000-0000-000000000002';
  shift_three uuid := '80000000-0000-0000-0000-000000000003';
  shift_four uuid := '80000000-0000-0000-0000-000000000004';
  patrol_shift uuid := '80000000-0000-0000-0000-000000000005';
  report uuid := '90000000-0000-0000-0000-000000000001';
  replay uuid := '90000000-0000-0000-0000-000000000002';
  maint uuid := '90000000-0000-0000-0000-000000000003';
  sensitive uuid := '90000000-0000-0000-0000-000000000004';
  unplaced uuid := '90000000-0000-0000-0000-000000000005';
  submission uuid := '91000000-0000-0000-0000-000000000001';
  investigation uuid := '92000000-0000-0000-0000-000000000001';
  job uuid := 'a0000000-0000-0000-0000-000000000001';
  incident_job uuid := 'a0000000-0000-0000-0000-000000000002';
  period uuid := 'b0000000-0000-0000-0000-000000000001';
  ev public.location_events%rowtype;
  result jsonb;
  health_row jsonb;
  gibbons_row jsonb;
  denied boolean;
begin
  insert into public.organizations values(provider,'R&M'),(health,'NZ Health'),(gibbons,'Gibbons Property');
  insert into public.service_agreements values(health_contract,provider,health,'Mental Health security'),
    (gibbons_contract,provider,gibbons,'Retail callouts');
  insert into public.service_agreement_locations values(gen_random_uuid(),health_contract,ward,null,'active'),
    (gen_random_uuid(),gibbons_contract,null,mall,'active');
  insert into public.service_agreement_modules values(module,health_contract);
  insert into public.staff_profiles values(officer,provider,officer,'guard'),(other_officer,provider,other_officer,'supervisor');
  insert into public.rate_rules(organization_id,rule_kind,rate_type,active,amount,role_code,service_type)
    values(provider,'pay','hourly',true,30,'guard','static_guarding');
  insert into public.shifts values
    (shift_one,provider,officer,'static_guarding','2026-11-02T08:00:00+13','2026-11-02T08:00:00+13','2026-11-02T16:00:00+13',module,null,null,null),
    (shift_two,provider,officer,'static_guarding','2026-11-03T08:00:00+13','2026-11-03T08:00:00+13','2026-11-03T12:00:00+13',module,null,null,null),
    (shift_three,provider,officer,'static_guarding','2026-11-04T08:00:00+13','2026-11-04T08:00:00+13','2026-11-04T10:00:00+13',module,null,null,null),
    (shift_four,provider,other_officer,'static_guarding','2026-11-05T08:00:00+13','2026-11-05T08:00:00+13','2026-11-05T09:00:00+13',module,null,null,null),
    (patrol_shift,provider,officer,'patrol','2026-11-06T08:00:00+13',null,null,null,null,null,null);
  insert into public.shift_stops(shift_id,organization_id,site_id) values(shift_one,provider,ward),(shift_one,provider,ward);
  insert into public.shift_stops(shift_id,organization_id,site_id) values(patrol_shift,provider,ward),(patrol_shift,provider,other_place);
  insert into public.shift_breaks(organization_id,shift_id,started_at,ended_at,is_paid) values
    (provider,shift_one,'2026-11-02T12:00:00+13','2026-11-02T12:30:00+13',false),
    (provider,shift_one,'2026-11-02T10:00:00+13','2026-11-02T10:10:00+13',true);

  -- Ledger projection
  insert into public.officer_field_reports(id,organization_id,officer_id,shift_id,report_type,title,description,immediate_action,
    persons_involved,gps_lat,gps_lng,location_name,reported_at,client_event_id)
  values(report,provider,officer,shift_one,'health_safety','PRIVATE TITLE','Wet floor at ward entrance','Cone placed',
    '[{"name":"PRIVATE PERSON"}]',-41.2,173.2,'PRIVATE GPS NAME','2026-11-02T09:00:00+13',submission);
  perform fixture_check('single-place shift report inherits its place',
    (select site_id = ward and zone_id is null from public.officer_field_reports where id=report));
  perform fixture_check('submitted report is not client activity',
    not exists(select 1 from public.location_events where external_ref=report::text));
  update public.officer_field_reports set status='reviewed',reviewed_by=admin,reviewed_at=now() where id=report;
  select * into ev from public.location_events where external_ref=report::text;
  perform fixture_check('reviewed H&S report reaches the ledger at its place',ev.client_site_id=ward and ev.source='officer_field_report');
  perform fixture_check('H&S becomes a client site hazard check',
    ev.payload->>'issue'='Site hazard check' and ev.payload->>'work_activity_code'='inspection'
    and ev.payload->>'client_visibility'='client_site_hazard' and ev.payload->>'comments'='Wet floor at ward entrance');
  perform fixture_check('no title, persons, GPS or officer identity in payload',
    ev.payload::text not like '%PRIVATE%' and not (ev.payload ? 'officer_id') and ev.payload::text not like '%'||officer::text||'%');
  update public.officer_field_reports set status='closed' where id=report;
  perform fixture_check('re-review is idempotent',(select count(*) from public.location_events where external_ref=report::text)=1);

  insert into public.officer_field_reports(id,organization_id,officer_id,shift_id,report_type,title,description,reported_at,client_event_id,status,reviewed_by,reviewed_at)
  values(replay,provider,other_officer,shift_one,'health_safety','x','Wet floor at ward entrance','2026-11-02T09:00:00+13',submission,'reviewed',admin,now());
  perform fixture_check('replayed submission is one ledger record',
    (select count(*) from public.location_events where payload->>'client_event_id'=submission::text)=1);

  insert into public.officer_field_reports(id,organization_id,officer_id,shift_id,report_type,title,description,reported_at,status,reviewed_by,reviewed_at)
  values(maint,provider,officer,shift_one,'maintenance','x','Light out','2026-11-02T09:30:00+13','reviewed',admin,now());
  perform fixture_check('maintenance stays in-house',not exists(select 1 from public.location_events where external_ref=maint::text));

  insert into public.incidents(investigation_id,is_staff_sensitive) values(investigation,true);
  insert into public.officer_field_reports(id,organization_id,officer_id,shift_id,report_type,title,description,reported_at,status,reviewed_by,reviewed_at,investigation_id)
  values(sensitive,provider,officer,shift_one,'incident','x','Staff matter','2026-11-02T10:30:00+13','reviewed',admin,now(),investigation);
  perform fixture_check('staff-sensitive investigation never projected',not exists(select 1 from public.location_events where external_ref=sensitive::text));

  insert into public.officer_field_reports(id,organization_id,officer_id,shift_id,report_type,title,description,reported_at)
  values(unplaced,provider,officer,patrol_shift,'incident','x','Gate open','2026-11-06T09:00:00+13');
  perform fixture_check('multi-place shift is not guessed',
    (select site_id is null and zone_id is null from public.officer_field_reports where id=unplaced));

  insert into public.dispatch_jobs(id,organization_id,service_agreement_id,zone_id,job_type,status,briefing_notes,outcome_notes)
  values(job,provider,null,mall,'callout','on_scene','PRIVATE COMPLAINANT','Area checked, person moved on');
  perform fixture_check('open callout not reported',not exists(select 1 from public.location_events where external_ref=job::text));
  update public.dispatch_jobs set status='completed',completed_at='2026-11-04T22:30:00+13' where id=job;
  select * into ev from public.location_events where external_ref=job::text;
  perform fixture_check('completed callout reaches the ledger',ev.zone_id=mall and ev.source='dispatch_job' and ev.payload->>'issue'='Callout attendance');
  perform fixture_check('briefing notes never copied',ev.payload::text not like '%PRIVATE%' and ev.payload->>'comments'='Area checked, person moved on');
  insert into public.dispatch_jobs(id,organization_id,zone_id,job_type,status,completed_at) values(incident_job,provider,mall,'callout','on_scene',null);
  insert into public.incidents(dispatch_job_id) values(incident_job);
  update public.dispatch_jobs set status='completed',completed_at='2026-11-04T23:00:00+13' where id=incident_job;
  perform fixture_check('callout already reported as an incident is not duplicated',
    not exists(select 1 from public.location_events where external_ref=incident_job::text));

  -- Cost of service
  insert into public.timesheets(organization_id,staff_id,shift_id,period_start,period_end,status,hourly_rate_override)
    values(provider,officer,shift_two,'2026-11-03','2026-11-03','approved',40);
  insert into public.timesheets(organization_id,staff_id,shift_id,period_start,period_end,status)
    values(provider,officer,shift_three,'2026-11-04','2026-11-04','submitted');
  insert into public.finance_pl_periods values(period,provider,'2026-11-01','2026-11-30');
  insert into public.finance_service_costs(organization_id,pl_period_id,service_agreement_id,cost_type,shift_id,total_cost)
    values(provider,period,health_contract,'labour',shift_three,100);
  insert into public.dispatch_job_pay_lines(organization_id,source_dispatch_id,rate_rule_id,pay_code,line_total)
    values(provider,job,gen_random_uuid(),'CALLOUT',50),(provider,job,null,'UNRESOLVED',0);

  denied:=false;
  begin perform public.get_cost_of_service_summary(provider,'2026-11-01','2026-11-30'); exception when others then denied:=true; end;
  perform fixture_check('unauthenticated cost read denied',denied);
  perform set_config('request.jwt.claim.sub',admin::text,true);
  denied:=false;
  begin perform public.get_cost_of_service_summary(provider,'2026-11-01','2026-11-30'); exception when others then denied:=true; end;
  perform fixture_check('non-admin cost read denied',denied);
  perform set_config('fixture.admin_org',provider::text,true);
  denied:=false;
  begin perform public.get_cost_of_service_summary(provider,'2026-01-01','2027-06-30'); exception when others then denied:=true; end;
  perform fixture_check('oversized window rejected',denied);

  result := public.get_cost_of_service_summary(provider,'2026-11-01','2026-11-30');
  select a into health_row from jsonb_array_elements(result->'agreements') a where a->>'agreementId'=health_contract::text;
  select a into gibbons_row from jsonb_array_elements(result->'agreements') a where a->>'agreementId'=gibbons_contract::text;
  perform fixture_check('posted labour is reported',(health_row#>>'{posted,total}')::numeric=100);
  perform fixture_check('worked hours less unpaid break only',(health_row#>>'{labour,hours}')::numeric=7.5+4+2+1);
  perform fixture_check('missing steps are exact',
    (health_row#>>'{labour,missingSteps,noTimesheet}')::int=2
    and (health_row#>>'{labour,missingSteps,timesheetNotApproved}')::int=0
    and (health_row#>>'{labour,missingSteps,approvedNotPosted}')::int=1
    and (health_row#>>'{labour,postedShifts}')::int=1);
  perform fixture_check('estimate uses override then rate rule, separately from posted',
    (health_row#>>'{labour,estimateNotPosted}')::numeric=7.5*30+4*40);
  perform fixture_check('unresolved rate is counted, never zero cost',(health_row#>>'{labour,rateUnresolvedShifts}')::int=1);
  perform fixture_check('in-progress shift not counted as worked',(health_row#>>'{labour,inProgressShifts}')::int=0);
  perform fixture_check('callout attributed by its unique agreement place',
    (gibbons_row#>>'{callouts,completedJobs}')::int=2 and (gibbons_row#>>'{callouts,payLineTotal}')::numeric=50
    and (gibbons_row#>>'{callouts,unresolvedPayLines}')::int=1 and (gibbons_row#>>'{callouts,jobsWithoutPayLines}')::int=1);
  perform fixture_check('client name and agreement name present',gibbons_row->>'clientName'='Gibbons Property');
  perform fixture_check('no officer identities in cost summary',
    result::text not like '%'||officer::text||'%' and result::text not like '%'||other_officer::text||'%');
  perform fixture_check('authenticated may call cost summary',
    has_function_privilege('authenticated','public.get_cost_of_service_summary(uuid,date,date)','execute'));
  perform fixture_check('anon cannot call cost summary',
    not has_function_privilege('anon','public.get_cost_of_service_summary(uuid,date,date)','execute'));
  perform fixture_check('projectors are internal only',
    not has_function_privilege('authenticated','public.project_officer_field_report_to_ledger(uuid)','execute')
    and not has_function_privilege('anon','public.project_dispatch_job_to_ledger(uuid)','execute')
    and not has_function_privilege('service_role','public.project_dispatch_job_to_ledger(uuid)','execute'));
end $$;
