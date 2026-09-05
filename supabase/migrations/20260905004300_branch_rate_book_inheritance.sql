-- An operating branch owns its price decisions. Parent rate books are visible
-- only as explicit fallback templates for proposals and remain snapshot-bound.
CREATE OR REPLACE FUNCTION public.manage_crm_quote_proposal_module(
  p_client_request_id uuid,
  p_quote_id uuid,
  p_action text,
  p_module_key text,
  p_sla_minutes integer DEFAULT NULL,
  p_service_window jsonb DEFAULT '{}'::jsonb,
  p_pricing_basis text DEFAULT 'quote_lines',
  p_rate_rule_id uuid DEFAULT NULL
)
RETURNS public.quote_proposal_modules
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_quote public.quotes%rowtype;
  v_module public.quote_proposal_modules%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_quote from public.quotes where id = p_quote_id for update;
  if not found or not public.is_admin_for_org(v_quote.provider_org_id) then raise exception 'Quote not found in your organization'; end if;
  if v_quote.status <> 'draft' then raise exception 'Proposal modules can only be changed on a draft quote'; end if;
  if p_action not in ('set', 'remove') then raise exception 'Unsupported proposal module action'; end if;
  if not exists (select 1 from public.module_catalog catalog where catalog.module_key = p_module_key and catalog.active) then raise exception 'Active module catalog entry required'; end if;
  if p_sla_minutes is not null and (p_sla_minutes < 1 or p_sla_minutes > 10080) then raise exception 'Module SLA must be between 1 and 10080 minutes'; end if;
  if p_pricing_basis not in ('quote_lines', 'standard_rate_rule', 'site_override_pending') then raise exception 'Unsupported pricing basis'; end if;
  if p_rate_rule_id is not null and not exists (
    with recursive provider_tree as (
      select organization.id, organization.parent_organization_id from public.organizations organization where organization.id = v_quote.provider_org_id
      union all
      select parent.id, parent.parent_organization_id from public.organizations parent join provider_tree child on child.parent_organization_id = parent.id
    )
    select 1 from public.rate_rules rule where rule.id = p_rate_rule_id and rule.organization_id in (select id from provider_tree) and rule.rule_kind = 'billing' and rule.active and (rule.module_key is null or rule.module_key = p_module_key)
  ) then raise exception 'Active operating-provider or parent-template billing rate rule required for this module'; end if;
  select * into v_module from public.quote_proposal_modules where quote_id = v_quote.id and client_request_id = p_client_request_id;
  if found then return v_module; end if;
  if p_action = 'remove' then
    delete from public.quote_proposal_modules where quote_id = v_quote.id and module_key = p_module_key returning * into v_module;
    if not found then raise exception 'Proposal module not found'; end if;
  else
    insert into public.quote_proposal_modules(quote_id,module_key,sla_minutes,service_window,pricing_basis,rate_rule_id,client_request_id,created_by)
    values(v_quote.id,p_module_key,p_sla_minutes,coalesce(p_service_window,'{}'::jsonb),p_pricing_basis,p_rate_rule_id,p_client_request_id,v_actor)
    on conflict(quote_id,module_key) do update set sla_minutes=excluded.sla_minutes,service_window=excluded.service_window,pricing_basis=excluded.pricing_basis,rate_rule_id=excluded.rate_rule_id
    returning * into v_module;
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_quote.provider_org_id,v_actor,'crm_quote_proposal_module_' || p_action,'quote_proposal_modules',v_module.id,jsonb_build_object('quote_id',v_quote.id,'module_key',p_module_key,'pricing_basis',p_pricing_basis,'rate_rule_id',p_rate_rule_id));
  return v_module;
end;
$$;