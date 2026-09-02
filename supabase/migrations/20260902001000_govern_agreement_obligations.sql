alter table public.agreement_obligations
  add column if not exists updated_at timestamp with time zone not null default now();

create unique index if not exists agreement_obligations_agreement_code_key
  on public.agreement_obligations(service_agreement_id, obligation_code)
  where obligation_code is not null;

create or replace function public.get_crm_agreement_setup(p_agreement_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_agreement public.service_agreements%rowtype;
begin
  select sa.* into v_agreement from public.service_agreements sa where sa.id=p_agreement_id;
  if not found then raise exception 'Service agreement not found';end if;
  if v_actor is null or not public.is_admin_for_org(v_agreement.provider_organization_id) then raise exception 'Provider administrator required';end if;
  return jsonb_build_object(
    'agreement',jsonb_build_object('id',v_agreement.id,'name',v_agreement.name,'client_organization_id',v_agreement.client_organization_id,'invitation_status',v_agreement.invitation_status,'enabled_modules',v_agreement.enabled_modules),
    'sites',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'address',s.address,'boundary_status',s.boundary_status,'boundary_verification',s.boundary_verification,'linked',sal.id is not null,'link_status',sal.status) order by s.name),'[]'::jsonb) from public.client_sites s left join public.service_agreement_locations sal on sal.service_agreement_id=v_agreement.id and sal.site_id=s.id where s.client_organization_id=v_agreement.client_organization_id and s.active),
    'modules',(select coalesce(jsonb_agg(jsonb_build_object('module_key',mc.module_key,'enabled',coalesce(sam.enabled,false),'sla_minutes',sam.sla_minutes,'allows_client_submission',coalesce(sam.allows_client_submission,false),'allows_auto_dispatch',coalesce(sam.allows_auto_dispatch,false)) order by mc.module_key),'[]'::jsonb) from public.module_catalog mc left join public.service_agreement_modules sam on sam.service_agreement_id=v_agreement.id and sam.module_key=mc.module_key where mc.active),
    'obligations',(select coalesce(jsonb_agg(jsonb_build_object('id',ao.id,'obligation_code',ao.obligation_code,'obligation_type',ao.obligation_type,'description',ao.description,'sla_target_minutes',ao.sla_target_minutes,'requires_proof',ao.requires_proof,'proof_artifact_type',ao.proof_artifact_type,'escalation_minutes',ao.escalation_minutes,'escalation_contact',ao.escalation_contact,'site_id',ao.site_id,'frequency_rule',ao.frequency_rule,'active',ao.active,'updated_at',ao.updated_at) order by ao.active desc,ao.obligation_code),'[]'::jsonb) from public.agreement_obligations ao where ao.service_agreement_id=v_agreement.id)
  );
end;$$;

create function public.manage_crm_agreement_obligation(
  p_agreement_id uuid,
  p_action text,
  p_obligation_id uuid default null,
  p_expected_updated_at timestamp with time zone default null,
  p_obligation_code text default null,
  p_obligation_type text default null,
  p_description text default null,
  p_sla_target_minutes integer default null,
  p_requires_proof boolean default false,
  p_proof_artifact_type text default null,
  p_escalation_minutes integer default null,
  p_escalation_contact text default null,
  p_site_id uuid default null,
  p_frequency_rule jsonb default null
)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare
  v_actor uuid:=auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_obligation public.agreement_obligations%rowtype;
  v_code text:=upper(nullif(btrim(p_obligation_code),''));
begin
  select sa.* into v_agreement from public.service_agreements sa where sa.id=p_agreement_id for update;
  if not found then raise exception 'Service agreement not found';end if;
  if v_actor is null or not public.is_admin_for_org(v_agreement.provider_organization_id) then raise exception 'Provider administrator required';end if;
  if v_agreement.agreement_type<>'operational' or v_agreement.invitation_status<>'accepted' then raise exception 'Only accepted operational agreements can be configured';end if;
  if p_action is null or p_action not in('save','deactivate') then raise exception 'Unsupported obligation action';end if;

  if p_obligation_id is not null then
    select ao.* into v_obligation from public.agreement_obligations ao where ao.id=p_obligation_id and ao.service_agreement_id=v_agreement.id for update;
    if not found then raise exception 'Agreement obligation not found';end if;
    if p_expected_updated_at is null or v_obligation.updated_at is distinct from p_expected_updated_at then raise exception 'Agreement obligation changed since it was opened';end if;
  end if;

  if p_action='deactivate' then
    if p_obligation_id is null then raise exception 'Agreement obligation required';end if;
    update public.agreement_obligations set active=false,updated_at=clock_timestamp() where id=v_obligation.id returning * into v_obligation;
  else
    if v_code is null or v_code!~'^[A-Z0-9][A-Z0-9._-]{1,63}$' then raise exception 'Obligation code must be 2-64 letters, numbers, dots, dashes, or underscores';end if;
    if nullif(btrim(p_description),'') is null then raise exception 'Obligation description required';end if;
    if p_obligation_type is null or p_obligation_type not in('response_time','patrol_frequency','report_delivery','incident_escalation','compliance_check','custom') then raise exception 'Valid obligation type required';end if;
    if p_sla_target_minutes is not null and p_sla_target_minutes<1 then raise exception 'SLA target must be positive';end if;
    if p_escalation_minutes is not null and p_escalation_minutes<1 then raise exception 'Escalation time must be positive';end if;
    if coalesce(p_requires_proof,false) and (p_proof_artifact_type is null or p_proof_artifact_type not in('photo','gps_track','report','signature','timestamp','other')) then raise exception 'Proof artifact type required';end if;
    if p_site_id is not null and not exists(select 1 from public.service_agreement_locations sal where sal.service_agreement_id=v_agreement.id and sal.site_id=p_site_id and sal.status='active') then raise exception 'Obligation site must be in active agreement coverage';end if;

    if p_obligation_id is null then
      insert into public.agreement_obligations(service_agreement_id,obligation_code,obligation_type,description,sla_target_minutes,requires_proof,proof_artifact_type,escalation_minutes,escalation_contact,site_id,frequency_rule,active)
      values(v_agreement.id,v_code,p_obligation_type,btrim(p_description),p_sla_target_minutes,coalesce(p_requires_proof,false),case when coalesce(p_requires_proof,false) then p_proof_artifact_type else null end,p_escalation_minutes,nullif(btrim(p_escalation_contact),''),p_site_id,p_frequency_rule,true)
      returning * into v_obligation;
    else
      update public.agreement_obligations set obligation_code=v_code,obligation_type=p_obligation_type,description=btrim(p_description),sla_target_minutes=p_sla_target_minutes,requires_proof=coalesce(p_requires_proof,false),proof_artifact_type=case when coalesce(p_requires_proof,false) then p_proof_artifact_type else null end,escalation_minutes=p_escalation_minutes,escalation_contact=nullif(btrim(p_escalation_contact),''),site_id=p_site_id,frequency_rule=p_frequency_rule,active=true,updated_at=clock_timestamp() where id=v_obligation.id returning * into v_obligation;
    end if;
  end if;

  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_agreement.provider_organization_id,v_actor,'crm_agreement_obligation_'||p_action,'agreement_obligations',v_obligation.id,jsonb_build_object('agreement_id',v_agreement.id,'obligation_code',v_obligation.obligation_code,'active',v_obligation.active));
  return to_jsonb(v_obligation);
exception when unique_violation then
  raise exception 'Obligation code already exists for this agreement';
end;$$;

revoke insert,update,delete,truncate on public.agreement_obligations from public,anon,authenticated;
revoke all on function public.manage_crm_agreement_obligation(uuid,text,uuid,timestamp with time zone,text,text,text,integer,boolean,text,integer,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.manage_crm_agreement_obligation(uuid,text,uuid,timestamp with time zone,text,text,text,integer,boolean,text,integer,text,uuid,jsonb) to authenticated,service_role;
