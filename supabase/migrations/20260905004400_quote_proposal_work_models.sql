-- Work model describes what is charged. SLA and service windows remain delivery commitments.
ALTER TABLE public.quote_proposal_modules
  ADD COLUMN IF NOT EXISTS work_model text NOT NULL DEFAULT 'scheduled_patrol'
  CHECK (work_model IN ('scheduled_patrol', 'scheduled_static', 'on_demand_callout', 'inspection_or_notice', 'recurring_service'));

CREATE OR REPLACE FUNCTION public.set_crm_quote_proposal_work_model(
  p_quote_id uuid,
  p_module_key text,
  p_work_model text
)
RETURNS public.quote_proposal_modules
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_quote public.quotes%rowtype;
  v_module public.quote_proposal_modules%rowtype;
begin
  select * into v_quote from public.quotes where id = p_quote_id for update;
  if not found or not public.is_admin_for_org(v_quote.provider_org_id) then raise exception 'Quote not found in your organization'; end if;
  if v_quote.status <> 'draft' then raise exception 'Work model can only be changed on a draft quote'; end if;
  if p_work_model not in ('scheduled_patrol', 'scheduled_static', 'on_demand_callout', 'inspection_or_notice', 'recurring_service') then raise exception 'Unsupported proposal work model'; end if;
  update public.quote_proposal_modules set work_model = p_work_model where quote_id = v_quote.id and module_key = p_module_key returning * into v_module;
  if not found then raise exception 'Proposal module not found'; end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_quote.provider_org_id,auth.uid(),'crm_quote_proposal_work_model_set','quote_proposal_modules',v_module.id,jsonb_build_object('quote_id',v_quote.id,'module_key',p_module_key,'work_model',p_work_model));
  return v_module;
end;
$$;

CREATE OR REPLACE FUNCTION public.activate_quote_proposal_modules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare scope public.quote_proposal_modules%rowtype;
begin
  if new.status = 'accepted' and new.service_agreement_id is not null and old.status is distinct from 'accepted' then
    for scope in select * from public.quote_proposal_modules where quote_id = new.id loop
      insert into public.service_agreement_modules(service_agreement_id,module_key,enabled,sla_minutes,settings)
      values(new.service_agreement_id,scope.module_key,true,scope.sla_minutes,jsonb_build_object('proposal_service_window',scope.service_window,'work_model',scope.work_model,'pricing_basis',scope.pricing_basis,'rate_rule_id',scope.rate_rule_id))
      on conflict(service_agreement_id,module_key) do update set enabled=true,sla_minutes=coalesce(excluded.sla_minutes,service_agreement_modules.sla_minutes),settings=service_agreement_modules.settings || excluded.settings;
    end loop;
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.activate_quote_proposal_service_scopes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  scope public.quote_proposal_service_scopes%rowtype;
  module_intent public.quote_proposal_modules%rowtype;
  v_location_id uuid;
begin
  if new.status = 'accepted' and new.service_agreement_id is not null and old.status is distinct from 'accepted' then
    for scope in select * from public.quote_proposal_service_scopes where quote_id = new.id loop
      select * into module_intent from public.quote_proposal_modules where quote_id = new.id and module_key = scope.module_key;
      if not found then raise exception 'Accepted proposal scope has no quoted module'; end if;
      insert into public.service_agreement_locations(service_agreement_id,site_id,zone_id,status,created_by)
      select new.service_agreement_id,scope.site_id,scope.zone_id,'active',new.accepted_by
      where not exists (select 1 from public.service_agreement_locations location where location.service_agreement_id = new.service_agreement_id and location.site_id is not distinct from scope.site_id and location.zone_id is not distinct from scope.zone_id);
      insert into public.site_services(organization_id,service_agreement_id,module_key,site_id,zone_id,service_hours,response_sla_minutes,config,enabled,active,created_by)
      select new.provider_org_id,new.service_agreement_id,scope.module_key,scope.site_id,scope.zone_id,module_intent.service_window,module_intent.sla_minutes,jsonb_build_object('proposal_scope_id',scope.id,'work_model',module_intent.work_model,'pricing_basis',module_intent.pricing_basis,'rate_rule_id',module_intent.rate_rule_id),true,true,new.accepted_by
      where not exists (select 1 from public.site_services service where service.service_agreement_id = new.service_agreement_id and service.module_key = scope.module_key and service.site_id is not distinct from scope.site_id and service.zone_id is not distinct from scope.zone_id);
    end loop;
  end if;
  return new;
end;
$$;

REVOKE ALL ON FUNCTION public.set_crm_quote_proposal_work_model(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_crm_quote_proposal_work_model(uuid,text,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.activate_quote_proposal_modules() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_quote_proposal_service_scopes() FROM PUBLIC, anon, authenticated;