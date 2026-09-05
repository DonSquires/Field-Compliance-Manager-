-- A proposal scope joins a quoted module to an exact Site XOR Zone. It is
-- commercial intent until the quote has been accepted and linked to an agreement.
CREATE TABLE IF NOT EXISTS public.quote_proposal_service_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  module_key text NOT NULL REFERENCES public.module_catalog(module_key) ON DELETE RESTRICT,
  site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  zone_id uuid,
  client_request_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_proposal_service_scopes_place_xor CHECK ((site_id IS NOT NULL AND zone_id IS NULL) OR (site_id IS NULL AND zone_id IS NOT NULL)),
  CONSTRAINT quote_proposal_service_scopes_request_unique UNIQUE (quote_id, client_request_id),
  CONSTRAINT quote_proposal_service_scopes_unique UNIQUE NULLS NOT DISTINCT (quote_id, module_key, site_id, zone_id)
);

ALTER TABLE public.quote_proposal_service_scopes ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_proposal_service_scopes_select ON public.quote_proposal_service_scopes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.quotes quote WHERE quote.id = quote_id AND public.org_access_allowed(quote.provider_org_id)));
REVOKE ALL ON TABLE public.quote_proposal_service_scopes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.quote_proposal_service_scopes TO authenticated;
GRANT ALL ON TABLE public.quote_proposal_service_scopes TO service_role;

CREATE OR REPLACE FUNCTION public.manage_crm_quote_proposal_service_scope(
  p_client_request_id uuid,
  p_quote_id uuid,
  p_action text,
  p_module_key text,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL
)
RETURNS public.quote_proposal_service_scopes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_quote public.quotes%rowtype;
  v_scope public.quote_proposal_service_scopes%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_quote from public.quotes where id = p_quote_id for update;
  if not found or not public.is_admin_for_org(v_quote.provider_org_id) then raise exception 'Quote not found in your organization'; end if;
  if v_quote.status <> 'draft' then raise exception 'Proposal service scopes can only be changed on a draft quote'; end if;
  if p_action not in ('set', 'remove') then raise exception 'Unsupported proposal service scope action'; end if;
  if not exists (select 1 from public.quote_proposal_modules module where module.quote_id = v_quote.id and module.module_key = p_module_key) then raise exception 'Proposal scope requires a selected quote module'; end if;
  if (p_site_id is null) = (p_zone_id is null) then raise exception 'Proposal scope requires exactly one Site or Zone'; end if;
  if p_site_id is not null and not exists (select 1 from public.client_sites site where site.id = p_site_id and site.client_organization_id = v_quote.client_org_id and site.active) then raise exception 'Active Site does not belong to this quote client'; end if;
  if p_zone_id is not null and not exists (select 1 from public.location_zones zone where zone.id = p_zone_id and zone.organization_id = v_quote.client_org_id and zone.is_active) then raise exception 'Active Zone does not belong to this quote client'; end if;

  select * into v_scope from public.quote_proposal_service_scopes where quote_id = v_quote.id and client_request_id = p_client_request_id;
  if found then return v_scope; end if;
  if p_action = 'remove' then
    delete from public.quote_proposal_service_scopes where quote_id = v_quote.id and module_key = p_module_key and site_id is not distinct from p_site_id and zone_id is not distinct from p_zone_id returning * into v_scope;
    if not found then raise exception 'Proposal service scope not found'; end if;
  else
    insert into public.quote_proposal_service_scopes(quote_id,module_key,site_id,zone_id,client_request_id,created_by)
    values(v_quote.id,p_module_key,p_site_id,p_zone_id,p_client_request_id,v_actor)
    on conflict(quote_id,module_key,site_id,zone_id) do update set module_key = excluded.module_key
    returning * into v_scope;
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_quote.provider_org_id,v_actor,'crm_quote_proposal_service_scope_' || p_action,'quote_proposal_service_scopes',v_scope.id,jsonb_build_object('quote_id',v_quote.id,'module_key',p_module_key,'site_id',p_site_id,'zone_id',p_zone_id));
  return v_scope;
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
      where not exists (select 1 from public.service_agreement_locations location where location.service_agreement_id = new.service_agreement_id and location.site_id is not distinct from scope.site_id and location.zone_id is not distinct from scope.zone_id)
      returning id into v_location_id;

      insert into public.site_services(organization_id,service_agreement_id,module_key,site_id,zone_id,service_hours,response_sla_minutes,config,enabled,active,created_by)
      select new.provider_org_id,new.service_agreement_id,scope.module_key,scope.site_id,scope.zone_id,module_intent.service_window,module_intent.sla_minutes,jsonb_build_object('proposal_scope_id',scope.id,'pricing_basis',module_intent.pricing_basis,'rate_rule_id',module_intent.rate_rule_id),true,true,new.accepted_by
      where not exists (select 1 from public.site_services service where service.service_agreement_id = new.service_agreement_id and service.module_key = scope.module_key and service.site_id is not distinct from scope.site_id and service.zone_id is not distinct from scope.zone_id);
    end loop;
  end if;
  return new;
end;
$$;

CREATE TRIGGER trg_activate_quote_proposal_service_scopes
  AFTER UPDATE OF status ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.activate_quote_proposal_service_scopes();

REVOKE ALL ON FUNCTION public.manage_crm_quote_proposal_service_scope(uuid,uuid,text,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_crm_quote_proposal_service_scope(uuid,uuid,text,text,uuid,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.activate_quote_proposal_service_scopes() FROM PUBLIC, anon, authenticated;