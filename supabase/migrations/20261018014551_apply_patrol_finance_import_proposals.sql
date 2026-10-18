ALTER TABLE public.finance_service_costs
  DROP CONSTRAINT IF EXISTS finance_service_costs_source_document_type_check;
ALTER TABLE public.finance_service_costs
  ADD CONSTRAINT finance_service_costs_source_document_type_check
  CHECK (source_document_type IN (
    'timesheet','asset_check','inventory_transaction','asset_maintenance',
    'depreciation_schedule','estimate','manual','dispatch_job','patrol_log'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS finance_service_costs_patrol_source_unique
  ON public.finance_service_costs(organization_id, source_reference)
  WHERE source_document_type='patrol_log';

CREATE TABLE IF NOT EXISTS public.file_import_finance_cost_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES public.file_import_batches(id) ON DELETE CASCADE,
  client_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  source_file text NOT NULL,
  source_sha256 text NOT NULL,
  derivative_sha256 text NOT NULL,
  source_sheet text NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 0),
  source_row_sha256 text NOT NULL,
  component text NOT NULL CHECK (component IN ('job_cost','travel_cost')),
  cost_type text NOT NULL CHECK (cost_type IN ('labour','vehicle')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  formula text,
  service_date date,
  site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  zone_id uuid REFERENCES public.location_zones(id) ON DELETE RESTRICT,
  evidence_record_type text CHECK (evidence_record_type IN ('observations','location_events')),
  evidence_external_ref text,
  aggregate_key text,
  source_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('eligible','quarantined','applied')),
  quarantine_reason text,
  finance_service_cost_id uuid REFERENCES public.finance_service_costs(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CONSTRAINT file_import_finance_cost_rows_hash_check
    CHECK (source_sha256 ~ '^[a-f0-9]{64}$' AND derivative_sha256 ~ '^[a-f0-9]{64}$' AND source_row_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT file_import_finance_cost_rows_place_check
    CHECK (status='quarantined' OR ((site_id IS NULL) <> (zone_id IS NULL))),
  CONSTRAINT file_import_finance_cost_rows_state_check
    CHECK (
      (status='quarantined' AND quarantine_reason IS NOT NULL AND finance_service_cost_id IS NULL)
      OR (status='eligible' AND quarantine_reason IS NULL AND finance_service_cost_id IS NULL)
      OR (status='applied' AND quarantine_reason IS NULL AND finance_service_cost_id IS NOT NULL AND applied_at IS NOT NULL)
    ),
  UNIQUE (batch_id, source_file, source_sheet, source_row, component)
);

CREATE INDEX IF NOT EXISTS file_import_finance_cost_rows_batch_status
  ON public.file_import_finance_cost_rows(batch_id,status,aggregate_key);
CREATE INDEX IF NOT EXISTS file_import_finance_cost_rows_cost
  ON public.file_import_finance_cost_rows(finance_service_cost_id)
  WHERE finance_service_cost_id IS NOT NULL;

ALTER TABLE public.file_import_finance_cost_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS file_import_finance_cost_rows_select ON public.file_import_finance_cost_rows;
CREATE POLICY file_import_finance_cost_rows_select
  ON public.file_import_finance_cost_rows FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id) OR public.is_grand_master());
REVOKE ALL ON TABLE public.file_import_finance_cost_rows FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.file_import_finance_cost_rows TO authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.file_import_finance_cost_rows TO postgres,service_role;

CREATE OR REPLACE FUNCTION public.confirm_file_import_profile_mappings(
  p_batch_id uuid,
  p_reason text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_batch public.file_import_batches%rowtype;
  v_profile public.import_source_profiles%rowtype;
  v_review public.file_import_mapping_reviews%rowtype;
  v_logical_field text;
  v_expected jsonb;
  v_count integer:=0;
BEGIN
  IF nullif(trim(coalesce(p_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'Mapping confirmation reason is required'; END IF;
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status NOT IN ('staging','needs_review') OR NOT public.is_tenant_import_admin(v_batch.organization_id) THEN
    RAISE EXCEPTION 'Open tenant import review batch required';
  END IF;
  SELECT * INTO v_profile FROM public.import_source_profiles
  WHERE organization_id=v_batch.organization_id AND profile_code=v_batch.manifest_json->>'source_profile' AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active source profile required'; END IF;

  FOR v_review IN SELECT * FROM public.file_import_mapping_reviews WHERE batch_id=v_batch.id AND decision='proposed' FOR UPDATE LOOP
    SELECT mapping.key INTO v_logical_field
    FROM jsonb_each(v_profile.column_mappings) mapping
    CROSS JOIN LATERAL jsonb_array_elements_text(mapping.value) alias
    WHERE regexp_replace(lower(alias),'\s+',' ','g')
      =regexp_replace(lower(regexp_replace(v_review.source_column,' #[0-9]+$','')),'\s+',' ','g')
    LIMIT 1;
    v_expected:=v_profile.target_mappings->v_logical_field;
    IF v_logical_field IS NULL OR v_expected IS NULL
      OR v_review.target_entity IS DISTINCT FROM v_expected->>'target_entity'
      OR v_review.target_field IS DISTINCT FROM v_expected->>'target_field' THEN
      RAISE EXCEPTION 'Source column % does not exactly match the active import profile',v_review.source_column;
    END IF;
    UPDATE public.file_import_mapping_reviews
    SET decision='confirmed',review_reason=trim(p_reason),reviewed_by=v_actor,reviewed_at=now(),updated_at=now()
    WHERE id=v_review.id;
    v_count:=v_count+1;
  END LOOP;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_batch.organization_id,v_actor,'file_import_profile_mappings_confirmed','file_import_batches',v_batch.id,
    jsonb_build_object('confirmed_count',v_count,'source_profile',v_profile.profile_code,'reason',trim(p_reason)));
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.confirm_file_import_profile_mappings(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_file_import_profile_mappings(uuid,text) TO postgres,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.stage_patrol_finance_cost_rows(
  p_batch_id uuid,
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_service_agreement_id uuid,
  p_rows jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_batch public.file_import_batches%rowtype;
  v_profile public.import_source_profiles%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_row jsonb;
  v_status text;
  v_reason text;
  v_evidence_type text;
  v_site uuid;
  v_zone uuid;
  v_service_date date;
  v_component text;
  v_cost_type text;
  v_amount numeric;
  v_source_row integer;
  v_inserted integer:=0;
  v_existing integer:=0;
  v_eligible integer:=0;
  v_quarantined integer:=0;
  v_proposals integer:=0;
  v_eligible_total numeric:=0;
BEGIN
  IF jsonb_typeof(p_rows)<>'array' THEN RAISE EXCEPTION 'Finance source rows must be an array'; END IF;
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.organization_id<>p_provider_organization_id OR v_batch.status<>'staging' THEN
    RAISE EXCEPTION 'Open provider import batch required';
  END IF;
  SELECT * INTO v_profile FROM public.import_source_profiles
  WHERE organization_id=p_provider_organization_id AND profile_code=v_batch.manifest_json->>'source_profile' AND active;
  IF NOT FOUND OR v_profile.import_actor_id IS DISTINCT FROM v_actor
    OR v_batch.created_by IS DISTINCT FROM v_actor
    OR NOT public.is_tenant_import_admin(p_provider_organization_id) THEN
    RAISE EXCEPTION 'Configured tenant import identity required';
  END IF;
  IF v_batch.manifest_json->>'target_client_organization_id' IS DISTINCT FROM p_client_organization_id::text THEN
    RAISE EXCEPTION 'Import batch client scope is invalid';
  END IF;
  SELECT agreement.* INTO v_agreement
    FROM public.service_agreements agreement
    JOIN public.service_agreement_modules module ON module.service_agreement_id=agreement.id AND module.module_key='patrol' AND module.enabled
    WHERE agreement.id=p_service_agreement_id
      AND agreement.provider_organization_id=p_provider_organization_id
      AND agreement.client_organization_id=p_client_organization_id
      AND agreement.agreement_type='operational';
  IF NOT FOUND THEN RAISE EXCEPTION 'Contracted patrol agreement required'; END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    IF v_row->>'organization_id' IS DISTINCT FROM p_provider_organization_id::text
      OR v_row->>'client_organization_id' IS DISTINCT FROM p_client_organization_id::text
      OR v_row->>'service_agreement_id' IS DISTINCT FROM p_service_agreement_id::text
      OR v_row->>'source_file' IS DISTINCT FROM v_batch.source_file
      OR v_row->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256
      OR v_row->>'derivative_sha256' IS DISTINCT FROM v_batch.manifest_json->>'derivative_sha256'
      OR v_row->>'source_sheet' IS DISTINCT FROM v_batch.manifest_json->>'source_sheet'
      OR coalesce(v_row->>'source_row','') !~ '^[1-9][0-9]*$'
      OR coalesce(v_row->>'source_row_sha256','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'Finance source row provenance does not match its batch';
    END IF;
    v_source_row:=(v_row->>'source_row')::integer;
    v_component:=v_row->>'component';
    v_cost_type:=v_row->>'cost_type';
    v_amount:=NULLIF(v_row->>'amount','')::numeric;
    v_site:=NULLIF(v_row->>'site_id','')::uuid;
    v_zone:=NULLIF(v_row->>'zone_id','')::uuid;
    v_service_date:=NULLIF(v_row->>'service_date','')::date;
    v_status:=v_row->>'status';
    v_reason:=NULLIF(v_row->>'quarantine_reason','');
    v_evidence_type:=NULL;

    IF v_component NOT IN ('job_cost','travel_cost')
      OR (v_component='job_cost' AND v_cost_type<>'labour')
      OR (v_component='travel_cost' AND v_cost_type<>'vehicle')
      OR v_amount IS NULL OR v_amount<=0 THEN
      RAISE EXCEPTION 'Finance source component and amount are invalid';
    END IF;
    IF v_status='quarantined' THEN
      IF v_reason IS NULL THEN RAISE EXCEPTION 'Quarantined finance source row requires a reason'; END IF;
      IF v_reason NOT IN (
        'invalid_service_date','unresolved_contracted_place','formula_error',
        'displayed_total_mismatch','duplicate_external_reference',
        'outside_agreement_term','outside_contracted_place','operational_evidence_not_found'
      ) THEN RAISE EXCEPTION 'Unsupported finance source quarantine reason'; END IF;
    ELSIF v_status='eligible' THEN
      IF v_reason IS NOT NULL OR v_service_date IS NULL OR ((v_site IS NULL)=(v_zone IS NULL))
        OR v_row->>'aggregate_key' IS DISTINCT FROM to_char(v_service_date,'YYYY-MM')||':'||v_component THEN
        RAISE EXCEPTION 'Eligible finance source row is incomplete';
      END IF;
      IF NULLIF(v_row->>'total_cost','') IS NOT NULL
        AND abs(
          (v_row->>'total_cost')::numeric
          - coalesce(NULLIF(v_row->>'job_cost','')::numeric,0)
          - coalesce(NULLIF(v_row->>'travel_cost','')::numeric,0)
        )>0.02 THEN
        v_status:='quarantined';v_reason:='displayed_total_mismatch';
      END IF;
        IF v_status='eligible'
          AND ((v_agreement.starts_on IS NOT NULL AND v_service_date<v_agreement.starts_on)
            OR (v_agreement.ends_on IS NOT NULL AND v_service_date>v_agreement.ends_on)) THEN
          v_status:='quarantined';v_reason:='outside_agreement_term';
        ELSIF v_status='eligible' AND NOT EXISTS(
          SELECT 1 FROM public.service_agreement_locations location
        WHERE location.service_agreement_id=p_service_agreement_id AND location.status='active'
          AND ((v_site IS NOT NULL AND location.site_id=v_site) OR (v_zone IS NOT NULL AND location.zone_id=v_zone))
      ) THEN
        v_status:='quarantined';v_reason:='outside_contracted_place';
      ELSIF v_status='eligible' AND EXISTS(
        SELECT 1 FROM public.observations observation
        WHERE observation.organization_id=p_client_organization_id
          AND observation.external_refs->>'external_ref'=v_row->>'evidence_external_ref'
          AND observation.observed_at::date=v_service_date
          AND observation.site_id IS NOT DISTINCT FROM v_site
          AND observation.zone_id IS NOT DISTINCT FROM v_zone
      ) THEN
        v_evidence_type:='observations';
      ELSIF v_status='eligible' AND EXISTS(
        SELECT 1 FROM public.location_events event
        WHERE event.organization_id=p_client_organization_id
          AND event.external_ref=v_row->>'evidence_external_ref'
          AND event.occurred_at::date=v_service_date
          AND event.client_site_id IS NOT DISTINCT FROM v_site
          AND event.zone_id IS NOT DISTINCT FROM v_zone
      ) THEN
        v_evidence_type:='location_events';
      ELSIF v_status='eligible' THEN
        v_status:='quarantined';v_reason:='operational_evidence_not_found';
      END IF;
    ELSE
      RAISE EXCEPTION 'Finance source row status must be eligible or quarantined';
    END IF;

    IF EXISTS(
      SELECT 1 FROM public.file_import_finance_cost_rows existing
      WHERE existing.organization_id=p_provider_organization_id
        AND existing.source_file=v_batch.source_file
        AND existing.source_sheet=v_batch.manifest_json->>'source_sheet'
        AND existing.source_row=v_source_row
        AND existing.component=v_component
        AND existing.status IN ('eligible','applied')
    ) THEN
      IF EXISTS(
        SELECT 1 FROM public.file_import_finance_cost_rows existing
        WHERE existing.organization_id=p_provider_organization_id
          AND existing.source_file=v_batch.source_file
          AND existing.source_sheet=v_batch.manifest_json->>'source_sheet'
          AND existing.source_row=v_source_row
          AND existing.component=v_component
          AND existing.status IN ('eligible','applied')
          AND (
            existing.source_row_sha256 IS DISTINCT FROM v_row->>'source_row_sha256'
            OR existing.client_organization_id IS DISTINCT FROM p_client_organization_id
            OR existing.service_agreement_id IS DISTINCT FROM p_service_agreement_id
          )
      ) THEN
        RAISE EXCEPTION 'Previously accepted finance source row changed and requires governed financial reconciliation';
      END IF;
      v_existing:=v_existing+1;
      CONTINUE;
    END IF;

    INSERT INTO public.file_import_finance_cost_rows(
      organization_id,batch_id,client_organization_id,service_agreement_id,
      source_file,source_sha256,derivative_sha256,source_sheet,source_row,source_row_sha256,
      component,cost_type,amount,formula,service_date,site_id,zone_id,
      evidence_record_type,evidence_external_ref,aggregate_key,source_values,status,quarantine_reason,created_by
    ) VALUES(
      p_provider_organization_id,p_batch_id,p_client_organization_id,p_service_agreement_id,
      v_batch.source_file,v_batch.source_sha256,v_batch.manifest_json->>'derivative_sha256',
      v_batch.manifest_json->>'source_sheet',v_source_row,v_row->>'source_row_sha256',
      v_component,v_cost_type,v_amount,NULLIF(v_row->>'formula',''),v_service_date,v_site,v_zone,
      v_evidence_type,NULLIF(v_row->>'evidence_external_ref',''),NULLIF(v_row->>'aggregate_key',''),
      v_row-'organization_id'-'client_organization_id'-'service_agreement_id'-'status'-'quarantine_reason',
      v_status,v_reason,v_actor
    )
    ON CONFLICT(batch_id,source_file,source_sheet,source_row,component) DO NOTHING;
    IF FOUND THEN
      v_inserted:=v_inserted+1;
      IF v_status='eligible' THEN v_eligible:=v_eligible+1;v_eligible_total:=v_eligible_total+v_amount;
      ELSE v_quarantined:=v_quarantined+1; END IF;
    ELSE
      v_existing:=v_existing+1;
    END IF;
  END LOOP;

  DELETE FROM public.file_import_row_proposals
  WHERE batch_id=v_batch.id AND target_type='finance_service_cost' AND status='proposed';

  INSERT INTO public.file_import_row_proposals(
    organization_id,batch_id,source_record_key,target_type,proposed_payload,source_values,confidence,created_by
  )
  SELECT
    p_provider_organization_id,v_batch.id,row.aggregate_key,'finance_service_cost',
    jsonb_build_object(
      'organization_id',p_provider_organization_id,
      'client_organization_id',p_client_organization_id,
      'service_agreement_id',p_service_agreement_id,
      'service_month',split_part(row.aggregate_key,':',1),
      'cost_type',min(row.cost_type),
      'quantity',1,
      'unit_cost',round(sum(row.amount),2),
      'source_document_type','patrol_log',
      'source_reference','rm_patrol:'||v_batch.source_sha256||':'||(v_batch.manifest_json->>'source_sheet')||':'||row.aggregate_key,
      'source_row_count',count(*)
    ),
    jsonb_build_object(
      'source','rm_patrol_log_import',
      'source_file',v_batch.source_file,
      'source_sha256',v_batch.source_sha256,
      'derivative_sha256',v_batch.manifest_json->>'derivative_sha256',
      'source_profile',v_batch.manifest_json->>'source_profile',
      'source_sheet',v_batch.manifest_json->>'source_sheet',
      'component',min(row.component),
      'component_total',round(sum(row.amount),2),
      'source_row_count',count(*),
      'quarantined_row_count',(SELECT count(*) FROM public.file_import_finance_cost_rows quarantined WHERE quarantined.batch_id=v_batch.id AND quarantined.status='quarantined')
    ),
    1,v_actor
  FROM public.file_import_finance_cost_rows row
  WHERE row.batch_id=v_batch.id AND row.status='eligible'
  GROUP BY row.aggregate_key;
  GET DIAGNOSTICS v_proposals=ROW_COUNT;

  SELECT count(*) FILTER(WHERE status='eligible'),count(*) FILTER(WHERE status='quarantined'),coalesce(sum(amount) FILTER(WHERE status='eligible'),0)
  INTO v_eligible,v_quarantined,v_eligible_total
  FROM public.file_import_finance_cost_rows WHERE batch_id=v_batch.id;
  UPDATE public.file_import_batches
  SET unresolved_count=v_quarantined,
      manifest_json=manifest_json||jsonb_build_object('expected_proposal_count',v_proposals),
      updated_at=now()
  WHERE id=v_batch.id;
  RETURN jsonb_build_object(
    'inserted',v_inserted,'existing',v_existing,'eligible',v_eligible,'quarantined',v_quarantined,
    'proposal_candidates',v_proposals,'eligible_total',round(v_eligible_total,2)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.stage_patrol_finance_cost_rows(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.stage_patrol_finance_cost_rows(uuid,uuid,uuid,uuid,jsonb) TO postgres,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.review_file_import_finance_proposals(
  p_batch_id uuid,
  p_expected_proposal_count integer,
  p_expected_total numeric,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_batch public.file_import_batches%rowtype;
  v_count integer;
  v_total numeric;
  v_row_count integer;
BEGIN
  IF p_expected_proposal_count<1 OR p_expected_total<=0 OR nullif(trim(coalesce(p_reason,'')),'') IS NULL THEN
    RAISE EXCEPTION 'Expected proposal count, total, and review reason are required';
  END IF;
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status<>'needs_review' OR NOT public.is_tenant_import_admin(v_batch.organization_id) THEN
    RAISE EXCEPTION 'Finance import batch is not open for review';
  END IF;
  IF EXISTS(SELECT 1 FROM public.file_import_mapping_reviews WHERE batch_id=v_batch.id AND decision<>'confirmed') THEN
    RAISE EXCEPTION 'Every source mapping must be confirmed before finance proposal approval';
  END IF;
  IF EXISTS(SELECT 1 FROM public.file_import_row_proposals WHERE batch_id=v_batch.id AND target_type<>'finance_service_cost') THEN
    RAISE EXCEPTION 'Finance batch contains a different consequential proposal type';
  END IF;
  SELECT count(*),coalesce(sum((proposed_payload->>'unit_cost')::numeric),0),coalesce(sum((proposed_payload->>'source_row_count')::integer),0)
  INTO v_count,v_total,v_row_count
  FROM public.file_import_row_proposals
  WHERE batch_id=v_batch.id AND target_type='finance_service_cost' AND status='proposed';
  IF v_count<>p_expected_proposal_count OR round(v_total,2)<>round(p_expected_total,2) THEN
    RAISE EXCEPTION 'Finance proposal summary changed: expected % / %, found % / %',p_expected_proposal_count,p_expected_total,v_count,v_total;
  END IF;
  IF v_row_count<>(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=v_batch.id AND status='eligible') THEN
    RAISE EXCEPTION 'Finance proposal source row coverage is incomplete';
  END IF;
  UPDATE public.file_import_row_proposals
  SET status='approved',review_reason=trim(p_reason),reviewed_by=v_actor,reviewed_at=now(),updated_at=now()
  WHERE batch_id=v_batch.id AND target_type='finance_service_cost' AND status='proposed';
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_batch.organization_id,v_actor,'file_import_finance_proposals_approved','file_import_batches',v_batch.id,
    jsonb_build_object('proposal_count',v_count,'source_row_count',v_row_count,'total',round(v_total,2),'reason',trim(p_reason)));
  RETURN jsonb_build_object('proposal_count',v_count,'source_row_count',v_row_count,'total',round(v_total,2));
END;
$function$;
REVOKE ALL ON FUNCTION public.review_file_import_finance_proposals(uuid,integer,numeric,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.review_file_import_finance_proposals(uuid,integer,numeric,text) TO postgres,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.apply_file_import_finance_batch(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_batch public.file_import_batches%rowtype;
  v_proposal public.file_import_row_proposals%rowtype;
  v_period public.finance_pl_periods%rowtype;
  v_cost public.finance_service_costs%rowtype;
  v_month date;
  v_source_count integer;
  v_source_total numeric;
  v_applied integer:=0;
  v_existing integer:=0;
  v_period_count integer;
  v_periods_created integer:=0;
  v_total numeric:=0;
BEGIN
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status NOT IN ('approved','applied') OR NOT public.is_tenant_import_admin(v_batch.organization_id) THEN
    RAISE EXCEPTION 'Approved tenant finance import batch required';
  END IF;
  IF v_batch.status='applied' THEN
    SELECT count(*),coalesce(sum(total_cost),0) INTO v_existing,v_total
    FROM public.finance_service_costs cost
    WHERE cost.id IN(SELECT applied_target_id FROM public.file_import_row_proposals WHERE batch_id=v_batch.id AND status='applied');
    RETURN jsonb_build_object('applied',0,'existing',v_existing,'total',round(v_total,2),'batch_status','applied');
  END IF;
  IF EXISTS(SELECT 1 FROM public.file_import_row_proposals WHERE batch_id=v_batch.id AND status NOT IN ('approved','rejected')) THEN
    RAISE EXCEPTION 'Every finance proposal must be approved or rejected before apply';
  END IF;

  FOR v_proposal IN
    SELECT * FROM public.file_import_row_proposals
    WHERE batch_id=v_batch.id AND target_type='finance_service_cost' AND status='approved'
    ORDER BY source_record_key FOR UPDATE
  LOOP
    v_month:=to_date((v_proposal.proposed_payload->>'service_month')||'-01','YYYY-MM-DD');
    PERFORM pg_advisory_xact_lock(hashtextextended(v_batch.organization_id::text||':finance_pl_period:'||v_month::text,0));
    SELECT count(*) INTO v_period_count FROM public.finance_pl_periods
    WHERE organization_id=v_batch.organization_id
      AND daterange(period_start,period_end,'[]') && daterange(v_month,(v_month+interval '1 month'-interval '1 day')::date,'[]');
    IF v_period_count=0 THEN
      INSERT INTO public.finance_pl_periods(
        organization_id,name,period_start,period_end,status,created_by
      ) VALUES(
        v_batch.organization_id,to_char(v_month,'FMMonth YYYY'),v_month,
        (v_month+interval '1 month'-interval '1 day')::date,'draft',v_actor
      ) RETURNING * INTO v_period;
      v_periods_created:=v_periods_created+1;
      INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
      VALUES(v_batch.organization_id,v_actor,'finance_pl_period_created_for_import','finance_pl_periods',v_period.id,
        jsonb_build_object('batch_id',v_batch.id,'period_start',v_period.period_start,'period_end',v_period.period_end));
    ELSIF v_period_count=1 THEN
      SELECT * INTO v_period FROM public.finance_pl_periods
      WHERE organization_id=v_batch.organization_id
        AND period_start<=v_month
        AND period_end>=(v_month+interval '1 month'-interval '1 day')::date;
      IF NOT FOUND OR v_period.status<>'draft' THEN
        RAISE EXCEPTION 'A draft P&L period covering finance proposal month % is required',v_month;
      END IF;
    ELSE
      RAISE EXCEPTION 'Finance proposal month % overlaps more than one P&L period',v_month;
    END IF;
    IF v_proposal.proposed_payload->>'organization_id' IS DISTINCT FROM v_batch.organization_id::text
      OR v_proposal.proposed_payload->>'client_organization_id' IS DISTINCT FROM v_batch.manifest_json->>'target_client_organization_id'
      OR v_proposal.proposed_payload->>'source_document_type'<>'patrol_log'
      OR v_proposal.proposed_payload->>'source_reference' IS DISTINCT FROM
        'rm_patrol:'||v_batch.source_sha256||':'||(v_batch.manifest_json->>'source_sheet')||':'||v_proposal.source_record_key THEN
      RAISE EXCEPTION 'Finance proposal identity or provenance is invalid';
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM public.service_agreements agreement
      JOIN public.service_agreement_modules module ON module.service_agreement_id=agreement.id AND module.module_key='patrol' AND module.enabled
      WHERE agreement.id=(v_proposal.proposed_payload->>'service_agreement_id')::uuid
        AND agreement.provider_organization_id=v_batch.organization_id
        AND agreement.client_organization_id=(v_proposal.proposed_payload->>'client_organization_id')::uuid
        AND agreement.agreement_type='operational'
    ) THEN RAISE EXCEPTION 'Finance proposal agreement is invalid'; END IF;
    SELECT count(*),coalesce(sum(amount),0) INTO v_source_count,v_source_total
    FROM public.file_import_finance_cost_rows
    WHERE batch_id=v_batch.id AND aggregate_key=v_proposal.source_record_key AND status='eligible';
    IF v_source_count<>(v_proposal.proposed_payload->>'source_row_count')::integer
      OR round(v_source_total,2)<>round((v_proposal.proposed_payload->>'unit_cost')::numeric,2) THEN
      RAISE EXCEPTION 'Finance proposal no longer reconciles to its source rows';
    END IF;

    SELECT * INTO v_cost FROM public.finance_service_costs
    WHERE organization_id=v_batch.organization_id
      AND source_document_type='patrol_log'
      AND source_reference=v_proposal.proposed_payload->>'source_reference'
    FOR UPDATE;
    IF FOUND THEN
      IF v_cost.total_cost<>round(v_source_total,2)
        OR v_cost.service_agreement_id IS DISTINCT FROM (v_proposal.proposed_payload->>'service_agreement_id')::uuid
        OR v_cost.pl_period_id IS DISTINCT FROM v_period.id THEN
        RAISE EXCEPTION 'Existing patrol finance cost conflicts with approved proposal';
      END IF;
      v_existing:=v_existing+1;
    ELSE
      INSERT INTO public.finance_service_costs(
        organization_id,pl_period_id,service_agreement_id,client_organization_id,
        cost_type,source_document_type,source_reference,quantity,unit_of_measure,unit_cost,total_cost,allocation_driver,created_by
      ) VALUES(
        v_batch.organization_id,v_period.id,(v_proposal.proposed_payload->>'service_agreement_id')::uuid,
        (v_proposal.proposed_payload->>'client_organization_id')::uuid,
        v_proposal.proposed_payload->>'cost_type','patrol_log',v_proposal.proposed_payload->>'source_reference',
        1,'source rows',round(v_source_total,4),round(v_source_total,2),'patrol_log_row_reconciliation',v_actor
      ) RETURNING * INTO v_cost;
      v_applied:=v_applied+1;
    END IF;
    UPDATE public.file_import_finance_cost_rows
    SET status='applied',finance_service_cost_id=v_cost.id,applied_at=now()
    WHERE batch_id=v_batch.id AND aggregate_key=v_proposal.source_record_key AND status='eligible';
    UPDATE public.file_import_row_proposals
    SET status='applied',applied_target_id=v_cost.id,applied_at=now(),updated_at=now()
    WHERE id=v_proposal.id;
    v_total:=v_total+v_cost.total_cost;
  END LOOP;
  UPDATE public.file_import_batches SET status='applied',updated_at=now() WHERE id=v_batch.id;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_batch.organization_id,v_actor,'file_import_finance_batch_applied','file_import_batches',v_batch.id,
    jsonb_build_object('applied',v_applied,'existing',v_existing,'periods_created',v_periods_created,'total',round(v_total,2)));
  RETURN jsonb_build_object('applied',v_applied,'existing',v_existing,'periods_created',v_periods_created,'total',round(v_total,2),'batch_status','applied');
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_file_import_finance_batch(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.apply_file_import_finance_batch(uuid) TO postgres,authenticated,service_role;

UPDATE public.import_source_profiles profile
SET column_mappings=profile.column_mappings||'{
  "job_time":["Job Time","Job Time NCC","Job Time OFO","Job Time Stringer","Job Time TPFL"],
  "time":["Time","24hr Time","TIME 24hrs"],
  "registration":["Reg","Numbers","VehicleReg"],
  "source":["Source","Source of Information"],
  "job_km":["Job KMs","Job Km NCC","Job kms","Job KM OFO","Job KM","Job KM Stringer","Job KM TPFL"],
  "job_cost":["Job Cost","Job Cost NCC","Job Cost OFO","Job Cost Stringer","Job Cost TPFL"],
  "travel_cost":["Travel Cost","Travel Cost NCC","Travel Cost OFO","Travel Cost Stringer","Travel Cost TPFL"],
  "total_cost":["Total Cost","Total Cost NCC","Total Cost OFO","Total Cost Stringer","Total Cost TPFL"],
  "charge_code":["Charge Code","GL Code"],
  "gl_description":["GL Description"],
  "type":["TYPE","Type"],
  "odometer":["ODO","Travel ODO","Travel Odometer"],
  "status":["Status"],
  "day_of_week":["DOW"],
  "nzta_check":["NZTA Check","NZTA Checks","NZTA"],
  "nzta_date":["NZTA Date"],
  "action_notes":["Action / Notes","Action/Notes","Action","Action Notes","Action Taken or TBD"],
  "action_date":["Last Action Date","Action Date","Actioned Date"],
  "closed_by":["Closed By","Closed by."],
  "month":["Month"],
  "year":["Year"],
  "company":["Company"],
  "zone_initials":["Zone Initials"],
  "purchase_order":["PO num.","PO number","Purchase Order"]
  ,"area":["Area"]
  ,"client":["Client"]
  ,"contract":["Contract"]
  ,"council":["Council"]
  ,"vehicle_description":["Desc; Colour, Make, Model Vehicle"]
  ,"hold_category":["F/Hold or CFL"]
  ,"group":["Group"]
  ,"item_cost":["Item Cost"]
  ,"item_total":["Item Total"]
  ,"name":["Name"]
  ,"deer_killed":["No. Deer killed"]
  ,"goats_killed":["No. Goats killed"]
  ,"other_killed":["No. Other killed"]
  ,"pigs_killed":["No. Pigs killed"]
  ,"second_officer_rate":["2 man Rate"]
  ,"time_fraction":["Time as % of 24hrs"]
  ,"auxiliary_1":["C1","N/A 2"]
  ,"auxiliary_2":["C2","N/A2","N/A3"]
  ,"auxiliary_3":["C3","N/A4","N/A5","N/A6","N/A7","N/A8"]
}'::jsonb,
target_mappings=profile.target_mappings||'{
  "charge_code":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.charge_code|source_values.gl_code"},
  "gl_description":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.gl_description"},
  "type":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.activity_type"},
  "odometer":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.odometer"},
  "status":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.status"},
  "day_of_week":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.day_of_week"},
  "nzta_check":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.nzta_check"},
  "nzta_date":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.nzta_date"},
  "action_notes":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.action_notes"},
  "action_date":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.action_date"},
  "closed_by":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.closed_by"},
  "month":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.month"},
  "year":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.year"},
  "company":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.company"},
  "zone_initials":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.zone_initials"},
  "purchase_order":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.purchase_order"}
  ,"area":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.area"}
  ,"client":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.client"}
  ,"contract":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.contract"}
  ,"council":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.council"}
  ,"vehicle_description":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.vehicle_description"}
  ,"hold_category":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.hold_category"}
  ,"group":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.group"}
  ,"item_cost":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.item_cost"}
  ,"item_total":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.item_total"}
  ,"name":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.name"}
  ,"deer_killed":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.deer_killed"}
  ,"goats_killed":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.goats_killed"}
  ,"other_killed":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.other_killed"}
  ,"pigs_killed":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.pigs_killed"}
  ,"second_officer_rate":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.second_officer_rate"}
  ,"time_fraction":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.time_fraction"}
  ,"auxiliary_1":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.auxiliary_1"}
  ,"auxiliary_2":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.auxiliary_2"}
  ,"auxiliary_3":{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.auxiliary_3"}
}'::jsonb,
updated_at=now()
WHERE profile.organization_id='e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
  AND profile.profile_code='rm_patrol_log';