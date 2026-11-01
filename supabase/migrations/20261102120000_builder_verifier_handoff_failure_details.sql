DO $handoff$
DECLARE
  v_signature regprocedure := 'public.builder_account_verifier_recoveries(uuid)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_frontend_anchor text := 'OR log_summary = ''Frontend worker handoff failed''';
  v_frontend_replacement text := 'OR log_summary = ''Frontend worker handoff failed''
        OR log_summary LIKE ''Frontend worker handoff failed during %''';
  v_backend_anchor text := 'OR log_summary = ''Backend worker handoff failed''';
  v_backend_replacement text := 'OR log_summary = ''Backend worker handoff failed''
        OR log_summary LIKE ''Backend worker handoff failed during %''';
  v_receipt_anchor text := '''recovery_kind'', CASE WHEN _baseline THEN ''baseline'' ELSE ''infrastructure_or_evidence'' END,
        ''engineering_attempt_refunded'', true, ''retryable'', NOT _baseline AND _recoveries < 2)';
  v_receipt_replacement text := '''recovery_kind'', CASE WHEN _baseline THEN ''baseline'' ELSE ''infrastructure_or_evidence'' END,
        ''verifier_failure_summary'', left(_run.log_summary, 500),
        ''engineering_attempt_refunded'', true, ''retryable'', NOT _baseline AND _recoveries < 2)';
BEGIN
  IF length(v_definition) - length(replace(v_definition, v_frontend_anchor, '')) <> length(v_frontend_anchor)
    OR length(v_definition) - length(replace(v_definition, v_backend_anchor, '')) <> length(v_backend_anchor)
    OR length(v_definition) - length(replace(v_definition, v_receipt_anchor, '')) <> length(v_receipt_anchor) THEN
    RAISE EXCEPTION 'Verifier recovery function changed; review handoff evidence accounting before applying';
  END IF;

  v_definition := replace(v_definition, v_frontend_anchor, v_frontend_replacement);
  v_definition := replace(v_definition, v_backend_anchor, v_backend_replacement);
  v_definition := replace(v_definition, v_receipt_anchor, v_receipt_replacement);
  EXECUTE v_definition;
END;
$handoff$;
