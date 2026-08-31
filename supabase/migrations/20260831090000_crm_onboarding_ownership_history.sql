alter table public.crm_onboarding_ledgers
  add column if not exists assigned_to uuid references public.user_profiles(id) on delete set null,
  add column if not exists stage_note text;

create table public.crm_onboarding_events(
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.crm_onboarding_ledgers(id) on delete cascade,
  provider_organization_id uuid not null references public.organizations(id) on delete cascade,
  account_organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type text not null check(event_type in('started','workflow_updated','activated')),
  from_stage text,
  to_stage text not null,
  ledger_status text not null,
  assigned_to uuid references public.user_profiles(id) on delete set null,
  note text not null check(char_length(trim(note)) between 3 and 1000),
  actor_user_id uuid references public.user_profiles(id) on delete set null,
  ledger_version integer not null,
  created_at timestamptz not null default clock_timestamp()
);
create index crm_onboarding_events_ledger_created_idx on public.crm_onboarding_events(ledger_id,created_at desc);
alter table public.crm_onboarding_events enable row level security;
revoke all on table public.crm_onboarding_events from public,anon,authenticated;
grant all on table public.crm_onboarding_events to service_role;

insert into public.crm_onboarding_events(ledger_id,provider_organization_id,account_organization_id,event_type,from_stage,to_stage,ledger_status,assigned_to,note,actor_user_id,ledger_version,created_at)
select l.id,l.provider_organization_id,l.account_organization_id,'started',null,l.current_stage,l.status,l.assigned_to,'Onboarding ledger created',null,l.version,l.started_at
from public.crm_onboarding_ledgers l
where not exists(select 1 from public.crm_onboarding_events e where e.ledger_id=l.id);

create or replace function public.seed_crm_onboarding_ledger() returns trigger language plpgsql security definer set search_path=public as $$
declare v_ledger public.crm_onboarding_ledgers%rowtype;
begin
  if new.organization_type='client' and new.parent_organization_id is not null and new.status='prospect' then
    insert into public.crm_onboarding_ledgers(provider_organization_id,account_organization_id) values(new.parent_organization_id,new.id) on conflict do nothing returning * into v_ledger;
    if v_ledger.id is not null then insert into public.crm_onboarding_events(ledger_id,provider_organization_id,account_organization_id,event_type,to_stage,ledger_status,note,ledger_version) values(v_ledger.id,v_ledger.provider_organization_id,v_ledger.account_organization_id,'started',v_ledger.current_stage,v_ledger.status,'Onboarding ledger created',v_ledger.version);end if;
  end if;
  return new;
end;$$;

create function public.get_crm_onboarding_assignees()
returns table(user_id uuid,display_name text,role text)
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  return query select u.id,coalesce(nullif(trim(u.display_name),''),u.email,'Administrator'),u.role from public.user_profiles u
  where u.deactivated_at is null and u.role in('admin','master','grand_master') and (u.organization_id=v_provider or u.employer_organization_id=v_provider)
  order by coalesce(nullif(trim(u.display_name),''),u.email,'Administrator');
end;$$;

create function public.get_crm_onboarding_workspace()
returns table(ledger_id uuid,account_organization_id uuid,account_name text,organization_status text,organization_updated_at timestamptz,current_stage text,ledger_status text,version integer,started_at timestamptz,target_live_at timestamptz,days_open integer,overdue boolean,has_primary_contact boolean,agreement_id uuid,agreement_name text,readiness jsonb,assigned_to uuid,assigned_name text,stage_note text)
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  return query select l.id,o.id,o.name,o.status,o.updated_at,l.current_stage,l.status,l.version,l.started_at,l.target_live_at,greatest(0,floor(extract(epoch from(now()-l.started_at))/86400)::integer),l.target_live_at<now(),exists(select 1 from public.crm_contacts c where c.organization_id=o.id and c.is_primary and c.deactivated_at is null),sa.id,sa.name,case when sa.id is null then null else public.get_crm_operational_readiness(sa.id) end,l.assigned_to,u.display_name,l.stage_note
  from public.crm_onboarding_ledgers l join public.organizations o on o.id=l.account_organization_id left join public.user_profiles u on u.id=l.assigned_to left join lateral(select a.id,a.name from public.service_agreements a where a.provider_organization_id=l.provider_organization_id and a.client_organization_id=l.account_organization_id and a.agreement_type='operational' order by case when a.invitation_status='accepted' then 0 else 1 end,a.created_at desc limit 1)sa on true
  where l.provider_organization_id=v_provider and l.status<>'activated' order by l.target_live_at,l.started_at;
end;$$;

create function public.get_crm_onboarding_history(p_account_organization_id uuid)
returns table(event_id uuid,event_type text,from_stage text,to_stage text,ledger_status text,assigned_to uuid,assigned_name text,note text,actor_user_id uuid,actor_name text,ledger_version integer,created_at timestamptz)
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_ledger_id uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  select l.id into v_ledger_id from public.crm_onboarding_ledgers l where l.provider_organization_id=v_provider and l.account_organization_id=p_account_organization_id;
  if v_ledger_id is null then raise exception 'Onboarding ledger not found';end if;
  return query select e.id,e.event_type,e.from_stage,e.to_stage,e.ledger_status,e.assigned_to,a.display_name,e.note,e.actor_user_id,x.display_name,e.ledger_version,e.created_at from public.crm_onboarding_events e left join public.user_profiles a on a.id=e.assigned_to left join public.user_profiles x on x.id=e.actor_user_id where e.ledger_id=v_ledger_id order by e.created_at desc,e.ledger_version desc;
end;$$;

create function public.manage_crm_onboarding_workflow(p_account_organization_id uuid,p_expected_version integer,p_stage text,p_target_live_at timestamptz,p_assigned_to uuid,p_note text)
returns public.crm_onboarding_ledgers language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_ledger public.crm_onboarding_ledgers%rowtype;v_previous_stage text;v_rank integer;v_next_rank integer;v_agreement_id uuid;v_readiness jsonb;v_note text:=trim(coalesce(p_note,''));
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  select * into v_ledger from public.crm_onboarding_ledgers where provider_organization_id=v_provider and account_organization_id=p_account_organization_id for update;
  if not found then raise exception 'Onboarding ledger not found';end if;
  if v_ledger.version<>p_expected_version then raise exception 'Onboarding ledger changed since it was opened';end if;
  if v_ledger.status='activated' then raise exception 'Activated onboarding cannot be changed';end if;
  if char_length(v_note) not between 3 and 1000 then raise exception 'Stage note must be between 3 and 1000 characters';end if;
  if not exists(select 1 from public.user_profiles u where u.id=p_assigned_to and u.deactivated_at is null and u.role in('admin','master','grand_master') and (u.organization_id=v_provider or u.employer_organization_id=v_provider)) then raise exception 'Select an active provider CRM administrator';end if;
  v_rank:=array_position(array['qualify','configure','review'],v_ledger.current_stage);v_next_rank:=array_position(array['qualify','configure','review'],p_stage);
  if v_next_rank is null or v_next_rank<v_rank or v_next_rank>v_rank+1 then raise exception 'Onboarding stage transition is not allowed';end if;
  if p_stage='review' and p_stage<>v_ledger.current_stage then
    select sa.id into v_agreement_id from public.service_agreements sa where sa.provider_organization_id=v_provider and sa.client_organization_id=p_account_organization_id and sa.agreement_type='operational' and sa.invitation_status='accepted' order by sa.created_at desc limit 1;
    if v_agreement_id is null then raise exception 'Accepted operational agreement required before review';end if;
    if not exists(select 1 from public.crm_contacts c where c.organization_id=p_account_organization_id and c.is_primary and c.deactivated_at is null) then raise exception 'Active primary contact required before review';end if;
    v_readiness:=public.get_crm_operational_readiness(v_agreement_id);if not coalesce((v_readiness->>'ready')::boolean,false) then raise exception 'Operational readiness blockers remain before review';end if;
  end if;
  v_previous_stage:=v_ledger.current_stage;
  update public.crm_onboarding_ledgers set current_stage=p_stage,status=case when p_stage=v_ledger.current_stage then v_ledger.status when p_stage='review' then 'ready' else 'in_progress' end,target_live_at=coalesce(p_target_live_at,target_live_at),assigned_to=p_assigned_to,stage_note=v_note,version=version+1,updated_at=clock_timestamp() where id=v_ledger.id returning * into v_ledger;
  insert into public.crm_onboarding_events(ledger_id,provider_organization_id,account_organization_id,event_type,from_stage,to_stage,ledger_status,assigned_to,note,actor_user_id,ledger_version) values(v_ledger.id,v_provider,p_account_organization_id,'workflow_updated',v_previous_stage,v_ledger.current_stage,v_ledger.status,v_ledger.assigned_to,v_note,v_actor,v_ledger.version);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_provider,v_actor,'crm_onboarding_workflow_updated','crm_onboarding_ledgers',v_ledger.id,jsonb_build_object('account_organization_id',p_account_organization_id,'from_stage',v_previous_stage,'stage',v_ledger.current_stage,'assigned_to',v_ledger.assigned_to,'version',v_ledger.version));
  return v_ledger;
end;$$;

create or replace function public.activate_crm_account(p_account_organization_id uuid,p_agreement_id uuid,p_expected_organization_updated_at timestamptz,p_expected_ledger_version integer)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_org public.organizations%rowtype;v_ledger public.crm_onboarding_ledgers%rowtype;v_agreement public.service_agreements%rowtype;v_readiness jsonb;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  select * into v_org from public.organizations where id=p_account_organization_id for update;if not found or v_org.parent_organization_id is distinct from v_provider then raise exception 'Managed CRM account not found';end if;if v_org.status<>'prospect' or v_org.active then raise exception 'Only an inactive prospect can be activated';end if;if v_org.updated_at is distinct from p_expected_organization_updated_at then raise exception 'Organization changed since activation review';end if;
  select * into v_ledger from public.crm_onboarding_ledgers where provider_organization_id=v_provider and account_organization_id=v_org.id for update;if not found or v_ledger.version<>p_expected_ledger_version then raise exception 'Onboarding ledger changed since activation review';end if;if v_ledger.current_stage<>'review' then raise exception 'Onboarding must be in review before activation';end if;if v_ledger.assigned_to is null or nullif(trim(v_ledger.stage_note),'') is null then raise exception 'Named onboarding owner and review note required before activation';end if;
  select * into v_agreement from public.service_agreements where id=p_agreement_id and provider_organization_id=v_provider and client_organization_id=v_org.id and agreement_type='operational' for update;if not found or v_agreement.invitation_status<>'accepted' then raise exception 'Accepted operational agreement required';end if;
  if not exists(select 1 from public.crm_contacts c where c.organization_id=v_org.id and c.is_primary and c.deactivated_at is null) then raise exception 'Active primary contact required';end if;v_readiness:=public.get_crm_operational_readiness(v_agreement.id);if not coalesce((v_readiness->>'ready')::boolean,false) then raise exception 'Operational readiness blockers remain';end if;
  update public.organizations set status='active',active=true,updated_at=clock_timestamp() where id=v_org.id returning * into v_org;update public.crm_onboarding_ledgers set current_stage='activated',status='activated',version=version+1,activated_at=clock_timestamp(),activated_by=v_actor,updated_at=clock_timestamp() where id=v_ledger.id returning * into v_ledger;
  insert into public.crm_onboarding_events(ledger_id,provider_organization_id,account_organization_id,event_type,from_stage,to_stage,ledger_status,assigned_to,note,actor_user_id,ledger_version) values(v_ledger.id,v_provider,v_org.id,'activated','review','activated','activated',v_ledger.assigned_to,'Account activated after governed readiness review',v_actor,v_ledger.version);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_provider,v_actor,'crm_account_activated','organizations',v_org.id,jsonb_build_object('agreement_id',v_agreement.id,'ledger_id',v_ledger.id,'assigned_to',v_ledger.assigned_to,'ledger_version',v_ledger.version));
  return jsonb_build_object('account_organization_id',v_org.id,'organization_status',v_org.status,'ledger_status',v_ledger.status,'activated_at',v_ledger.activated_at);
end;$$;

revoke all on function public.get_crm_onboarding_assignees(),public.get_crm_onboarding_workspace(),public.get_crm_onboarding_history(uuid),public.manage_crm_onboarding_workflow(uuid,integer,text,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.get_crm_onboarding_assignees(),public.get_crm_onboarding_workspace(),public.get_crm_onboarding_history(uuid),public.manage_crm_onboarding_workflow(uuid,integer,text,timestamptz,uuid,text) to authenticated,service_role;