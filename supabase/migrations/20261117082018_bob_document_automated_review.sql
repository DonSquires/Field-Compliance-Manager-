-- Machine review is attributable to Bob and Oracle, never to an impersonated user.
CREATE TABLE public.bob_document_auto_review_receipts (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
	document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
	document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE RESTRICT,
	review_kind text NOT NULL CHECK (review_kind IN ('draft', 'classification', 'promotion')),
	proposal_id uuid REFERENCES public.document_promotion_proposals(id) ON DELETE RESTRICT,
	proposal_snapshot jsonb,
	lease_token uuid NOT NULL DEFAULT gen_random_uuid(),
	source_file_sha256 text CHECK (source_file_sha256 IS NULL OR source_file_sha256 ~ '^[a-f0-9]{64}$'),
	source_text_sha256 text NOT NULL CHECK (source_text_sha256 ~ '^[a-f0-9]{64}$'),
	source_updated_at timestamptz NOT NULL,
	status text NOT NULL CHECK (status IN ('running', 'approved', 'rejected', 'quarantined', 'blocked', 'applied')),
	decision_reason text NOT NULL DEFAULT '',
	bob_provider text,
	bob_model text,
	oracle_provider text,
	oracle_model text,
	decision_report jsonb NOT NULL DEFAULT '{}'::jsonb,
	applied_target_id uuid,
	lease_expires_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	CHECK ((review_kind = 'promotion') = (proposal_id IS NOT NULL)),
	CHECK (bob_provider IS NULL OR bob_provider IN ('gpu_workstation', 'ollama')),
	CHECK (oracle_provider IS NULL OR oracle_provider IN ('gpu_workstation', 'ollama'))
);

CREATE UNIQUE INDEX bob_document_auto_review_source_once
	ON public.bob_document_auto_review_receipts (review_kind, document_version_id, source_text_sha256)
	WHERE proposal_id IS NULL;
CREATE UNIQUE INDEX bob_document_auto_review_proposal_once
	ON public.bob_document_auto_review_receipts (review_kind, document_version_id, proposal_id, source_text_sha256)
	WHERE proposal_id IS NOT NULL;
CREATE INDEX bob_document_auto_review_org_recent
	ON public.bob_document_auto_review_receipts (organization_id, created_at DESC);

ALTER TABLE public.bob_document_auto_review_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bob_document_auto_review_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.bob_document_auto_review_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.claim_bob_document_auto_review(
	p_document_version_id uuid,
	p_review_kind text,
	p_proposal_id uuid DEFAULT NULL,
	p_source_text_sha256 text DEFAULT NULL
) RETURNS TABLE(receipt_id uuid, state text, claimed boolean, attempt_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
	v_org_id uuid;
	v_document_id uuid;
	v_source_sha text;
	v_updated_at timestamptz;
	v_receipt public.bob_document_auto_review_receipts%rowtype;
	v_proposal_snapshot jsonb;
BEGIN
	IF (SELECT auth.jwt() ->> 'role') IS DISTINCT FROM 'service_role' THEN
		RAISE EXCEPTION 'Service identity required';
	END IF;
	IF p_review_kind NOT IN ('draft', 'classification', 'promotion')
		OR ((p_review_kind = 'promotion') IS DISTINCT FROM (p_proposal_id IS NOT NULL))
		OR p_source_text_sha256 !~ '^[a-f0-9]{64}$' THEN
		RAISE EXCEPTION 'Document review claim is invalid';
	END IF;

	SELECT d.organization_id, d.id, d.sha256, dv.updated_at
	INTO v_org_id, v_document_id, v_source_sha, v_updated_at
	FROM public.document_versions dv
	JOIN public.documents d ON d.id = dv.document_id
	WHERE dv.id = p_document_version_id
	FOR UPDATE OF d, dv;
	IF v_org_id IS NULL THEN RAISE EXCEPTION 'Document version not found'; END IF;
	IF p_proposal_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM public.document_promotion_proposals proposal
		WHERE proposal.id = p_proposal_id AND proposal.document_version_id = p_document_version_id
			AND proposal.organization_id = v_org_id AND proposal.status = 'proposed'
	) THEN RAISE EXCEPTION 'Proposed document promotion is unavailable'; END IF;
	IF p_proposal_id IS NOT NULL THEN
		SELECT jsonb_build_object('target_type', target_type, 'proposed_payload', proposed_payload, 'source_map', source_map)
		INTO v_proposal_snapshot FROM public.document_promotion_proposals WHERE id = p_proposal_id FOR UPDATE;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'bob-document-auto-review:' || p_review_kind || ':' || p_document_version_id::text || ':' ||
		coalesce(p_proposal_id::text, '-') || ':' || p_source_text_sha256, 0));
	IF p_proposal_id IS NULL THEN
		SELECT * INTO v_receipt FROM public.bob_document_auto_review_receipts receipt
		WHERE receipt.review_kind = p_review_kind AND receipt.document_version_id = p_document_version_id
			AND receipt.proposal_id IS NULL AND receipt.source_text_sha256 = p_source_text_sha256 FOR UPDATE;
	ELSE
		SELECT * INTO v_receipt FROM public.bob_document_auto_review_receipts receipt
		WHERE receipt.review_kind = p_review_kind AND receipt.document_version_id = p_document_version_id
			AND receipt.proposal_id = p_proposal_id AND receipt.source_text_sha256 = p_source_text_sha256 FOR UPDATE;
	END IF;
	IF v_receipt.id IS NOT NULL THEN
		IF v_receipt.status IN ('approved', 'rejected', 'quarantined', 'blocked', 'applied') THEN
			RETURN QUERY SELECT v_receipt.id, v_receipt.status, false, NULL::uuid;
			RETURN;
		END IF;
		IF v_receipt.status = 'running' AND v_receipt.lease_expires_at > clock_timestamp() THEN
			RETURN QUERY SELECT v_receipt.id, v_receipt.status, false, NULL::uuid;
			RETURN;
		END IF;
		UPDATE public.bob_document_auto_review_receipts receipt
		SET status = 'running', decision_reason = '', source_file_sha256 = v_source_sha,
			lease_token = gen_random_uuid(), proposal_snapshot = v_proposal_snapshot,
			source_updated_at = v_updated_at, lease_expires_at = clock_timestamp() + interval '10 minutes',
			updated_at = clock_timestamp()
		WHERE receipt.id = v_receipt.id RETURNING * INTO v_receipt;
		RETURN QUERY SELECT v_receipt.id, 'running'::text, true, v_receipt.lease_token;
		RETURN;
	END IF;

	INSERT INTO public.bob_document_auto_review_receipts (
		organization_id, document_id, document_version_id, review_kind, proposal_id, proposal_snapshot,
		source_file_sha256, source_text_sha256, source_updated_at, status, lease_expires_at
	) VALUES (
		v_org_id, v_document_id, p_document_version_id, p_review_kind, p_proposal_id, v_proposal_snapshot,
		v_source_sha, p_source_text_sha256, v_updated_at, 'running', clock_timestamp() + interval '10 minutes'
	) RETURNING * INTO v_receipt;
	RETURN QUERY SELECT v_receipt.id, 'running'::text, true, v_receipt.lease_token;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_bob_document_auto_review(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_bob_document_auto_review(uuid, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_bob_document_auto_review(
	p_receipt_id uuid,
	p_decision text,
	p_decision_reason text,
	p_reviewers jsonb DEFAULT '[]'::jsonb,
	p_source_claims jsonb DEFAULT '[]'::jsonb,
	p_classification jsonb DEFAULT NULL,
	p_scope text DEFAULT NULL,
	p_promotion_metadata jsonb DEFAULT '{}'::jsonb,
	p_attempt_token uuid DEFAULT NULL
) RETURNS public.bob_document_auto_review_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
	v_receipt public.bob_document_auto_review_receipts%rowtype;
	v_version public.document_versions%rowtype;
	v_document public.documents%rowtype;
	v_proposal public.document_promotion_proposals%rowtype;
	v_metadata jsonb;
	v_unconfirmed integer;
	v_class text;
	v_confidence real;
	v_pii boolean;
	v_security boolean;
	v_financial boolean;
	v_privilege boolean;
	v_promotion jsonb;
	v_author uuid;
	v_action text;
BEGIN
	IF (SELECT auth.jwt() ->> 'role') IS DISTINCT FROM 'service_role' THEN
		RAISE EXCEPTION 'Service identity required';
	END IF;
	IF p_decision NOT IN ('approved', 'rejected', 'quarantined', 'blocked')
		OR nullif(btrim(coalesce(p_decision_reason, '')), '') IS NULL
		OR jsonb_typeof(p_reviewers) <> 'array' OR jsonb_typeof(p_source_claims) <> 'array'
		OR pg_column_size(p_reviewers) > 4000 OR pg_column_size(p_source_claims) > 16000
		OR pg_column_size(coalesce(p_promotion_metadata, '{}'::jsonb)) > 4000 THEN
		RAISE EXCEPTION 'Document review receipt is invalid';
	END IF;
	SELECT * INTO v_receipt FROM public.bob_document_auto_review_receipts
	WHERE id = p_receipt_id FOR UPDATE;
	IF NOT FOUND OR v_receipt.status <> 'running' OR v_receipt.lease_expires_at <= clock_timestamp()
		OR p_attempt_token IS DISTINCT FROM v_receipt.lease_token THEN
		RAISE EXCEPTION 'Document review lease is stale';
	END IF;
	SELECT * INTO v_version FROM public.document_versions WHERE id = v_receipt.document_version_id FOR UPDATE;
	SELECT * INTO v_document FROM public.documents WHERE id = v_receipt.document_id FOR UPDATE;
	IF v_version.id IS NULL OR v_document.id IS NULL OR v_document.organization_id IS DISTINCT FROM v_receipt.organization_id THEN
		RAISE EXCEPTION 'Document source tenant changed during automated review';
	END IF;
	IF v_document.sha256 IS DISTINCT FROM v_receipt.source_file_sha256
		OR v_version.updated_at IS DISTINCT FROM v_receipt.source_updated_at
		OR v_receipt.source_text_sha256 <> encode(extensions.digest(convert_to(coalesce(v_version.extracted_text, ''), 'UTF8'), 'sha256'), 'hex') THEN
		p_decision := 'blocked';
		p_decision_reason := 'Document source changed during automated review. Inspect the current version in Document Studio; no approval was made.';
	END IF;
	IF p_decision = 'approved' THEN
		IF v_receipt.review_kind = 'draft' THEN
			RAISE EXCEPTION 'Draft approval requires frozen independent source evidence, which is not yet supported';
		END IF;
		IF v_receipt.review_kind = 'promotion' AND v_receipt.proposal_snapshot IS DISTINCT FROM p_promotion_metadata->'reviewed_proposal' THEN
			p_decision := 'blocked';
			p_decision_reason := 'The queued proposal differs from the claimed proposal. Inspect the current fields in Document Studio; no approval was made.';
		END IF;
		IF v_version.ocr_required OR coalesce(p_promotion_metadata->'source_verification'->>'method', '') <> 'utf8_bytes_v1'
			OR p_promotion_metadata->'source_verification'->>'file_sha256' IS DISTINCT FROM v_receipt.source_file_sha256
			OR p_promotion_metadata->'source_verification'->>'text_sha256' IS DISTINCT FROM v_receipt.source_text_sha256 THEN
			RAISE EXCEPTION 'Independent source-byte verification is required';
		END IF;
		IF v_receipt.source_file_sha256 IS NULL OR jsonb_array_length(p_reviewers) <> 2 OR jsonb_array_length(p_source_claims) = 0
			OR p_reviewers->0->>'role' IS DISTINCT FROM 'bob' OR p_reviewers->1->>'role' IS DISTINCT FROM 'oracle'
			OR (SELECT count(*) FROM jsonb_array_elements(p_reviewers) reviewer WHERE reviewer->>'role' = 'bob') <> 1
			OR (SELECT count(*) FROM jsonb_array_elements(p_reviewers) reviewer WHERE reviewer->>'role' = 'oracle') <> 1
			OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_reviewers) reviewer
				WHERE coalesce(reviewer->>'provider', '') NOT IN ('gpu_workstation', 'ollama')
					OR nullif(reviewer->>'model', '') IS NULL
					OR NOT coalesce((reviewer->>'confidence')::real BETWEEN 0.95 AND 1, false))
			OR ((p_reviewers->0->>'provider') || ':' || (p_reviewers->0->>'model')) = ((p_reviewers->1->>'provider') || ':' || (p_reviewers->1->>'model'))
			OR EXISTS (
				SELECT 1 FROM jsonb_array_elements(p_source_claims) claim
				WHERE jsonb_typeof(claim) <> 'object' OR nullif(claim->>'field', '') IS NULL
					OR coalesce(claim->>'value_hash', '') !~ '^[a-f0-9]{64}$'
					OR coalesce(claim->>'quote_hash', '') !~ '^[a-f0-9]{64}$'
					OR NOT pg_input_is_valid(claim->>'confidence', 'real')
					OR CASE WHEN pg_input_is_valid(claim->>'confidence', 'real') THEN (claim->>'confidence')::real < 0.95 ELSE true END
					OR NOT CASE
						WHEN coalesce(claim->>'source_start', '') ~ '^[0-9]+$' AND coalesce(claim->>'source_end', '') ~ '^[0-9]+$'
							AND (claim->>'source_end')::integer > (claim->>'source_start')::integer
							AND (claim->>'source_end')::integer <= char_length(coalesce(v_version.extracted_text, ''))
						THEN claim->>'quote_hash' = encode(extensions.digest(convert_to(substring(v_version.extracted_text FROM (claim->>'source_start')::integer + 1 FOR (claim->>'source_end')::integer - (claim->>'source_start')::integer), 'UTF8'), 'sha256'), 'hex')
						ELSE false
					END
			) THEN
			RAISE EXCEPTION 'Automated approval requires two distinct, high-confidence private reviewers and source citations';
		END IF;
	END IF;

	IF v_receipt.review_kind = 'draft' THEN
		v_metadata := coalesce(v_version.metadata_json, '{}'::jsonb);
		IF v_metadata->>'authoring_status' IS DISTINCT FROM 'needs_review' THEN
			RAISE EXCEPTION 'Draft is no longer waiting for automated review';
		END IF;
		v_unconfirmed := (length(coalesce(v_metadata->>'authored_html', '') || coalesce(v_metadata->>'authored_text', '') || coalesce(v_version.extracted_text, ''))
			- length(replace(coalesce(v_metadata->>'authored_html', '') || coalesce(v_metadata->>'authored_text', '') || coalesce(v_version.extracted_text, ''), '[TO CONFIRM]', ''))) / 13;
		IF p_decision = 'approved' AND v_unconfirmed > 0 THEN RAISE EXCEPTION 'Draft still has unconfirmed fields'; END IF;
		UPDATE public.document_versions SET metadata_json = coalesce(metadata_json, '{}'::jsonb) || jsonb_build_object(
			'authoring_status', CASE WHEN p_decision = 'approved' THEN 'approved' WHEN p_decision = 'rejected' THEN 'rejected' ELSE 'needs_review' END,
			'automated_review', jsonb_build_object('receipt_id', p_receipt_id, 'decision', p_decision,
				'reason', left(p_decision_reason, 1200), 'reviewers', p_reviewers, 'source_hash', v_receipt.source_text_sha256,
				'source_claims', p_source_claims, 'reviewed_at', clock_timestamp())
		), updated_at = clock_timestamp() WHERE id = v_version.id;
		v_author := nullif(v_metadata->>'authored_by', '')::uuid;
		v_action := 'bob_document_auto_review_decided';
	ELSIF v_receipt.review_kind = 'classification' THEN
		IF p_decision = 'approved' AND (p_classification IS NULL OR jsonb_typeof(p_classification) <> 'object'
			OR coalesce(p_classification->>'privacy_class', '') NOT IN ('public', 'internal_non_sensitive', 'tenant_sensitive', 'restricted')
			OR (SELECT count(*) FROM jsonb_each(p_classification) item WHERE item.key IN ('contains_pii','contains_operational_security','contains_financial_data','contains_legal_privilege') AND jsonb_typeof(item.value) = 'boolean') <> 4
			OR NOT coalesce((p_classification->>'confidence')::real BETWEEN 0.95 AND 1, false)) THEN
			RAISE EXCEPTION 'Automated classification is incomplete';
		END IF;
		IF p_classification IS NOT NULL THEN
			v_class := p_classification->>'privacy_class';
			v_pii := coalesce((p_classification->>'contains_pii')::boolean, false);
			v_security := coalesce((p_classification->>'contains_operational_security')::boolean, false);
			v_financial := coalesce((p_classification->>'contains_financial_data')::boolean, false);
			v_privilege := coalesce((p_classification->>'contains_legal_privilege')::boolean, false);
			IF v_pii OR v_financial OR v_privilege THEN v_class := 'restricted'; END IF;
			IF v_security AND v_class IN ('public', 'internal_non_sensitive') THEN v_class := 'tenant_sensitive'; END IF;
		END IF;
		IF p_decision IN ('approved', 'quarantined') AND p_classification IS NOT NULL THEN
			INSERT INTO public.document_classifications (
				document_version_id, privacy_class, contains_pii, contains_operational_security,
				contains_financial_data, contains_legal_privilege, classifier_source, confidence, rationale
			) VALUES (
				v_version.id, v_class, v_pii, v_security, v_financial, v_privilege, 'bob',
				least(1, greatest(0, coalesce((p_classification->>'confidence')::real, 0))), left(p_decision_reason, 1200)
			);
			IF p_decision = 'quarantined' OR v_class = 'restricted' THEN
				p_decision := 'quarantined';
				p_decision_reason := 'The source contains restricted or sensitive information and was quarantined. Review the classification in Document Studio.';
				UPDATE public.documents SET current_scope = 'quarantined', updated_at = clock_timestamp() WHERE id = v_document.id;
			ELSIF p_decision = 'approved' AND p_scope IN ('tenant_reference', 'global_reference') THEN
				IF p_scope = 'global_reference' AND (v_class NOT IN ('public', 'internal_non_sensitive') OR v_pii OR v_security OR v_financial OR v_privilege) THEN
					RAISE EXCEPTION 'Privacy classification does not permit global promotion';
				END IF;
				v_promotion := public.promote_document_to_reference_library(v_version.id, p_scope, NULL, p_promotion_metadata);
				IF coalesce((v_promotion->>'ok')::boolean, false) IS DISTINCT FROM true THEN
					RAISE EXCEPTION 'Automated reference promotion failed: %', coalesce(v_promotion->>'error', 'unknown');
				END IF;
			END IF;
		ELSIF p_decision IN ('quarantined', 'blocked') THEN
			UPDATE public.documents SET current_scope = 'quarantined', updated_at = clock_timestamp() WHERE id = v_document.id;
		END IF;
		UPDATE public.document_versions SET metadata_json = coalesce(metadata_json, '{}'::jsonb) || jsonb_build_object(
			'automated_review', jsonb_build_object('receipt_id', p_receipt_id, 'decision', p_decision,
				'reason', left(p_decision_reason, 1200), 'reviewers', p_reviewers, 'source_hash', v_receipt.source_text_sha256,
				'source_claims', p_source_claims, 'reviewed_at', clock_timestamp())
		), updated_at = clock_timestamp() WHERE id = v_version.id;
		v_author := v_document.uploaded_by;
		v_action := 'document_classification_auto_reviewed';
	ELSE
		SELECT * INTO v_proposal FROM public.document_promotion_proposals
		WHERE id = v_receipt.proposal_id AND document_version_id = v_version.id AND organization_id = v_document.organization_id FOR UPDATE;
		IF NOT FOUND OR v_proposal.status <> 'proposed' THEN RAISE EXCEPTION 'Promotion proposal is no longer pending'; END IF;
		IF v_receipt.proposal_snapshot IS DISTINCT FROM jsonb_build_object('target_type', v_proposal.target_type,
			'proposed_payload', v_proposal.proposed_payload, 'source_map', v_proposal.source_map) THEN
			p_decision := 'blocked';
			p_decision_reason := 'The proposal changed during review; inspect the current fields in Document Studio.';
		END IF;
		IF p_decision IN ('approved', 'rejected') THEN
			UPDATE public.document_promotion_proposals SET status = p_decision, reviewed_by = NULL,
				reviewed_at = clock_timestamp(), review_reason = 'Automated Bob+Oracle review: ' || left(p_decision_reason, 1000),
				updated_at = clock_timestamp() WHERE id = v_proposal.id;
		ELSE
			UPDATE public.document_promotion_proposals SET status = 'failed', review_reason = 'Automated Bob+Oracle review blocked: ' || left(p_decision_reason, 1000),
				updated_at = clock_timestamp() WHERE id = v_proposal.id;
		END IF;
		v_author := v_proposal.requested_by;
		v_action := 'document_promotion_auto_reviewed';
	END IF;

	UPDATE public.bob_document_auto_review_receipts SET status = p_decision,
		decision_reason = left(p_decision_reason, 2000), bob_provider = p_reviewers->0->>'provider',
		bob_model = p_reviewers->0->>'model', oracle_provider = p_reviewers->1->>'provider',
		oracle_model = p_reviewers->1->>'model', decision_report = jsonb_build_object(
			'reviewers', p_reviewers, 'source_claims', p_source_claims,
			'classification', p_classification, 'promotion_metadata', p_promotion_metadata
		), lease_expires_at = NULL, updated_at = clock_timestamp()
	WHERE id = v_receipt.id RETURNING * INTO v_receipt;
	INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
	VALUES (v_document.organization_id, NULL, v_action, 'document_versions', v_version.id,
		jsonb_build_object('receipt_id', v_receipt.id, 'review_kind', v_receipt.review_kind,
			'decision', p_decision, 'reason_code', p_decision_reason, 'source_hash', v_receipt.source_text_sha256,
			'reviewers', p_reviewers, 'proposal_id', v_receipt.proposal_id));

	IF p_decision IN ('blocked', 'quarantined', 'rejected') THEN
		PERFORM public.enqueue_notification(
			p_organization_id => v_document.organization_id,
			p_category => 'document_review',
			p_title => 'Bob needs direction on a document',
			p_body => left(p_decision_reason, 400),
			p_severity => 'warning',
			p_recipient_user_id => v_author,
			p_recipient_role => CASE WHEN v_author IS NULL THEN 'admin' ELSE NULL END,
			p_link_page => 'document-studio',
			p_link_payload => jsonb_build_object('document_id', v_document.id, 'version_id', v_version.id),
			p_dedup_key => 'bob_document_auto_review:' || v_receipt.id::text
		);
	END IF;
	RETURN v_receipt;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_bob_document_auto_review(uuid, text, text, jsonb, jsonb, jsonb, text, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finish_bob_document_auto_review(uuid, text, text, jsonb, jsonb, jsonb, text, jsonb, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.apply_bob_document_auto_proposal(p_receipt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
	v_receipt public.bob_document_auto_review_receipts%rowtype;
	v_proposal public.document_promotion_proposals%rowtype;
	v_document public.documents%rowtype;
	v_version public.document_versions%rowtype;
	v_payload jsonb;
	v_client_id uuid;
	v_client_name text;
	v_name text;
	v_invoice_number text;
	v_invoice_date date;
	v_due_date date;
	v_subtotal numeric;
	v_gst numeric;
	v_total numeric;
	v_client_count integer;
	v_starts_on date;
	v_ends_on date;
	v_invoice_id uuid;
	v_target_id uuid;
	v_reason text;
	v_claims jsonb;
	v_source_text text;
BEGIN
	IF (SELECT auth.jwt() ->> 'role') IS DISTINCT FROM 'service_role' THEN
		RAISE EXCEPTION 'Service identity required';
	END IF;
	SELECT * INTO v_receipt FROM public.bob_document_auto_review_receipts WHERE id = p_receipt_id FOR UPDATE;
	IF NOT FOUND OR v_receipt.review_kind <> 'promotion' THEN RAISE EXCEPTION 'Automated proposal receipt not found'; END IF;
	IF v_receipt.status = 'applied' THEN RETURN jsonb_build_object('status', 'applied', 'target_id', v_receipt.applied_target_id, 'replayed', true); END IF;
	IF v_receipt.status <> 'approved' OR v_receipt.proposal_id IS NULL THEN RAISE EXCEPTION 'Proposal lacks an approved Bob/Oracle receipt'; END IF;
	SELECT * INTO v_proposal FROM public.document_promotion_proposals WHERE id = v_receipt.proposal_id FOR UPDATE;
	SELECT * INTO v_document FROM public.documents WHERE id = v_receipt.document_id FOR UPDATE;
	SELECT * INTO v_version FROM public.document_versions WHERE id = v_receipt.document_version_id FOR UPDATE;
	IF v_proposal.status <> 'approved' OR v_proposal.organization_id <> v_receipt.organization_id
		OR v_proposal.document_version_id <> v_receipt.document_version_id
		OR v_version.updated_at IS DISTINCT FROM v_receipt.source_updated_at
		OR v_document.sha256 IS DISTINCT FROM v_receipt.source_file_sha256
		OR v_document.organization_id IS DISTINCT FROM v_receipt.organization_id
		OR v_receipt.source_text_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(coalesce(v_version.extracted_text, ''), 'UTF8'), 'sha256'), 'hex')
		OR v_receipt.proposal_snapshot IS DISTINCT FROM jsonb_build_object('target_type', v_proposal.target_type,
			'proposed_payload', v_proposal.proposed_payload, 'source_map', v_proposal.source_map) THEN
		v_reason := 'The proposal or source changed after review; no business record was changed. Inspect the current version in Document Studio.';
	END IF;
	v_payload := coalesce(v_proposal.proposed_payload, '{}'::jsonb);
	v_claims := coalesce(v_receipt.decision_report->'source_claims', '[]'::jsonb);
	v_source_text := coalesce(v_version.extracted_text, '');

	IF v_reason IS NOT NULL THEN
		NULL;
	ELSIF v_proposal.target_type = 'crm_agreement' THEN
		v_reason := 'Creating an agreement grants operational access even before invitation. No agreement was created; an authorized person must direct this target in Document Studio.';
	ELSIF v_proposal.target_type = 'finance_reconciliation' THEN
		v_invoice_number := nullif(btrim(coalesce(v_payload->>'invoice_number', '')), '');
		v_client_name := coalesce(nullif(btrim(v_payload->>'client_organization_name'), ''), nullif(btrim(v_payload->>'client_name'), ''));
		IF v_invoice_number IS NULL OR v_client_name IS NULL
			OR coalesce(v_payload->>'currency', '') <> 'NZD'
			OR nullif(v_payload->>'invoice_date', '') IS NULL
			OR nullif(v_payload->>'due_date', '') IS NULL
			OR nullif(v_payload->>'subtotal', '') IS NULL
			OR nullif(v_payload->>'gst_amount', '') IS NULL
			OR nullif(v_payload->>'total_amount', '') IS NULL
			OR NOT pg_input_is_valid(v_payload->>'invoice_date', 'date')
			OR NOT pg_input_is_valid(v_payload->>'due_date', 'date')
			OR NOT pg_input_is_valid(v_payload->>'subtotal', 'numeric')
			OR NOT pg_input_is_valid(v_payload->>'gst_amount', 'numeric')
			OR NOT pg_input_is_valid(v_payload->>'total_amount', 'numeric')
			OR EXISTS (
				SELECT 1 FROM jsonb_each_text(v_payload) proposed(field, value)
				WHERE proposed.field = ANY(ARRAY['invoice_number','client_organization_name','client_name','invoice_date','due_date','subtotal','gst_amount','total_amount','currency'])
					AND NOT EXISTS (
						SELECT 1 FROM jsonb_array_elements(v_claims) claim
						WHERE claim->>'field' = proposed.field
							AND claim->>'value_hash' = encode(extensions.digest(convert_to(proposed.value, 'UTF8'), 'sha256'), 'hex')
							AND coalesce(claim->>'source_start', '') ~ '^[0-9]+$'
							AND coalesce(claim->>'source_end', '') ~ '^[0-9]+$'
							AND (claim->>'source_end')::integer <= char_length(v_source_text)
							AND (claim->>'source_end')::integer > (claim->>'source_start')::integer
							AND claim->>'quote_hash' = encode(extensions.digest(convert_to(substring(v_source_text FROM (claim->>'source_start')::integer + 1 FOR (claim->>'source_end')::integer - (claim->>'source_start')::integer), 'UTF8'), 'sha256'), 'hex')
					)
			) THEN
			v_reason := 'Invoice proposal requires source-backed NZD currency, client, reference, dates, and totals; no invoice was created. Missing or unsupported currencies require direction.';
		ELSE
			v_invoice_date := (v_payload->>'invoice_date')::date;
			v_due_date := (v_payload->>'due_date')::date;
			v_subtotal := (v_payload->>'subtotal')::numeric;
			v_gst := (v_payload->>'gst_amount')::numeric;
			v_total := (v_payload->>'total_amount')::numeric;
			SELECT (array_agg(client.id))[1], count(*) INTO v_client_id, v_client_count
			FROM public.organizations client
			WHERE client.active AND lower(btrim(client.name)) = lower(v_client_name)
				AND EXISTS (SELECT 1 FROM public.service_agreements agreement
					WHERE agreement.provider_organization_id = v_proposal.organization_id
						AND agreement.client_organization_id = client.id AND agreement.agreement_type = 'operational'
						AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
						AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date));
			IF v_client_count <> 1 THEN
				v_reason := 'Client name did not resolve to exactly one active client organization; no invoice was created.';
			ELSIF v_due_date < v_invoice_date OR v_subtotal < 0 OR v_gst < 0 OR v_total <= 0 THEN
				v_reason := 'Invoice dates or amounts failed deterministic validation; no invoice was created.';
			ELSIF v_total <> v_subtotal + v_gst THEN
				v_reason := 'Invoice total does not equal subtotal plus GST; no invoice was created.';
			ELSIF v_subtotal > 9999999999.99 OR v_gst > 9999999999.99 OR v_total > 9999999999.99
				OR round(v_subtotal, 2) <> v_subtotal OR round(v_gst, 2) <> v_gst OR round(v_total, 2) <> v_total THEN
				v_reason := 'Invoice amounts exceed supported currency precision; no invoice was created.';
			ELSE
				PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bob-document-invoice:' || v_proposal.organization_id::text || ':' || v_invoice_number, 0));
				SELECT id, notes INTO v_invoice_id, v_name FROM public.invoices
				WHERE organization_id = v_proposal.organization_id AND invoice_number = v_invoice_number LIMIT 1;
				IF v_invoice_id IS NOT NULL THEN
					IF v_name LIKE '%' || v_proposal.id::text || '%' THEN v_target_id := v_invoice_id;
					ELSE v_reason := 'Invoice number already exists outside this proposal; no duplicate was created.'; END IF;
				ELSE
					INSERT INTO public.invoices (
						organization_id, client_organization_id, invoice_number, invoice_date, due_date,
						status, subtotal, gst_amount, total_amount, currency, notes, created_by
					) VALUES (
						v_proposal.organization_id, v_client_id, v_invoice_number, v_invoice_date, v_due_date,
						'draft', v_subtotal, v_gst, v_total, 'NZD',
						'Created as an unissued draft by Bob+Oracle from proposal ' || v_proposal.id::text ||
							'; source version ' || v_version.id::text || '; receipt ' || v_receipt.id::text,
						NULL
					) RETURNING id INTO v_target_id;
				END IF;
			END IF;
		END IF;
	ELSE
		v_reason := 'This proposal target requires a domain-specific deterministic effect path that is not enabled for auto-application; no business record was changed.';
	END IF;

	IF v_target_id IS NULL THEN
		UPDATE public.document_promotion_proposals SET status = 'failed', review_reason = left(v_reason, 1200), updated_at = clock_timestamp()
		WHERE id = v_proposal.id;
		UPDATE public.bob_document_auto_review_receipts SET status = 'blocked', decision_reason = left(v_reason, 2000), updated_at = clock_timestamp()
		WHERE id = v_receipt.id RETURNING * INTO v_receipt;
		INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
		VALUES (v_document.organization_id, NULL, 'document_auto_proposal_application_blocked', 'document_promotion_proposals', v_proposal.id,
			jsonb_build_object('receipt_id', v_receipt.id, 'target_type', v_proposal.target_type, 'reason', v_reason));
		PERFORM public.enqueue_notification(
			p_organization_id => v_document.organization_id,
			p_category => 'document_review',
			p_title => 'Bob needs direction on a document proposal',
			p_body => left(v_reason, 400), p_severity => 'warning', p_recipient_user_id => v_proposal.requested_by,
			p_link_page => 'document-studio', p_link_payload => jsonb_build_object('document_id', v_document.id, 'version_id', v_version.id),
			p_dedup_key => 'bob_document_auto_review:' || v_receipt.id::text
		);
		RETURN jsonb_build_object('status', 'blocked', 'reason', left(v_reason, 1200), 'receipt_id', v_receipt.id);
	END IF;

	UPDATE public.document_promotion_proposals SET status = 'applied', applied_target_id = v_target_id,
		applied_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = v_proposal.id;
	UPDATE public.bob_document_auto_review_receipts SET status = 'applied', applied_target_id = v_target_id,
		decision_reason = 'Approved by two distinct private reviewers and applied as a draft.', updated_at = clock_timestamp()
	WHERE id = v_receipt.id RETURNING * INTO v_receipt;
	INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
	VALUES (v_document.organization_id, NULL, 'document_auto_proposal_applied',
		CASE WHEN v_proposal.target_type = 'crm_agreement' THEN 'service_agreements' ELSE 'invoices' END,
		v_target_id, jsonb_build_object('receipt_id', v_receipt.id, 'proposal_id', v_proposal.id,
			'document_version_id', v_version.id, 'target_type', v_proposal.target_type, 'created_by', 'bob_oracle'));
	RETURN jsonb_build_object('status', 'applied', 'target_id', v_target_id, 'receipt_id', v_receipt.id);
EXCEPTION WHEN OTHERS THEN
	RAISE;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_bob_document_auto_proposal(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_bob_document_auto_proposal(uuid) TO service_role;
