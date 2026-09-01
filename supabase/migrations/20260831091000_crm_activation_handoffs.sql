create table public.crm_activation_handoffs(
  id uuid primary key default gen_random_uuid(),
  provider_organization_id uuid not null references public.organizations(id) on delete cascade,
  account_organization_id uuid not null references public.organizations(id) on delete cascade,
  agreement_id uuid not null references public.service_agreements(id) on delete restrict,
  onboarding_ledger_id uuid not null unique references public.crm_onboarding_ledgers(id) on delete restrict,
  owner_user_id uuid references public.user_profiles(id) on delete set null,
  status text not null default 'open' check(status in('open','completed')),
  version integer not null default 1,
  activated_at timestamptz not null,
  completed_at timestamptz,
  completed_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.crm_activation_handoff_tasks(
  id uuid primary key default gen_random_uuid(),
  handoff_id uuid not null references public.crm_activation_handoffs(id) on delete cascade,
  task_key text not null check(task_key in('site_briefing','first_roster_action','reporting_handoff')),
  title text not null,
  destination text not null check(destination in('site-360','roster','reports')),
  status text not null default 'pending' check(status in('pending','completed')),
  completion_note text,
  completed_at timestamptz,
  completed_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  unique(handoff_id,task_key)
);

create index crm_activation_handoffs_provider_status_idx on public.crm_activation_handoffs(provider_organization_id,status,activated_at desc);
alter table public.crm_activation_handoffs enable row level security;
alter table public.crm_activation_handoff_tasks enable row level security;
revoke all on table public.crm_activation_handoffs,public.crm_activation_handoff_tasks from public,anon,authenticated;
grant all on table public.crm_activation_handoffs,public.crm_activation_handoff_tasks to service_role;

create function public.seed_crm_activation_handoff() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_agreement_id uuid;v_handoff_id uuid;
begin
  if new.status='activated' and old.status is distinct from 'activated' then
    select sa.id into v_agreement_id from public.service_agreements sa where sa.provider_organization_id=new.provider_organization_id and sa.client_organization_id=new.account_organization_id and sa.agreement_type='operational' and sa.invitation_status='accepted' order by sa.created_at desc limit 1;
    if v_agreement_id is null then raise exception 'Accepted operational agreement required for activation handoff';end if;
    insert into public.crm_activation_handoffs(provider_organization_id,account_organization_id,agreement_id,onboarding_ledger_id,owner_user_id,activated_at)
    values(new.provider_organization_id,new.account_organization_id,v_agreement_id,new.id,new.assigned_to,coalesce(new.activated_at,clock_timestamp())) on conflict(onboarding_ledger_id) do update set owner_user_id=excluded.owner_user_id returning id into v_handoff_id;
    insert into public.crm_activation_handoff_tasks(handoff_id,task_key,title,destination) values
      (v_handoff_id,'site_briefing','Confirm site access and safety briefing','site-360'),
      (v_handoff_id,'first_roster_action','Publish the first operational roster action','roster'),
      (v_handoff_id,'reporting_handoff','Confirm reporting delivery handoff','reports')
    on conflict(handoff_id,task_key) do nothing;
  end if;
  return new;
end;$$;

create trigger trg_seed_crm_activation_handoff after update of status on public.crm_onboarding_ledgers for each row execute function public.seed_crm_activation_handoff();

with activated as(
  select l.*,sa.id agreement_id from public.crm_onboarding_ledgers l join lateral(select a.id from public.service_agreements a where a.provider_organization_id=l.provider_organization_id and a.client_organization_id=l.account_organization_id and a.agreement_type='operational' and a.invitation_status='accepted' order by a.created_at desc limit 1)sa on true where l.status='activated'
),inserted as(
  insert into public.crm_activation_handoffs(provider_organization_id,account_organization_id,agreement_id,onboarding_ledger_id,owner_user_id,activated_at)
  select provider_organization_id,account_organization_id,agreement_id,id,assigned_to,activated_at from activated on conflict(onboarding_ledger_id) do nothing returning id
)
select count(*) from inserted;

insert into public.crm_activation_handoff_tasks(handoff_id,task_key,title,destination)
select h.id,v.task_key,v.title,v.destination from public.crm_activation_handoffs h cross join(values
  ('site_briefing','Confirm site access and safety briefing','site-360'),
  ('first_roster_action','Publish the first operational roster action','roster'),
  ('reporting_handoff','Confirm reporting delivery handoff','reports')
)v(task_key,title,destination) on conflict(handoff_id,task_key) do nothing;

create function public.get_crm_activation_handoffs()
returns table(handoff_id uuid,account_organization_id uuid,account_name text,agreement_id uuid,agreement_name text,owner_user_id uuid,owner_name text,handoff_status text,version integer,activated_at timestamptz,completed_at timestamptz,tasks jsonb,sites jsonb,work_units jsonb,first_roster_at timestamptz)
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  return query select h.id,o.id,o.name,sa.id,sa.name,h.owner_user_id,u.display_name,h.status,h.version,h.activated_at,h.completed_at,
    (select coalesce(jsonb_agg(jsonb_build_object('task_id',t.id,'task_key',t.task_key,'title',t.title,'destination',t.destination,'status',t.status,'completion_note',t.completion_note,'completed_at',t.completed_at,'completed_by_name',cu.display_name) order by t.created_at),'[]'::jsonb) from public.crm_activation_handoff_tasks t left join public.user_profiles cu on cu.id=t.completed_by where t.handoff_id=h.id),
    (select coalesce(jsonb_agg(jsonb_build_object('site_id',s.id,'name',s.name,'address',s.address,'risk_level',s.risk_level,'access_instructions',s.access_instructions,'hs_notes',s.hs_notes) order by s.name),'[]'::jsonb) from public.service_agreement_locations sal join public.client_sites s on s.id=sal.site_id where sal.service_agreement_id=h.agreement_id and sal.status='active'),
    (select coalesce(jsonb_agg(jsonb_build_object('work_unit_id',wu.id,'name',wu.name,'service_type',wu.service_type,'active',wu.active) order by wu.name),'[]'::jsonb) from public.roster_work_units wu join public.service_agreement_locations sal on sal.id=wu.service_agreement_location_id where sal.service_agreement_id=h.agreement_id and sal.status='active'),
    (select min(rs.scheduled_start) from public.roster_slots rs join public.roster_work_units wu on wu.id=rs.work_unit_id join public.service_agreement_locations sal on sal.id=wu.service_agreement_location_id where sal.service_agreement_id=h.agreement_id and rs.status in('published','accepted','completed') and rs.scheduled_start>=h.activated_at)
  from public.crm_activation_handoffs h join public.organizations o on o.id=h.account_organization_id join public.service_agreements sa on sa.id=h.agreement_id left join public.user_profiles u on u.id=h.owner_user_id
  where h.provider_organization_id=v_provider order by case when h.status='open' then 0 else 1 end,h.activated_at desc;
end;$$;

create function public.manage_crm_activation_handoff_task(p_handoff_id uuid,p_task_id uuid,p_expected_version integer,p_complete boolean,p_note text)
returns public.crm_activation_handoffs language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_handoff public.crm_activation_handoffs%rowtype;v_task public.crm_activation_handoff_tasks%rowtype;v_note text:=trim(coalesce(p_note,''));v_all_complete boolean;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  select * into v_handoff from public.crm_activation_handoffs h where h.id=p_handoff_id and h.provider_organization_id=v_provider for update;
  if not found then raise exception 'Activation handoff not found';end if;
  if v_handoff.version<>p_expected_version then raise exception 'Activation handoff changed since it was opened';end if;
  select * into v_task from public.crm_activation_handoff_tasks t where t.id=p_task_id and t.handoff_id=v_handoff.id for update;
  if not found then raise exception 'Activation handoff task not found';end if;
  if char_length(v_note) not between 3 and 1000 then raise exception 'Completion note must be between 3 and 1000 characters';end if;
  if p_complete and v_task.task_key='first_roster_action' and not exists(select 1 from public.roster_slots rs join public.roster_work_units wu on wu.id=rs.work_unit_id join public.service_agreement_locations sal on sal.id=wu.service_agreement_location_id where sal.service_agreement_id=v_handoff.agreement_id and rs.status in('published','accepted','completed') and rs.scheduled_start>=v_handoff.activated_at) then raise exception 'Publish the first post-activation roster action before completing this task';end if;
  update public.crm_activation_handoff_tasks set status=case when p_complete then 'completed' else 'pending' end,completion_note=v_note,completed_at=case when p_complete then clock_timestamp() else null end,completed_by=case when p_complete then v_actor else null end where id=v_task.id;
  select not exists(select 1 from public.crm_activation_handoff_tasks t where t.handoff_id=v_handoff.id and t.status<>'completed') into v_all_complete;
  update public.crm_activation_handoffs set status=case when v_all_complete then 'completed' else 'open' end,version=version+1,completed_at=case when v_all_complete then clock_timestamp() else null end,completed_by=case when v_all_complete then v_actor else null end,updated_at=clock_timestamp() where id=v_handoff.id returning * into v_handoff;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_provider,v_actor,'crm_activation_handoff_task_'||case when p_complete then 'completed' else 'reopened' end,'crm_activation_handoff_tasks',v_task.id,jsonb_build_object('handoff_id',v_handoff.id,'task_key',v_task.task_key,'handoff_status',v_handoff.status,'handoff_version',v_handoff.version,'note',v_note));
  return v_handoff;
end;$$;

revoke all on function public.seed_crm_activation_handoff(),public.get_crm_activation_handoffs(),public.manage_crm_activation_handoff_task(uuid,uuid,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.get_crm_activation_handoffs(),public.manage_crm_activation_handoff_task(uuid,uuid,integer,boolean,text) to authenticated,service_role;
grant execute on function public.seed_crm_activation_handoff() to service_role;