-- A quote is a proposal, not service authorization. Any active existing organization
-- may receive one; operational access begins only after the client accepts it.
CREATE OR REPLACE FUNCTION public.create_crm_draft_quote(
  p_client_request_id uuid,
  p_client_org_id uuid,
  p_title text,
  p_target_margin_pct numeric DEFAULT 0,
  p_valid_until date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.quotes
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_client public.organizations%rowtype;
  v_quote public.quotes%rowtype;
  v_title text := nullif(trim(coalesce(p_title, '')), '');
begin
  select profile.organization_id into v_provider from public.user_profiles profile where profile.id = v_actor and profile.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if v_title is null then raise exception 'Quote title is required'; end if;
  if p_target_margin_pct < 0 or p_target_margin_pct >= 100 then raise exception 'Target margin must be between zero and 100'; end if;
  if p_valid_until is not null and p_valid_until < current_date then raise exception 'Quote validity date cannot be in the past'; end if;

  select * into v_client from public.organizations where id = p_client_org_id;
  if not found or not v_client.active or v_client.status <> 'active' then raise exception 'An active organization is required for a service proposal'; end if;
  if v_client.id = v_provider then raise exception 'A provider cannot create a service proposal for itself'; end if;

  select * into v_quote from public.quotes quote where quote.provider_org_id = v_provider and quote.client_request_id = p_client_request_id;
  if found then return v_quote; end if;

  insert into public.quotes(provider_org_id,client_org_id,title,status,currency,target_margin_pct,valid_until,notes,client_request_id,created_by,updated_by)
  values(v_provider,v_client.id,v_title,'draft','NZD',p_target_margin_pct,p_valid_until,nullif(trim(coalesce(p_notes,'')),''),p_client_request_id,v_actor,v_actor)
  returning * into v_quote;

  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_provider,v_actor,'crm_draft_quote_created','quotes',v_quote.id,jsonb_build_object('client_org_id',v_client.id,'title',v_title,'target_margin_pct',p_target_margin_pct,'valid_until',p_valid_until,'relationship_state','proposal_only'));
  return v_quote;
end;
$$;

REVOKE ALL ON FUNCTION public.create_crm_draft_quote(uuid,uuid,text,numeric,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_crm_draft_quote(uuid,uuid,text,numeric,date,text) TO authenticated, service_role;
