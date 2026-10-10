-- Use a dedicated non-login tenant automation profile for import attribution,
-- freeze staging metadata on replay, and revalidate consequential approvals.
INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,role,display_name,email)
VALUES(
  'f1c00000-0000-4000-8000-000000000001'::uuid,
  'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,
  'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,
  'admin','R&M import automation','rm-import-automation@field-compliance.invalid'
)
ON CONFLICT(id) DO UPDATE SET
  organization_id=EXCLUDED.organization_id,
  employer_organization_id=EXCLUDED.employer_organization_id,
  role=EXCLUDED.role,
  display_name=EXCLUDED.display_name,
  email=EXCLUDED.email,
  deactivated_at=NULL,
  updated_at=now();
UPDATE public.import_source_profiles
SET import_actor_id='f1c00000-0000-4000-8000-000000000001'::uuid,updated_at=now()
WHERE organization_id='e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid AND profile_code='rm_patrol_log';

ALTER FUNCTION public.begin_patrol_import_batch(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer)
  RENAME TO begin_patrol_import_batch_identity_bound_unfrozen;
REVOKE ALL ON FUNCTION public.begin_patrol_import_batch_identity_bound_unfrozen(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_patrol_import_batch_identity_bound_unfrozen(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) TO postgres;

CREATE OR REPLACE FUNCTION public.begin_patrol_import_batch(
  p_provider_organization_id uuid,p_client_organization_id uuid,p_batch_name text,
  p_source_file text,p_source_sha256 text,p_parser text,p_manifest_json jsonb,p_schema_json jsonb,
  p_row_count integer,p_duplicate_count integer,p_unresolved_count integer
) RETURNS public.file_import_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_batch public.file_import_batches%rowtype;
  v_key text:=nullif(p_manifest_json->>'idempotency_key','');
BEGIN
  IF v_key IS NULL THEN RAISE EXCEPTION 'Import idempotency key is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_organization_id::text||':'||v_key,0));
  SELECT * INTO v_batch FROM public.file_import_batches
  WHERE organization_id=p_provider_organization_id AND manifest_json->>'idempotency_key'=v_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_batch.status<>'staging' THEN RAISE EXCEPTION 'This source and import configuration already has a closed review batch'; END IF;
    IF v_batch.batch_name IS DISTINCT FROM trim(p_batch_name)
      OR v_batch.source_file IS DISTINCT FROM trim(p_source_file)
      OR v_batch.source_sha256 IS DISTINCT FROM p_source_sha256
      OR v_batch.parser IS DISTINCT FROM trim(p_parser)
      OR v_batch.manifest_json IS DISTINCT FROM p_manifest_json
      OR v_batch.schema_json IS DISTINCT FROM p_schema_json
      OR v_batch.row_count IS DISTINCT FROM p_row_count
      OR v_batch.duplicate_count IS DISTINCT FROM p_duplicate_count
      OR v_batch.unresolved_count IS DISTINCT FROM p_unresolved_count THEN
      RAISE EXCEPTION 'Open import batch metadata is immutable; use a new source/configuration identity';
    END IF;
    RETURN v_batch;
  END IF;
  RETURN public.begin_patrol_import_batch_identity_bound_unfrozen(
    p_provider_organization_id,p_client_organization_id,p_batch_name,p_source_file,p_source_sha256,
    p_parser,p_manifest_json,p_schema_json,p_row_count,p_duplicate_count,p_unresolved_count
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.begin_patrol_import_batch(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_patrol_import_batch(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) TO postgres,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.review_file_import_row_proposal(p_proposal_id uuid,p_decision text,p_reason text)
RETURNS public.file_import_row_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_proposal public.file_import_row_proposals%rowtype;
  v_batch public.file_import_batches%rowtype;
  v_batch_id uuid;
  v_provider uuid;
  v_client uuid;
  v_site uuid;
  v_zone uuid;
  v_assignee uuid;
  v_subject uuid;
  v_activity uuid;
  v_module_key text;
  v_evidence_type text;
  v_evidence_ref text;
  v_profile text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;
  IF nullif(trim(coalesce(p_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'Review reason is required'; END IF;
  SELECT batch_id INTO v_batch_id FROM public.file_import_row_proposals WHERE id=p_proposal_id;
  IF v_batch_id IS NULL THEN RAISE EXCEPTION 'Import proposal not found'; END IF;
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id=v_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status NOT IN ('preview','needs_review') THEN RAISE EXCEPTION 'Import proposal parent batch is no longer open for review'; END IF;
  IF NOT public.is_tenant_import_admin(v_batch.organization_id) THEN RAISE EXCEPTION 'Import review access required'; END IF;
  SELECT * INTO v_proposal FROM public.file_import_row_proposals WHERE id=p_proposal_id FOR UPDATE;
  IF NOT FOUND OR v_proposal.status<>'proposed' THEN RAISE EXCEPTION 'Only proposed import rows can be reviewed'; END IF;

  IF p_decision='approved' THEN
    v_provider:=v_batch.organization_id;
    v_profile:=v_batch.manifest_json->>'source_profile';
    v_client:=NULLIF(v_proposal.proposed_payload->>'client_organization_id','')::uuid;
    v_site:=NULLIF(v_proposal.proposed_payload->>'client_site_id','')::uuid;
    v_zone:=NULLIF(v_proposal.proposed_payload->>'zone_id','')::uuid;
    v_assignee:=NULLIF(v_proposal.proposed_payload->>'assigned_user_id','')::uuid;
    v_subject:=NULLIF(v_proposal.proposed_payload->>'work_subject_code_id','')::uuid;
    v_activity:=NULLIF(v_proposal.proposed_payload->>'work_activity_code_id','')::uuid;
    v_evidence_type:=coalesce(v_proposal.proposed_payload->>'evidence_record_type',v_proposal.source_values->>'evidence_record_type');
    v_evidence_ref:=coalesce(v_proposal.proposed_payload->>'evidence_external_ref',v_proposal.source_values->>'evidence_external_ref');
    v_module_key:=CASE v_proposal.target_type WHEN 'workshop_work_order' THEN 'workshop' WHEN 'finance_service_cost' THEN 'patrol' ELSE NULL END;

    IF v_module_key IS NULL OR v_proposal.proposed_payload->>'organization_id' IS DISTINCT FROM v_provider::text
      OR v_client IS NULL OR ((v_site IS NULL)=(v_zone IS NULL)) THEN
      RAISE EXCEPTION 'Proposal tenant, target type, and exactly one place are required';
    END IF;
    IF v_proposal.source_values->>'source' IS DISTINCT FROM 'rm_patrol_log_import'
      OR v_proposal.source_values->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256
      OR v_proposal.source_values->>'derivative_sha256' IS DISTINCT FROM v_batch.manifest_json->>'derivative_sha256'
      OR v_proposal.source_values->>'source_profile' IS DISTINCT FROM v_profile
      OR nullif(v_proposal.source_values->>'source_file','') IS NULL
      OR coalesce(v_proposal.source_values->>'source_row','') !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'Proposal provenance does not match its batch';
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM public.service_agreements agreement
      JOIN public.service_agreement_modules module ON module.service_agreement_id=agreement.id AND module.module_key=v_module_key AND module.enabled
      JOIN public.service_agreement_locations location ON location.service_agreement_id=agreement.id AND location.status='active'
      WHERE agreement.provider_organization_id=v_provider AND agreement.client_organization_id=v_client
        AND agreement.agreement_type='operational' AND (agreement.starts_on IS NULL OR agreement.starts_on<=current_date) AND (agreement.ends_on IS NULL OR agreement.ends_on>=current_date)
        AND ((v_site IS NOT NULL AND location.site_id=v_site) OR (v_zone IS NOT NULL AND location.zone_id=v_zone))
    ) THEN RAISE EXCEPTION 'Proposal target is outside active contracted module/place coverage'; END IF;

    IF v_evidence_type='observations' THEN
      IF NOT EXISTS(
        SELECT 1 FROM public.observations observation
        WHERE observation.organization_id=v_client AND observation.external_refs->>'external_ref'=v_evidence_ref
          AND observation.external_refs->'import'->>'source'='rm_patrol_log_import'
          AND observation.external_refs->'import'->>'source_sha256'=v_batch.source_sha256
          AND observation.external_refs->'import'->>'derivative_sha256'=v_batch.manifest_json->>'derivative_sha256'
      ) THEN RAISE EXCEPTION 'Proposal observation evidence is missing or outside this batch'; END IF;
    ELSIF v_evidence_type='location_events' THEN
      IF NOT EXISTS(
        SELECT 1 FROM public.location_events event
        WHERE event.organization_id=v_client AND event.external_ref=v_evidence_ref AND event.source='rm_patrol_log_import'
          AND event.payload->>'source'='rm_patrol_log_import' AND event.payload->>'source_sha256'=v_batch.source_sha256
          AND event.payload->>'derivative_sha256'=v_batch.manifest_json->>'derivative_sha256'
      ) THEN RAISE EXCEPTION 'Proposal location event evidence is missing or outside this batch'; END IF;
    ELSE
      RAISE EXCEPTION 'Proposal requires an existing batch-bound observation or location event';
    END IF;

    IF v_proposal.target_type='workshop_work_order' THEN
      IF nullif(v_proposal.proposed_payload->>'scheduled_for','') IS NULL OR v_assignee IS NULL THEN RAISE EXCEPTION 'Workshop proposal schedule and assignee are required'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.user_profiles profile WHERE profile.id=v_assignee AND profile.deactivated_at IS NULL AND (profile.organization_id=v_provider OR profile.employer_organization_id=v_provider)) THEN RAISE EXCEPTION 'Workshop proposal assignee is outside the provider'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.reference_codes code WHERE code.id=v_subject AND code.organization_id=v_provider AND code.code_type='work_subject' AND code.is_active) THEN RAISE EXCEPTION 'Workshop proposal subject is invalid'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.reference_codes code WHERE code.id=v_activity AND code.organization_id=v_provider AND code.code_type='work_activity' AND code.is_active) THEN RAISE EXCEPTION 'Workshop proposal activity is invalid'; END IF;
      IF jsonb_typeof(v_proposal.source_values->'classification_rule_ids')<>'array'
        OR jsonb_array_length(v_proposal.source_values->'classification_rule_ids')<2
        OR EXISTS(
          SELECT 1 FROM jsonb_array_elements_text(v_proposal.source_values->'classification_rule_ids') rule_id
          WHERE NOT EXISTS(
            SELECT 1 FROM public.import_value_classification_rules rule
            WHERE rule.id=rule_id::uuid AND rule.organization_id=v_provider AND rule.source_profile=v_profile AND rule.active
          )
        ) THEN RAISE EXCEPTION 'Workshop proposal classification rules are invalid'; END IF;
    ELSE
      IF coalesce(
        jsonb_typeof(v_proposal.source_values->'job_cost')='number',false
      )=false AND coalesce(jsonb_typeof(v_proposal.source_values->'travel_cost')='number',false)=false
        AND coalesce(jsonb_typeof(v_proposal.source_values->'total_cost')='number',false)=false THEN
        RAISE EXCEPTION 'Finance proposal requires numeric source cost evidence';
      END IF;
      IF coalesce((v_proposal.proposed_payload->>'requires_cost_type_mapping')::boolean,false) THEN
        RAISE EXCEPTION 'Finance proposal cost type mapping must be resolved before approval';
      END IF;
    END IF;
  END IF;

  UPDATE public.file_import_row_proposals
  SET status=p_decision,review_reason=trim(p_reason),reviewed_by=v_actor,reviewed_at=now(),updated_at=now()
  WHERE id=v_proposal.id RETURNING * INTO v_proposal;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_proposal.organization_id,v_actor,'file_import_row_proposal_reviewed','file_import_row_proposals',v_proposal.id,
    jsonb_build_object('batch_id',v_proposal.batch_id,'target_type',v_proposal.target_type,'decision',p_decision));
  RETURN v_proposal;
END;
$function$;
REVOKE ALL ON FUNCTION public.review_file_import_row_proposal(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.review_file_import_row_proposal(uuid,text,text) TO postgres,authenticated,service_role;
;
