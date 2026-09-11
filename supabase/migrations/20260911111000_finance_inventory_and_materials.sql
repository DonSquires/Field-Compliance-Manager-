CREATE TABLE IF NOT EXISTS public.finance_item_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sku text NOT NULL,
  name text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('part','material','consumable','fuel','ppe','equipment_component','service')),
  unit_of_measure text NOT NULL,
  tax_code text,
  hazardous boolean NOT NULL DEFAULT false,
  controlled boolean NOT NULL DEFAULT false,
  reorder_point numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku)
);

CREATE TABLE IF NOT EXISTS public.finance_item_cost_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  currency text NOT NULL DEFAULT 'NZD',
  supplier_name text,
  landed_cost numeric(14,4) NOT NULL DEFAULT 0 CHECK (landed_cost >= 0),
  effective_from date NOT NULL,
  effective_to date,
  source_reference text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (item_id, version)
);

CREATE TABLE IF NOT EXISTS public.finance_inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  location_type text NOT NULL CHECK (location_type IN ('warehouse','depot','vehicle','site','technician','quarantine')),
  asset_id uuid REFERENCES public.assets(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS public.finance_inventory_balances (
  item_id uuid NOT NULL REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.finance_inventory_locations(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  on_hand numeric(14,3) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved numeric(14,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, location_id),
  CHECK (reserved <= on_hand)
);

CREATE TABLE IF NOT EXISTS public.finance_inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.finance_inventory_locations(id) ON DELETE RESTRICT,
  transaction_type text NOT NULL CHECK (transaction_type IN ('receipt','issue','return','transfer_in','transfer_out','adjustment','write_off','consumption','quarantine')),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  source_reference text,
  idempotency_key text NOT NULL,
  service_agreement_id uuid REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  location_id_target uuid REFERENCES public.finance_inventory_locations(id) ON DELETE RESTRICT,
  work_unit_id uuid REFERENCES public.roster_work_units(id) ON DELETE RESTRICT,
  shift_id uuid REFERENCES public.shifts(id) ON DELETE RESTRICT,
  dispatch_job_id uuid REFERENCES public.dispatch_jobs(id) ON DELETE RESTRICT,
  investigation_id uuid REFERENCES public.investigations(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES public.assets(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.finance_service_item_consumption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  inventory_transaction_id uuid NOT NULL UNIQUE REFERENCES public.finance_inventory_transactions(id) ON DELETE RESTRICT,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  service_agreement_id uuid REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  zone_id uuid,
  work_unit_id uuid REFERENCES public.roster_work_units(id) ON DELETE RESTRICT,
  shift_id uuid REFERENCES public.shifts(id) ON DELETE RESTRICT,
  dispatch_job_id uuid REFERENCES public.dispatch_jobs(id) ON DELETE RESTRICT,
  investigation_id uuid REFERENCES public.investigations(id) ON DELETE RESTRICT,
  quote_id uuid REFERENCES public.quotes(id) ON DELETE RESTRICT,
  invoice_line_item_id uuid REFERENCES public.invoice_line_items(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_asset_item_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  inventory_transaction_id uuid REFERENCES public.finance_inventory_transactions(id) ON DELETE RESTRICT,
  service_date date NOT NULL DEFAULT current_date,
  meter_reading numeric(14,3),
  notes text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_item_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_item_cost_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_inventory_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_service_item_consumption ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_asset_item_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY finance_item_catalog_select ON public.finance_item_catalog FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_item_cost_versions_select ON public.finance_item_cost_versions FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_inventory_locations_select ON public.finance_inventory_locations FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_inventory_balances_select ON public.finance_inventory_balances FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_inventory_transactions_select ON public.finance_inventory_transactions FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_service_item_consumption_select ON public.finance_service_item_consumption FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_asset_item_links_select ON public.finance_asset_item_links FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.finance_item_catalog, public.finance_item_cost_versions, public.finance_inventory_locations, public.finance_inventory_balances, public.finance_inventory_transactions, public.finance_service_item_consumption, public.finance_asset_item_links FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_item_catalog, public.finance_item_cost_versions, public.finance_inventory_locations, public.finance_inventory_balances, public.finance_inventory_transactions, public.finance_service_item_consumption, public.finance_asset_item_links TO authenticated;
GRANT ALL ON TABLE public.finance_item_catalog, public.finance_item_cost_versions, public.finance_inventory_locations, public.finance_inventory_balances, public.finance_inventory_transactions, public.finance_service_item_consumption, public.finance_asset_item_links TO service_role;

CREATE OR REPLACE FUNCTION public.record_finance_inventory_transaction(
  p_item_id uuid,
  p_location_id uuid,
  p_transaction_type text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_idempotency_key text,
  p_source_reference text DEFAULT NULL,
  p_target_location_id uuid DEFAULT NULL,
  p_asset_id uuid DEFAULT NULL,
  p_dispatch_job_id uuid DEFAULT NULL,
  p_investigation_id uuid DEFAULT NULL
)
RETURNS public.finance_inventory_transactions
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_item public.finance_item_catalog%rowtype;
  v_location public.finance_inventory_locations%rowtype;
  v_transaction public.finance_inventory_transactions%rowtype;
  v_balance public.finance_inventory_balances%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance or operations administrator required'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_unit_cost IS NULL OR p_unit_cost < 0 THEN RAISE EXCEPTION 'Quantity and unit cost must be valid positive values'; END IF;
  IF p_idempotency_key IS NULL OR trim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'Idempotency key is required'; END IF;
  SELECT * INTO v_item FROM public.finance_item_catalog WHERE id = p_item_id AND organization_id = v_org AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active inventory item not found in organization'; END IF;
  SELECT * INTO v_location FROM public.finance_inventory_locations WHERE id = p_location_id AND organization_id = v_org AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active inventory location not found in organization'; END IF;
  SELECT * INTO v_transaction FROM public.finance_inventory_transactions WHERE organization_id = v_org AND idempotency_key = trim(p_idempotency_key);
  IF FOUND THEN RETURN v_transaction; END IF;
  IF p_transaction_type IN ('issue','consumption','write_off','transfer_out','quarantine') THEN
    SELECT * INTO v_balance FROM public.finance_inventory_balances WHERE item_id = p_item_id AND location_id = p_location_id FOR UPDATE;
    IF NOT FOUND OR v_balance.on_hand - v_balance.reserved < p_quantity THEN RAISE EXCEPTION 'Insufficient available inventory'; END IF;
    UPDATE public.finance_inventory_balances SET on_hand = on_hand - p_quantity, updated_at = now() WHERE item_id = p_item_id AND location_id = p_location_id;
  ELSE
    INSERT INTO public.finance_inventory_balances(item_id, location_id, organization_id, on_hand) VALUES (p_item_id, p_location_id, v_org, p_quantity)
    ON CONFLICT (item_id, location_id) DO UPDATE SET on_hand = public.finance_inventory_balances.on_hand + excluded.on_hand, updated_at = now();
  END IF;
  INSERT INTO public.finance_inventory_transactions(organization_id,item_id,location_id,transaction_type,quantity,unit_cost,idempotency_key,source_reference,location_id_target,dispatch_job_id,investigation_id,asset_id,created_by)
  VALUES(v_org,p_item_id,p_location_id,p_transaction_type,p_quantity,p_unit_cost,trim(p_idempotency_key),nullif(trim(p_source_reference),''),p_target_location_id,p_dispatch_job_id,p_investigation_id,p_asset_id,v_actor)
  RETURNING * INTO v_transaction;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_org,v_actor,'finance_inventory_transaction_recorded','finance_inventory_transactions',v_transaction.id,jsonb_build_object('item_id',p_item_id,'location_id',p_location_id,'transaction_type',p_transaction_type,'quantity',p_quantity,'unit_cost',p_unit_cost,'idempotency_key',trim(p_idempotency_key)));
  RETURN v_transaction;
END;
$$;

REVOKE ALL ON FUNCTION public.record_finance_inventory_transaction(uuid,uuid,text,numeric,numeric,text,text,uuid,uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_finance_inventory_transaction(uuid,uuid,text,numeric,numeric,text,text,uuid,uuid,uuid,uuid) TO authenticated, service_role;
