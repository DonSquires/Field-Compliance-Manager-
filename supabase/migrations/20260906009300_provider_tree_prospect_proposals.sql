CREATE OR REPLACE FUNCTION public.create_crm_draft_quote_for_provider(
  p_client_request_id uuid,
  p_operating_provider_organization_id uuid,
  p_client_org_id uuid,
  p_title text,
  p_target_margin_pct numeric DEFAULT 0,
  p_valid_until date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.quotes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider public.organizations%rowtype;
  v_client public.organizations%rowtype;
  v_quote public.quotes%rowtype;
  v_title text := nullif(trim(coalesce(p_title, '')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_provider from public.organizations where id = p_operating_provider_organization_id;
  if not found or not public.is_admin_for_org(v_provider.id) then raise exception 'Operating provider organization is not available for management'; end if;
  if v_provider.organization_type not in ('owner', 'service_provider', 'branch') then raise exception 'Operating provider must be a service provider or internal branch'; end if;
  select * into v_client from public.organizations where id = p_client_org_id;
  if not found or not (
    (v_client.active and v_client.status = 'active')
    or (
      not v_client.active
      and v_client.status = 'prospect'
      and exists(
        select 1
        from public.crm_onboarding_ledgers ledger
        where ledger.provider_organization_id = any(public.get_descendant_organizations(coalesce(v_provider.parent_organization_id, v_provider.id)))
          and ledger.account_organization_id = v_client.id
          and ledger.status <> 'activated'
      )
    )
  ) then raise exception 'An active client organization is required for a service proposal'; end if;
  if v_client.id = v_provider.id then raise exception 'A provider cannot create a service proposal for itself'; end if;
  if v_title is null then raise exception 'Quote title is required'; end if;
  if p_target_margin_pct < 0 or p_target_margin_pct >= 100 then raise exception 'Target margin must be between zero and 100'; end if;
  if p_valid_until is not null and p_valid_until < current_date then raise exception 'Quote validity date cannot be in the past'; end if;
  select * into v_quote from public.quotes quote where quote.provider_org_id = v_provider.id and quote.client_request_id = p_client_request_id;
  if found then return v_quote; end if;
  insert into public.quotes(provider_org_id,client_org_id,title,status,currency,target_margin_pct,valid_until,notes,client_request_id,created_by,updated_by)
  values(v_provider.id,v_client.id,v_title,'draft','NZD',p_target_margin_pct,p_valid_until,nullif(trim(coalesce(p_notes,'')),''),p_client_request_id,v_actor,v_actor)
  returning * into v_quote;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_provider.id,v_actor,'crm_draft_quote_created_for_operating_provider','quotes',v_quote.id,jsonb_build_object('operating_provider_organization_id',v_provider.id,'client_org_id',v_client.id,'title',v_title,'relationship_state','proposal_only'));
  return v_quote;
end;
$$;

REVOKE ALL ON FUNCTION public.create_crm_draft_quote_for_provider(uuid,uuid,uuid,text,numeric,date,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_crm_draft_quote_for_provider(uuid,uuid,uuid,text,numeric,date,text) TO authenticated, service_role;
