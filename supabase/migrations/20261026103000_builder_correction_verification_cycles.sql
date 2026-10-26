DO $patch$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_anchor text := '_idempotency_key := _job.id::text || ''::'' || _step.id::text || ''::'' || _job.target_sha || ''::'' || _patch.checksum;';
  v_replacement text := '_idempotency_key := _job.id::text || ''::'' || _step.id::text || ''::'' || _job.target_sha || ''::'' || _patch.checksum
    || CASE WHEN _job.code_review_revision->>''approval_id'' IS NOT NULL
      THEN ''::correction::'' || (_job.code_review_revision->>''approval_id'') ELSE '''' END;';
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.builder_claim_frontend_worker(uuid,uuid,uuid,text,text,integer)'::regprocedure,
    'public.builder_claim_backend_worker(uuid,uuid,uuid,text,text,integer)'::regprocedure
  ] LOOP
    v_definition := pg_get_functiondef(v_signature);
    IF length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor) THEN
      RAISE EXCEPTION 'Worker claim % changed; review correction-cycle verification keys before applying', v_signature;
    END IF;
    EXECUTE replace(v_definition, v_anchor, v_replacement);
  END LOOP;
END;
$patch$;
