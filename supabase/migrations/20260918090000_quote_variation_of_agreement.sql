-- 20260918090000_quote_variation_of_agreement.sql
-- Contract variations. Real council contracts grow by dated variations that add
-- places or change fees on the SAME agreement (e.g. NCC contract 4038, variation 9
-- adding Maitai Valley Campground). accept_quote already links a quote onto
-- quotes.service_agreement_id when it is set, and the acceptance trigger appends
-- delivery schedules, agreement locations, and site services to that agreement.
-- The missing seam was a governed way to raise a draft quote AGAINST an existing
-- agreement instead of spawning a second agreement named after the quote title.

DROP FUNCTION IF EXISTS public.create_crm_draft_quote_for_provider(uuid, uuid, uuid, text, numeric, date, text);

CREATE OR REPLACE FUNCTION public.create_crm_draft_quote_for_provider(
  p_client_request_id uuid,
  p_operating_provider_organization_id uuid,
  p_client_org_id uuid,
  p_title text,
  p_target_margin_pct numeric DEFAULT 0,
  p_valid_until date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_service_agreement_id uuid DEFAULT NULL
)
RETURNS public.quotes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider public.organizations%rowtype;
  v_client public.organizations%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_quote public.quotes%rowtype;
  v_title text := nullif(trim(coalesce(p_title, '')), '');
  v_provider_tree uuid[];
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_provider from public.organizations where id = p_operating_provider_organization_id;
  if not found or not public.is_admin_for_org(v_provider.id) then raise exception 'Operating provider organization is not available for management'; end if;
  if v_provider.organization_type not in ('owner', 'service_provider', 'branch') then raise exception 'Operating provider must be a service provider or internal branch'; end if;
  v_provider_tree := public.get_descendant_organizations(coalesce(v_provider.parent_organization_id, v_provider.id));
  select * into v_client from public.organizations where id = p_client_org_id;
  if not found or not (
    (v_client.active and v_client.status = 'active')
    or (
      not v_client.active
      and v_client.status = 'prospect'
      and exists(
        select 1
        from public.crm_onboarding_ledgers ledger
        where ledger.provider_organization_id = any(v_provider_tree)
          and ledger.account_organization_id = v_client.id
          and ledger.status <> 'activated'
      )
    )
  ) then raise exception 'An active client organization is required for a service proposal'; end if;
  if v_client.id = v_provider.id then raise exception 'A provider cannot create a service proposal for itself'; end if;
  if v_title is null then raise exception 'Quote title is required'; end if;
  if p_target_margin_pct < 0 or p_target_margin_pct >= 100 then raise exception 'Target margin must be between zero and 100'; end if;
  if p_valid_until is not null and p_valid_until < current_date then raise exception 'Quote validity date cannot be in the past'; end if;

  if p_service_agreement_id is not null then
    select * into v_agreement from public.service_agreements where id = p_service_agreement_id;
    if not found then raise exception 'The agreement this variation changes could not be found'; end if;
    if v_agreement.client_organization_id <> v_client.id then raise exception 'A variation must change an agreement held by the same client'; end if;
    if v_agreement.agreement_type <> 'operational' then raise exception 'Only operational service agreements can be varied'; end if;
    if v_agreement.provider_organization_id <> v_provider.id and not (v_agreement.provider_organization_id = any(v_provider_tree)) then
      raise exception 'A variation must change an agreement delivered by this provider or its branches';
    end if;
    if v_agreement.ends_on is not null and v_agreement.ends_on < current_date then
      raise exception 'This agreement has ended. Raise a new agreement instead of a variation';
    end if;
  end if;

  select * into v_quote from public.quotes quote where quote.provider_org_id = v_provider.id and quote.client_request_id = p_client_request_id;
  if found then return v_quote; end if;

  insert into public.quotes(provider_org_id,client_org_id,title,status,currency,target_margin_pct,valid_until,notes,client_request_id,service_agreement_id,created_by,updated_by)
  values(v_provider.id,v_client.id,v_title,'draft','NZD',p_target_margin_pct,p_valid_until,nullif(trim(coalesce(p_notes,'')),''),p_client_request_id,p_service_agreement_id,v_actor,v_actor)
  returning * into v_quote;

  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_provider.id,v_actor,'crm_draft_quote_created_for_operating_provider','quotes',v_quote.id,jsonb_build_object(
    'operating_provider_organization_id',v_provider.id,
    'client_org_id',v_client.id,
    'title',v_title,
    'relationship_state',case when p_service_agreement_id is null then 'proposal_only' else 'variation_of_agreement' end,
    'service_agreement_id',p_service_agreement_id,
    'service_agreement_name',v_agreement.name));
  return v_quote;
end;
$$;

REVOKE ALL ON FUNCTION public.create_crm_draft_quote_for_provider(uuid, uuid, uuid, text, numeric, date, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_crm_draft_quote_for_provider(uuid, uuid, uuid, text, numeric, date, text, uuid) TO postgres, authenticated, service_role;

COMMENT ON FUNCTION public.create_crm_draft_quote_for_provider(uuid, uuid, uuid, text, numeric, date, text, uuid) IS
  'Create an idempotent draft quote for a client on behalf of an operating provider/branch. When p_service_agreement_id is given the quote is a VARIATION of that existing operational agreement (same client, provider tree, not ended): on acceptance its places, delivery schedules, and prices are appended to that agreement instead of creating a new one.';
