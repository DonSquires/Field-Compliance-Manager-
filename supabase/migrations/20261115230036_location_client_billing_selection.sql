CREATE TABLE public.agreement_place_rate_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  service_agreement_location_id uuid NOT NULL REFERENCES public.service_agreement_locations(id),
  service_agreement_module_id uuid REFERENCES public.service_agreement_modules(id),
  rate_type text NOT NULL CHECK (rate_type IN ('hourly','per_km','per_visit','per_notice','flat','daily','callout','per_unit')),
  source text NOT NULL CHECK (source IN ('agreement','rate_rule')),
  rate_rule_id uuid REFERENCES public.rate_rules(id),
  effective_from date NOT NULL,
  effective_to date,
  superseded_at timestamptz,
  client_request_id uuid NOT NULL,
  request_fingerprint jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, client_request_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((source = 'agreement' AND rate_rule_id IS NULL) OR (source = 'rate_rule' AND rate_rule_id IS NOT NULL))
);
COMMENT ON TABLE public.agreement_place_rate_selections IS
  'Effective-dated choice of an existing agreement term or billing rate rule for one covered place/service/unit. Stores no duplicate monetary amounts.';
CREATE INDEX agreement_place_rate_selections_lookup
  ON public.agreement_place_rate_selections(service_agreement_location_id,rate_type,effective_from DESC);
CREATE INDEX agreement_place_rate_selections_module
  ON public.agreement_place_rate_selections(service_agreement_module_id);
CREATE INDEX agreement_place_rate_selections_rule
  ON public.agreement_place_rate_selections(rate_rule_id);
CREATE INDEX agreement_place_rate_selections_actor
  ON public.agreement_place_rate_selections(created_by);
ALTER TABLE public.agreement_place_rate_selections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agreement_place_rate_selections FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.location_billing_rule_applicable(
  p_rule_id uuid,p_provider_id uuid,p_client_id uuid,p_site_id uuid,p_zone_id uuid,
  p_module_key text,p_service_type text,p_on date,p_rate_type text
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rate_rules r
    WHERE r.id=p_rule_id AND r.organization_id=p_provider_id AND r.rule_kind='billing'
      AND r.active AND r.rate_type=p_rate_type AND r.amount>0
      AND r.amount::text NOT IN ('NaN','Infinity','-Infinity')
      AND (r.client_org_id IS NULL OR r.client_org_id=p_client_id)
      AND (r.site_id IS NULL OR r.site_id=p_site_id)
      AND (r.zone_id IS NULL OR r.zone_id=p_zone_id)
      AND (r.module_key IS NULL OR r.module_key=p_module_key)
      AND (r.service_type IS NULL OR r.service_type=p_service_type)
      AND (r.effective_from IS NULL OR r.effective_from<=p_on)
      AND (r.effective_to IS NULL OR r.effective_to>=p_on)
      AND r.staff_id IS NULL AND r.role_code IS NULL AND r.region_code IS NULL
      AND r.job_type IS NULL AND r.job_code IS NULL AND r.vehicle_type IS NULL
      AND r.distance_min_km IS NULL AND r.distance_max_km IS NULL
      AND r.outside_area IS NULL AND r.day_category IS NULL
  );
$$;
REVOKE ALL ON FUNCTION public.location_billing_rule_applicable(uuid,uuid,uuid,uuid,uuid,text,text,date,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.resolve_agreement_place_billing_rate(
  p_service_agreement_id uuid,p_site_id uuid,p_zone_id uuid,p_when timestamptz,
  p_service_type text,p_module_key text,p_job_type text,p_distance_km numeric,
  p_day_category text,p_rate_type text
)
RETURNS TABLE(rate_rule_id uuid,rate_type text,amount numeric,rate_source text,
  selection_id uuid,day_category text,reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_agreement public.service_agreements%rowtype;
  v_selection public.agreement_place_rate_selections%rowtype;
  v_terms public.crm_commercial_settings%rowtype;
  v_rule record;
  v_on date := (p_when AT TIME ZONE 'Pacific/Auckland')::date;
  v_amount numeric;
BEGIN
  SELECT * INTO v_agreement FROM public.service_agreements a WHERE a.id=p_service_agreement_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid,p_rate_type,NULL::numeric,'unresolved',NULL::uuid,p_day_category,'No service agreement';
    RETURN;
  END IF;
  SELECT choice.* INTO v_selection
  FROM public.agreement_place_rate_selections choice
  JOIN public.service_agreement_locations covered ON covered.id=choice.service_agreement_location_id
  LEFT JOIN public.service_agreement_modules module ON module.id=choice.service_agreement_module_id
  WHERE covered.service_agreement_id=v_agreement.id
    AND choice.organization_id=v_agreement.provider_organization_id
    AND ((p_site_id IS NOT NULL AND covered.site_id=p_site_id)
      OR (p_site_id IS NULL AND p_zone_id IS NOT NULL AND covered.zone_id=p_zone_id))
    AND (choice.service_agreement_module_id IS NULL OR module.module_key=p_module_key)
    AND choice.rate_type=p_rate_type AND choice.effective_from<=v_on
    AND choice.superseded_at IS NULL
    AND (choice.effective_to IS NULL OR choice.effective_to>=v_on)
  ORDER BY (choice.service_agreement_module_id IS NOT NULL) DESC,choice.effective_from DESC
  LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO v_rule FROM public.resolve_rate_rule(
      v_agreement.provider_organization_id,'billing',p_when,p_service_type,p_job_type,p_module_key,
      v_agreement.client_organization_id,p_site_id,p_zone_id,NULL,p_distance_km,p_day_category,p_rate_type);
    RETURN QUERY SELECT v_rule.rate_rule_id,p_rate_type,v_rule.amount,'legacy',NULL::uuid,
      v_rule.day_category,CASE WHEN v_rule.amount IS NULL THEN 'No applicable billing rate' ELSE NULL::text END;
    RETURN;
  END IF;
  IF v_agreement.agreement_type<>'operational'
    OR (v_agreement.starts_on IS NOT NULL AND v_agreement.starts_on>v_on)
    OR (v_agreement.ends_on IS NOT NULL AND v_agreement.ends_on<v_on)
    OR NOT EXISTS (SELECT 1 FROM public.service_agreement_locations covered
      WHERE covered.id=v_selection.service_agreement_location_id AND covered.status='active')
    OR (v_selection.service_agreement_module_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.service_agreement_modules module
      WHERE module.id=v_selection.service_agreement_module_id
        AND module.service_agreement_id=v_agreement.id AND module.enabled)) THEN
    RETURN QUERY SELECT NULL::uuid,p_rate_type,NULL::numeric,v_selection.source,v_selection.id,
      p_day_category,'Selected agreement, service or covered place is unavailable';
    RETURN;
  END IF;
  SELECT * INTO v_terms FROM public.crm_commercial_settings c WHERE c.service_agreement_id=v_agreement.id;
  IF coalesce(v_terms.currency,'NZD')<>'NZD' THEN
    RETURN QUERY SELECT NULL::uuid,p_rate_type,NULL::numeric,v_selection.source,v_selection.id,
      p_day_category,'This rate book supports NZD only; no currency conversion has been applied';
    RETURN;
  END IF;
  IF v_selection.source='agreement' THEN
    v_amount := CASE
      WHEN p_rate_type='hourly' AND p_job_type IS NOT NULL THEN v_terms.callout_rate_per_hour
      WHEN p_rate_type='hourly' THEN v_terms.base_rate_per_hour
      WHEN p_rate_type='per_km' THEN v_terms.travel_rate_per_km
      ELSE NULL END;
    IF v_amount IS NULL OR v_amount<=0 OR v_amount::text IN ('NaN','Infinity','-Infinity') THEN
      RETURN QUERY SELECT NULL::uuid,p_rate_type,NULL::numeric,'agreement',v_selection.id,
        p_day_category,'No positive agreement rate is set for this charging unit';
    ELSE
      RETURN QUERY SELECT NULL::uuid,p_rate_type,v_amount,'agreement',v_selection.id,p_day_category,NULL::text;
    END IF;
  ELSIF public.location_billing_rule_applicable(v_selection.rate_rule_id,
    v_agreement.provider_organization_id,v_agreement.client_organization_id,p_site_id,p_zone_id,
    p_module_key,p_service_type,v_on,p_rate_type) THEN
    RETURN QUERY SELECT r.id,r.rate_type,r.amount,'rate_rule',v_selection.id,p_day_category,NULL::text
      FROM public.rate_rules r WHERE r.id=v_selection.rate_rule_id;
  ELSE
    RETURN QUERY SELECT v_selection.rate_rule_id,p_rate_type,NULL::numeric,'rate_rule',v_selection.id,
      p_day_category,'Selected billing rate is inactive, expired or no longer applicable';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_agreement_place_billing_rate(uuid,uuid,uuid,timestamptz,text,text,text,numeric,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.resolve_agreement_place_billing_rate(uuid,uuid,uuid,timestamptz,text,text,text,numeric,text,text)
  TO service_role;

CREATE FUNCTION public.save_location_billing_selection(
  p_provider_id uuid,p_location_id uuid,p_client_request_id uuid,
  p_service_agreement_location_id uuid,p_service_agreement_module_id uuid,p_rate_type text,
  p_source text,p_rate_rule_id uuid,p_effective_from date,p_expected_selection_id uuid,
  p_expected_updated_at timestamptz,p_new_rate jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_covered public.service_agreement_locations%rowtype;
  v_module text;
  v_service text;
  v_existing public.agreement_place_rate_selections%rowtype;
  v_receipt public.agreement_place_rate_selections%rowtype;
  v_rule public.rate_rules%rowtype;
  v_rule_id uuid := p_rate_rule_id;
  v_fingerprint jsonb;
  v_terms public.crm_commercial_settings%rowtype;
  v_amount numeric;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_provider_id)
    OR NOT public.user_can_operate_organization(p_provider_id) THEN
    RAISE EXCEPTION 'Active provider finance administrator authority required' USING ERRCODE='42501';
  END IF;
  IF p_client_request_id IS NULL OR p_effective_from IS NULL
    OR p_source IS NULL OR p_source NOT IN ('agreement','rate_rule')
    OR p_rate_type IS NULL OR p_rate_type NOT IN ('hourly','per_km','per_visit','per_notice','flat','daily','callout','per_unit') THEN
    RAISE EXCEPTION 'Request, effective date, billing source and supported charging unit are required';
  END IF;
  v_fingerprint := jsonb_build_object('actor',v_actor,'location',p_location_id,'covered',p_service_agreement_location_id,
    'module',p_service_agreement_module_id,'unit',p_rate_type,'source',p_source,'rule',p_rate_rule_id,
    'from',p_effective_from,'expected_id',p_expected_selection_id,'expected_at',p_expected_updated_at,'new_rate',p_new_rate);
  PERFORM pg_advisory_xact_lock(hashtextextended('location-billing-request:'||p_provider_id||':'||p_client_request_id,0));
  SELECT * INTO v_receipt FROM public.agreement_place_rate_selections choice
    WHERE choice.organization_id=p_provider_id AND choice.client_request_id=p_client_request_id;
  IF FOUND THEN
    IF v_receipt.request_fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'Request replay conflicts with a different payload'; END IF;
    RETURN jsonb_build_object('selection',to_jsonb(v_receipt)-'request_fingerprint','client_request_id',p_client_request_id,'replayed',true);
  END IF;
  SELECT * INTO v_covered FROM public.service_agreement_locations covered
    WHERE covered.id=p_service_agreement_location_id AND covered.status='active';
  SELECT * INTO v_agreement FROM public.service_agreements a
    WHERE a.id=v_covered.service_agreement_id AND a.provider_organization_id=p_provider_id
      AND a.agreement_type='operational';
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.locations house WHERE house.id=p_location_id
      AND house.organization_id=v_agreement.client_organization_id
      AND (EXISTS (SELECT 1 FROM public.client_sites s WHERE s.id=v_covered.site_id
          AND s.location_id=house.id AND s.active AND s.client_organization_id=house.organization_id)
        OR EXISTS (SELECT 1 FROM public.location_zones z WHERE z.id=v_covered.zone_id
          AND z.location_id=house.id AND z.organization_id=house.organization_id AND z.is_active AND NOT z.is_verification_point))
  ) THEN RAISE EXCEPTION 'Covered location or agreement access denied' USING ERRCODE='42501'; END IF;
  IF (v_agreement.starts_on IS NOT NULL AND v_agreement.starts_on>p_effective_from)
    OR (v_agreement.ends_on IS NOT NULL AND v_agreement.ends_on<p_effective_from) THEN
    RAISE EXCEPTION 'Effective date is outside the service agreement';
  END IF;
  IF p_service_agreement_module_id IS NOT NULL THEN
    SELECT module.module_key,coalesce(nullif(module.settings->>'service_type',''),module.module_key)
      INTO v_module,v_service FROM public.service_agreement_modules module
      WHERE module.id=p_service_agreement_module_id AND module.service_agreement_id=v_agreement.id AND module.enabled;
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose an enabled module on this agreement'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('location-billing-scope:'||p_service_agreement_location_id
    ||':'||coalesce(p_service_agreement_module_id::text,'all')||':'||p_rate_type,0));
  SELECT * INTO v_existing FROM public.agreement_place_rate_selections choice
    WHERE choice.service_agreement_location_id=p_service_agreement_location_id
      AND choice.service_agreement_module_id IS NOT DISTINCT FROM p_service_agreement_module_id
      AND choice.rate_type=p_rate_type AND choice.superseded_at IS NULL
    ORDER BY choice.effective_from DESC LIMIT 1 FOR UPDATE;
  IF v_existing.id IS DISTINCT FROM p_expected_selection_id
    OR v_existing.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Location billing changed; reload before saving' USING ERRCODE='40001';
  END IF;
  IF v_existing.id IS NOT NULL AND p_effective_from<v_existing.effective_from THEN
    RAISE EXCEPTION 'Choose an effective date on or after the latest saved selection; historical selections are preserved';
  END IF;
  SELECT * INTO v_terms FROM public.crm_commercial_settings c WHERE c.service_agreement_id=v_agreement.id;
  IF coalesce(v_terms.currency,'NZD')<>'NZD' THEN RAISE EXCEPTION 'This rate book supports NZD only'; END IF;
  IF p_source='agreement' THEN
    IF p_rate_rule_id IS NOT NULL OR p_new_rate IS NOT NULL THEN RAISE EXCEPTION 'Agreement inheritance cannot also select or create a charge rate'; END IF;
    v_amount := CASE WHEN p_rate_type='hourly' THEN v_terms.base_rate_per_hour
      WHEN p_rate_type='per_km' THEN v_terms.travel_rate_per_km ELSE NULL END;
    IF v_amount IS NULL OR v_amount<=0 OR v_amount::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'No positive agreement rate is set for this unit; create or select a charge rate';
    END IF;
  ELSE
    IF p_new_rate IS NOT NULL THEN
      IF p_rate_rule_id IS NOT NULL OR jsonb_typeof(p_new_rate)<>'object'
        OR jsonb_typeof(p_new_rate->'name') IS DISTINCT FROM 'string'
        OR jsonb_typeof(p_new_rate->'amount') IS DISTINCT FROM 'number'
        OR nullif(btrim(p_new_rate->>'name'),'') IS NULL
        OR length(p_new_rate->>'name')>200
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_new_rate) key WHERE key NOT IN ('name','amount')) THEN
        RAISE EXCEPTION 'A new billing rate needs a name and a positive numeric amount only';
      END IF;
      v_amount := (p_new_rate->>'amount')::numeric;
      IF v_amount<=0 OR v_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'A billing rate must be a positive finite amount'; END IF;
      IF EXISTS (SELECT 1 FROM public.rate_rules rule
        WHERE rule.organization_id=p_provider_id AND rule.client_request_id=p_client_request_id) THEN
        RAISE EXCEPTION 'Request identifier already belongs to a different rate creation; use a new request';
      END IF;
      SELECT * INTO v_rule FROM public.manage_operating_branch_rate_rule(
        p_operating_organization_id=>p_provider_id,p_client_request_id=>p_client_request_id,
        p_action=>'create',p_rule_kind=>'billing',p_name=>btrim(p_new_rate->>'name'),
        p_rate_type=>p_rate_type,p_amount=>v_amount,p_service_type=>v_service,
        p_client_org_id=>v_agreement.client_organization_id,p_site_id=>v_covered.site_id,
        p_zone_id=>v_covered.zone_id,p_effective_from=>p_effective_from);
      IF v_rule.name IS DISTINCT FROM btrim(p_new_rate->>'name') OR v_rule.amount IS DISTINCT FROM v_amount
        OR v_rule.client_org_id IS DISTINCT FROM v_agreement.client_organization_id
        OR v_rule.site_id IS DISTINCT FROM v_covered.site_id OR v_rule.zone_id IS DISTINCT FROM v_covered.zone_id
        OR v_rule.service_type IS DISTINCT FROM v_service OR v_rule.effective_from IS DISTINCT FROM p_effective_from THEN
        RAISE EXCEPTION 'Rate creation replay conflicts with the requested billing rate';
      END IF;
      v_rule_id := v_rule.id;
    END IF;
    IF v_rule_id IS NULL OR NOT public.location_billing_rule_applicable(v_rule_id,p_provider_id,
      v_agreement.client_organization_id,v_covered.site_id,v_covered.zone_id,v_module,v_service,
      p_effective_from,p_rate_type) THEN
      RAISE EXCEPTION 'Choose an active applicable billing rate for this provider, place, service and unit';
    END IF;
  END IF;
  IF v_existing.id IS NOT NULL THEN
    UPDATE public.agreement_place_rate_selections
      SET effective_to=CASE WHEN effective_from<p_effective_from THEN p_effective_from-1 ELSE effective_to END,
        superseded_at=CASE WHEN effective_from=p_effective_from THEN clock_timestamp() ELSE NULL END,
        updated_at=clock_timestamp()
      WHERE id=v_existing.id;
  END IF;
  INSERT INTO public.agreement_place_rate_selections(organization_id,service_agreement_location_id,
    service_agreement_module_id,rate_type,source,rate_rule_id,effective_from,client_request_id,request_fingerprint,created_by)
  VALUES (p_provider_id,p_service_agreement_location_id,p_service_agreement_module_id,p_rate_type,p_source,
    v_rule_id,p_effective_from,p_client_request_id,v_fingerprint,v_actor) RETURNING * INTO v_receipt;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES (p_provider_id,v_actor,'location_billing_selection_saved','agreement_place_rate_selections',v_receipt.id,
    jsonb_build_object('client_request_id',p_client_request_id,'agreement_id',v_agreement.id,
      'location_id',p_location_id,'source',p_source,'rule_id',v_rule_id,'effective_from',p_effective_from,
      'previous_selection_id',v_existing.id));
  RETURN jsonb_build_object('selection',to_jsonb(v_receipt)-'request_fingerprint','client_request_id',p_client_request_id,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.save_location_billing_selection(uuid,uuid,uuid,uuid,uuid,text,text,uuid,date,uuid,timestamptz,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_location_billing_selection(uuid,uuid,uuid,uuid,uuid,text,text,uuid,date,uuid,timestamptz,jsonb)
  TO authenticated;

CREATE FUNCTION public.get_location_billing_workspace(p_provider_id uuid,p_location_id uuid,p_effective_on date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_provider_id)
    OR NOT public.user_can_operate_organization(p_provider_id) THEN
    RAISE EXCEPTION 'Active provider finance administrator authority required' USING ERRCODE='42501';
  END IF;
  IF p_effective_on IS NULL THEN RAISE EXCEPTION 'Choose an effective date'; END IF;
  WITH covered AS (
    SELECT link.id,link.service_agreement_id,link.site_id,link.zone_id,
      a.name AS agreement_name,a.client_organization_id,a.starts_on,a.ends_on,
      coalesce(s.name,z.name) AS place_name,coalesce(c.currency,'NZD') AS currency,
      c.base_rate_per_hour,c.callout_rate_per_hour,c.travel_rate_per_km
    FROM public.service_agreement_locations link
    JOIN public.service_agreements a ON a.id=link.service_agreement_id
    JOIN public.locations house ON house.id=p_location_id AND house.organization_id=a.client_organization_id
    LEFT JOIN public.client_sites s ON s.id=link.site_id AND s.location_id=p_location_id AND s.active
      AND s.client_organization_id=a.client_organization_id
    LEFT JOIN public.location_zones z ON z.id=link.zone_id AND z.location_id=p_location_id AND z.is_active
      AND NOT z.is_verification_point AND z.organization_id=a.client_organization_id
    LEFT JOIN public.crm_commercial_settings c ON c.service_agreement_id=a.id
    WHERE a.provider_organization_id=p_provider_id AND a.agreement_type='operational'
      AND link.status='active' AND (s.id IS NOT NULL OR z.id IS NOT NULL)
      AND (a.starts_on IS NULL OR a.starts_on<=p_effective_on) AND (a.ends_on IS NULL OR a.ends_on>=p_effective_on)
  )
  SELECT jsonb_build_object('provider_id',p_provider_id,'location_id',p_location_id,
    'effective_on',p_effective_on,'can_manage',true,
    'agreements',coalesce((SELECT jsonb_agg(a ORDER BY a.name,a.id) FROM (
      SELECT DISTINCT service_agreement_id AS id,agreement_name AS name,client_organization_id,
        currency,base_rate_per_hour,callout_rate_per_hour,travel_rate_per_km FROM covered) a),'[]'::jsonb),
    'places',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.place_name,c.id) FROM covered c),'[]'::jsonb),
    'modules',coalesce((SELECT jsonb_agg(m ORDER BY m.module_key,m.id) FROM (
      SELECT module.id,module.service_agreement_id,module.module_key,
        coalesce(nullif(module.settings->>'service_type',''),module.module_key) AS service_type
      FROM public.service_agreement_modules module WHERE module.enabled
        AND module.service_agreement_id IN (SELECT service_agreement_id FROM covered)) m),'[]'::jsonb),
    'selections',coalesce((SELECT jsonb_agg(to_jsonb(choice)-'request_fingerprint' ORDER BY choice.effective_from DESC)
      FROM public.agreement_place_rate_selections choice
      WHERE choice.organization_id=p_provider_id AND choice.superseded_at IS NULL
        AND choice.service_agreement_location_id IN (SELECT id FROM covered)),'[]'::jsonb),
    'rates',coalesce((SELECT jsonb_agg(r ORDER BY r.name,r.id) FROM (
      SELECT rule.id,rule.name,rule.rate_type,rule.amount,rule.client_org_id,rule.site_id,rule.zone_id,
        rule.module_key,rule.service_type,rule.effective_from,rule.effective_to
      FROM public.rate_rules rule WHERE rule.organization_id=p_provider_id AND rule.rule_kind='billing' AND EXISTS (
        SELECT 1 FROM covered c LEFT JOIN public.service_agreement_modules module
          ON module.service_agreement_id=c.service_agreement_id AND module.enabled
        WHERE public.location_billing_rule_applicable(rule.id,p_provider_id,c.client_organization_id,
          c.site_id,c.zone_id,module.module_key,coalesce(nullif(module.settings->>'service_type',''),module.module_key),
          p_effective_on,rule.rate_type))) r),'[]'::jsonb)
  ) INTO v_result;
  IF jsonb_array_length(v_result->'places')=0 THEN
    RAISE EXCEPTION 'No active covered location is available for this provider and date' USING ERRCODE='42501';
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.get_location_billing_workspace(uuid,uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_location_billing_workspace(uuid,uuid,date) TO authenticated;
