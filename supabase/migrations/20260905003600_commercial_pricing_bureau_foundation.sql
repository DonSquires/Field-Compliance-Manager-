-- Provider-owned pricing bureau: commercial schedules are separate from
-- operational agreements, and accepted quote terms are immutable snapshots.
CREATE TABLE IF NOT EXISTS public.commercial_discount_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  effective_from date NOT NULL DEFAULT current_date,
  effective_to date,
  notes text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  client_request_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_discount_schedules_date_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT commercial_discount_schedules_request_unique UNIQUE (provider_organization_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS public.commercial_discount_schedule_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.commercial_discount_schedules(id) ON DELETE CASCADE,
  module_key text REFERENCES public.module_catalog(module_key) ON DELETE RESTRICT,
  client_organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  site_id uuid REFERENCES public.client_sites(id) ON DELETE CASCADE,
  zone_id uuid,
  discount_kind text NOT NULL CHECK (discount_kind IN ('percentage', 'fixed_amount')),
  discount_value numeric(12,2) NOT NULL CHECK (discount_value >= 0),
  minimum_subtotal numeric(12,2),
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_discount_schedule_rules_percent_check CHECK (discount_kind <> 'percentage' OR discount_value <= 100),
  CONSTRAINT commercial_discount_schedule_rules_place_xor CHECK (site_id IS NULL OR zone_id IS NULL)
);

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS tender_id uuid REFERENCES public.tenders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discount_schedule_id uuid REFERENCES public.commercial_discount_schedules(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.quote_commercial_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE REFERENCES public.quotes(id) ON DELETE RESTRICT,
  provider_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  tender_id uuid REFERENCES public.tenders(id) ON DELETE SET NULL,
  discount_schedule_id uuid REFERENCES public.commercial_discount_schedules(id) ON DELETE SET NULL,
  currency text NOT NULL,
  gst_rate numeric(5,4) NOT NULL,
  discount_pct numeric(5,2) NOT NULL,
  total_cost numeric(12,2) NOT NULL,
  subtotal_charge numeric(12,2) NOT NULL,
  discount_amount numeric(12,2) NOT NULL,
  gst_amount numeric(12,2) NOT NULL,
  total_charge numeric(12,2) NOT NULL,
  pricing_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  accepted_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT
);

ALTER TABLE public.commercial_discount_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_discount_schedule_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_commercial_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY commercial_discount_schedules_select ON public.commercial_discount_schedules FOR SELECT TO authenticated
  USING (public.org_access_allowed(provider_organization_id));
CREATE POLICY commercial_discount_schedule_rules_select ON public.commercial_discount_schedule_rules FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.commercial_discount_schedules schedule WHERE schedule.id = schedule_id AND public.org_access_allowed(schedule.provider_organization_id)));
CREATE POLICY quote_commercial_snapshots_select ON public.quote_commercial_snapshots FOR SELECT TO authenticated
  USING (public.org_access_allowed(provider_organization_id) OR public.org_access_allowed(client_organization_id));

REVOKE ALL ON TABLE public.commercial_discount_schedules, public.commercial_discount_schedule_rules, public.quote_commercial_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.commercial_discount_schedules, public.commercial_discount_schedule_rules, public.quote_commercial_snapshots TO authenticated;
GRANT ALL ON TABLE public.commercial_discount_schedules, public.commercial_discount_schedule_rules, public.quote_commercial_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.manage_commercial_discount_schedule(
  p_client_request_id uuid,
  p_action text,
  p_schedule_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_effective_from date DEFAULT NULL,
  p_effective_to date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.commercial_discount_schedules
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_schedule public.commercial_discount_schedules%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select organization_id into v_provider from public.user_profiles where id = v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active finance administrator required'; end if;
  if p_action = 'create' then
    if v_name is null then raise exception 'Discount schedule name is required'; end if;
    if p_effective_to is not null and p_effective_to < coalesce(p_effective_from, current_date) then raise exception 'Effective end cannot precede effective start'; end if;
    select * into v_schedule from public.commercial_discount_schedules where provider_organization_id = v_provider and client_request_id = p_client_request_id;
    if found then return v_schedule; end if;
    insert into public.commercial_discount_schedules(provider_organization_id,name,effective_from,effective_to,notes,client_request_id,created_by)
    values(v_provider,v_name,coalesce(p_effective_from,current_date),p_effective_to,nullif(trim(coalesce(p_notes,'')),''),p_client_request_id,v_actor)
    returning * into v_schedule;
  else
    select * into v_schedule from public.commercial_discount_schedules where id = p_schedule_id for update;
    if not found or v_schedule.provider_organization_id <> v_provider then raise exception 'Discount schedule not found in your organization'; end if;
    if p_action = 'activate' then
      if not exists (select 1 from public.commercial_discount_schedule_rules where schedule_id = v_schedule.id) then raise exception 'An active discount schedule needs at least one rule'; end if;
      update public.commercial_discount_schedules set status = 'active', updated_at = now() where id = v_schedule.id returning * into v_schedule;
    elsif p_action = 'retire' then
      update public.commercial_discount_schedules set status = 'retired', updated_at = now() where id = v_schedule.id returning * into v_schedule;
    else
      raise exception 'Unsupported discount schedule action';
    end if;
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_provider,v_actor,'commercial_discount_schedule_' || p_action,'commercial_discount_schedules',v_schedule.id,jsonb_build_object('status',v_schedule.status,'version',v_schedule.version,'client_request_id',p_client_request_id));
  return v_schedule;
end;
$$;

REVOKE ALL ON FUNCTION public.manage_commercial_discount_schedule(uuid,text,uuid,text,date,date,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_commercial_discount_schedule(uuid,text,uuid,text,date,date,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_commercial_discount_schedule_rule(
  p_schedule_id uuid,
  p_module_key text DEFAULT NULL,
  p_client_organization_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_discount_kind text DEFAULT NULL,
  p_discount_value numeric DEFAULT NULL,
  p_minimum_subtotal numeric DEFAULT NULL,
  p_priority integer DEFAULT 0
)
RETURNS public.commercial_discount_schedule_rules
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_schedule public.commercial_discount_schedules%rowtype;
  v_rule public.commercial_discount_schedule_rules%rowtype;
begin
  select * into v_schedule from public.commercial_discount_schedules where id = p_schedule_id for update;
  if not found or not public.is_admin_for_org(v_schedule.provider_organization_id) then raise exception 'Discount schedule not found in your organization'; end if;
  if v_schedule.status <> 'draft' then raise exception 'Only draft discount schedules can be changed'; end if;
  if p_module_key is not null and not exists (select 1 from public.module_catalog where module_key = p_module_key and active) then raise exception 'Active module catalog entry required'; end if;
  if p_discount_kind not in ('percentage', 'fixed_amount') or p_discount_value is null or p_discount_value < 0 or (p_discount_kind = 'percentage' and p_discount_value > 100) then raise exception 'Discount kind and value are invalid'; end if;
  if p_minimum_subtotal is not null and p_minimum_subtotal < 0 then raise exception 'Minimum subtotal cannot be negative'; end if;
  if p_site_id is not null and p_zone_id is not null then raise exception 'A discount rule can target a Site or Zone, not both'; end if;
  if (p_site_id is not null or p_zone_id is not null) and p_client_organization_id is null then raise exception 'A Site or Zone discount requires its client organization'; end if;
  if p_site_id is not null and not exists (select 1 from public.client_sites where id = p_site_id and client_organization_id = p_client_organization_id) then raise exception 'Site does not belong to the selected client organization'; end if;
  if p_zone_id is not null and not exists (select 1 from public.location_zones zone join public.locations location on location.id = zone.location_id where zone.id = p_zone_id and location.organization_id = p_client_organization_id) then raise exception 'Zone does not belong to the selected client organization'; end if;

  insert into public.commercial_discount_schedule_rules(schedule_id,module_key,client_organization_id,site_id,zone_id,discount_kind,discount_value,minimum_subtotal,priority)
  values(p_schedule_id,p_module_key,p_client_organization_id,p_site_id,p_zone_id,p_discount_kind,p_discount_value,p_minimum_subtotal,coalesce(p_priority,0))
  returning * into v_rule;

  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_schedule.provider_organization_id,v_actor,'commercial_discount_rule_created','commercial_discount_schedule_rules',v_rule.id,jsonb_build_object('schedule_id',v_schedule.id,'module_key',p_module_key,'client_organization_id',p_client_organization_id,'site_id',p_site_id,'zone_id',p_zone_id,'discount_kind',p_discount_kind,'discount_value',p_discount_value));
  return v_rule;
end;
$$;

REVOKE ALL ON FUNCTION public.manage_commercial_discount_schedule_rule(uuid,text,uuid,uuid,uuid,text,numeric,numeric,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_commercial_discount_schedule_rule(uuid,text,uuid,uuid,uuid,text,numeric,numeric,integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_crm_quote_commercial_source(
  p_quote_id uuid,
  p_tender_id uuid DEFAULT NULL,
  p_discount_schedule_id uuid DEFAULT NULL
)
RETURNS public.quotes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_quote public.quotes%rowtype;
begin
  select * into v_quote from public.quotes where id = p_quote_id for update;
  if not found or not public.is_admin_for_org(v_quote.provider_org_id) then raise exception 'Quote not found in your organization'; end if;
  if v_quote.status <> 'draft' then raise exception 'Commercial sources can only be changed on a draft quote'; end if;
  if p_tender_id is not null and not exists (select 1 from public.tenders tender where tender.id = p_tender_id and tender.organization_id = v_quote.provider_org_id and tender.client_organization_id = v_quote.client_org_id and tender.status in ('in_review', 'submitted', 'awarded')) then raise exception 'Tender is not an eligible provider commercial source for this quote'; end if;
  if p_discount_schedule_id is not null and not exists (select 1 from public.commercial_discount_schedules schedule where schedule.id = p_discount_schedule_id and schedule.provider_organization_id = v_quote.provider_org_id and schedule.status = 'active' and schedule.effective_from <= current_date and (schedule.effective_to is null or schedule.effective_to >= current_date)) then raise exception 'Active provider discount schedule required'; end if;
  update public.quotes set tender_id = p_tender_id, discount_schedule_id = p_discount_schedule_id, updated_by = v_actor, updated_at = now() where id = v_quote.id returning * into v_quote;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_quote.provider_org_id,v_actor,'crm_quote_commercial_source_set','quotes',v_quote.id,jsonb_build_object('tender_id',p_tender_id,'discount_schedule_id',p_discount_schedule_id));
  return v_quote;
end;
$$;

CREATE OR REPLACE FUNCTION public.capture_accepted_quote_commercial_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
begin
  if new.status = 'accepted' and new.service_agreement_id is not null and old.status is distinct from 'accepted' then
    insert into public.quote_commercial_snapshots(
      quote_id,provider_organization_id,client_organization_id,tender_id,discount_schedule_id,
      currency,gst_rate,discount_pct,total_cost,subtotal_charge,discount_amount,gst_amount,total_charge,
      pricing_detail,accepted_at,accepted_by
    )
    values(
      new.id,new.provider_org_id,new.client_org_id,new.tender_id,new.discount_schedule_id,
      new.currency,new.gst_rate,new.discount_pct,new.total_cost,new.subtotal_charge,new.discount_amount,new.gst_amount,new.total_charge,
      jsonb_build_object(
        'quote_lines', coalesce((select jsonb_agg(jsonb_build_object('id',line.id,'kind',line.kind,'description',line.description,'quantity',line.quantity,'unit_cost',line.unit_cost,'unit_charge',line.unit_charge,'module_key',line.module_key,'site_id',line.site_id) order by line.line_order) from public.quote_lines line where line.quote_id = new.id), '[]'::jsonb),
        'proposal_modules', coalesce((select jsonb_agg(jsonb_build_object('module_key',module.module_key,'sla_minutes',module.sla_minutes,'service_window',module.service_window,'pricing_basis',module.pricing_basis,'rate_rule_id',module.rate_rule_id,'rate_rule_type',rule.rate_type,'rate_rule_amount',rule.amount) order by module.module_key) from public.quote_proposal_modules module left join public.rate_rules rule on rule.id = module.rate_rule_id where module.quote_id = new.id), '[]'::jsonb)
      ),
      coalesce(new.accepted_at, now()),coalesce(new.accepted_by, auth.uid())
    ) on conflict (quote_id) do nothing;
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.prevent_quote_commercial_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
begin
  raise exception 'Accepted commercial snapshots are immutable';
end;
$$;

CREATE TRIGGER trg_capture_accepted_quote_commercial_snapshot
  AFTER UPDATE OF status ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.capture_accepted_quote_commercial_snapshot();
CREATE TRIGGER trg_prevent_quote_commercial_snapshot_mutation
  BEFORE UPDATE OR DELETE ON public.quote_commercial_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.prevent_quote_commercial_snapshot_mutation();

REVOKE ALL ON FUNCTION public.manage_crm_quote_commercial_source(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_crm_quote_commercial_source(uuid,uuid,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.capture_accepted_quote_commercial_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_quote_commercial_snapshot_mutation() FROM PUBLIC, anon, authenticated;