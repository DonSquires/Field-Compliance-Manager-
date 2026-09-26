-- Data-driven identity/credential document catalogue and governed registration wrappers.

CREATE TABLE IF NOT EXISTS public.identity_document_type_definitions (
  document_kind text PRIMARY KEY,
  display_name text NOT NULL,
  category text NOT NULL CHECK (category IN ('identity','credential','warrant','photo','other')),
  canonical_destination text NOT NULL CHECK (canonical_destination IN ('person_records','person_records_and_staff_credentials','staff_credentials','evidence_only')),
  staff_credential_type text,
  default_authorized_activities text[] NOT NULL DEFAULT '{}',
  strong_identity boolean NOT NULL DEFAULT false,
  supports_face_enrollment boolean NOT NULL DEFAULT true,
  extraction_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_order integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.identity_document_type_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identity_document_type_definitions_read ON public.identity_document_type_definitions;
CREATE POLICY identity_document_type_definitions_read ON public.identity_document_type_definitions
FOR SELECT TO authenticated USING (true);
REVOKE ALL ON TABLE public.identity_document_type_definitions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.identity_document_type_definitions TO authenticated;
GRANT ALL ON TABLE public.identity_document_type_definitions TO service_role;

INSERT INTO public.identity_document_type_definitions
(document_kind,display_name,category,canonical_destination,staff_credential_type,default_authorized_activities,strong_identity,supports_face_enrollment,extraction_rules,display_order)
VALUES
('driver_licence','Driver licence','identity','person_records_and_staff_credentials','drivers_licence','{}',true,true,'{"number_labels":["licence number","licence no"],"indicators":["driver licence"]}',10),
('firearms_licence','Firearms licence','identity','person_records_and_staff_credentials','firearms_licence','{}',true,true,'{"number_labels":["licence number","licence no"],"indicators":["firearms licence","arms act"]}',20),
('security_licence','Security licence / CoA','credential','person_records_and_staff_credentials','security_licence','{}',false,true,'{"number_labels":["certificate of approval number","badge number","coa number"],"indicators":["certificate of approval","private security personnel","pspla"]}',30),
('warrant_of_appointment','Warrant of appointment','warrant','staff_credentials','warrant_of_authority',ARRAY['Appointed officer'],false,true,'{"number_labels":["warrant number","appointment number"],"indicators":["warrant of appointment","appointed as"]}',40),
('noise_control_warrant','Noise control officer warrant','warrant','staff_credentials','noise_control_warrant',ARRAY['Noise control officer'],false,true,'{"number_labels":["warrant number","appointment number"],"indicators":["noise control officer","resource management act"]}',50),
('parking_warrant','Parking warden warrant','warrant','staff_credentials','warrant_of_authority',ARRAY['Parking warden'],false,true,'{"number_labels":["warrant number","appointment number"],"indicators":["parking warden","land transport act"]}',60),
('freedom_camping_warrant','Freedom camping officer warrant','warrant','staff_credentials','warrant_of_authority',ARRAY['Freedom camping officer'],false,true,'{"number_labels":["warrant number","appointment number"],"indicators":["freedom camping officer","freedom camping act"]}',70),
('biosecurity_warrant','Biosecurity officer warrant','warrant','staff_credentials','biosecurity_warrant',ARRAY['Biosecurity officer'],false,true,'{"number_labels":["warrant number","appointment number"],"indicators":["biosecurity officer","biosecurity act"]}',80),
('passport','Passport','identity','person_records',NULL,'{}',true,true,'{"number_labels":["passport number","document number"],"indicators":["passport"]}',90),
('national_id','Other government ID','identity','person_records',NULL,'{}',true,true,'{"number_labels":["document number","card number"],"indicators":["identity card","government id"]}',100),
('person_photo','Person reference photo','photo','person_records',NULL,'{}',false,true,'{"indicators":[]}',110),
('other_identity','Other identity evidence','other','evidence_only',NULL,'{}',false,true,'{"number_labels":["document number","card number"],"indicators":[]}',120)
ON CONFLICT (document_kind) DO UPDATE SET
  display_name=excluded.display_name, category=excluded.category, canonical_destination=excluded.canonical_destination,
  staff_credential_type=excluded.staff_credential_type, default_authorized_activities=excluded.default_authorized_activities,
  strong_identity=excluded.strong_identity, supports_face_enrollment=excluded.supports_face_enrollment,
  extraction_rules=excluded.extraction_rules, display_order=excluded.display_order, active=excluded.active, updated_at=clock_timestamp();

CREATE OR REPLACE FUNCTION public.get_identity_document_types()
RETURNS SETOF public.identity_document_type_definitions
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT definition.* FROM public.identity_document_type_definitions definition
  WHERE definition.active AND auth.uid() IS NOT NULL ORDER BY definition.display_order, definition.display_name
$$;
REVOKE ALL ON FUNCTION public.get_identity_document_types() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_identity_document_types() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.register_deterministic_identity_document_proposal(
  p_actor_user_id uuid, p_organization_id uuid, p_person_record_id uuid, p_attachment_id uuid,
  p_document_kind text, p_sha256 text, p_proposed_fields jsonb,
  p_face_embedding jsonb DEFAULT NULL, p_face_confidence real DEFAULT NULL, p_face_count integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_definition public.identity_document_type_definitions%rowtype;
  v_storage_kind text;
  v_result jsonb;
  v_document_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Service identity required for identity extraction registration'; END IF;
  SELECT * INTO v_definition FROM public.identity_document_type_definitions WHERE document_kind=p_document_kind AND active;
  IF v_definition.document_kind IS NULL THEN RAISE EXCEPTION 'Unsupported identity document kind'; END IF;
  v_storage_kind := CASE WHEN p_document_kind IN ('driver_licence','firearms_licence','security_licence','passport','national_id','person_photo','other_identity') THEN p_document_kind ELSE 'other_identity' END;
  v_result := public.register_identity_document_proposal(p_actor_user_id,p_organization_id,p_person_record_id,p_attachment_id,
    v_storage_kind,p_sha256,p_proposed_fields,p_face_embedding,p_face_confidence,p_face_count);
  v_document_id := (v_result->>'identity_document_id')::uuid;
  IF v_document_id IS NOT NULL AND v_storage_kind <> p_document_kind THEN
    UPDATE public.person_identity_documents SET document_kind=p_document_kind WHERE id=v_document_id;
    UPDATE public.evidence_items SET metadata=jsonb_set(metadata,'{document_kind}',to_jsonb(p_document_kind),true)
      WHERE id=(v_result->>'evidence_item_id')::uuid;
    UPDATE public.bob_attachments SET extraction_payload=jsonb_set(extraction_payload,'{document_kind}',to_jsonb(p_document_kind),true)
      WHERE id=p_attachment_id;
    UPDATE public.audit_log SET metadata=jsonb_set(metadata,'{document_kind}',to_jsonb(p_document_kind),true)
      WHERE action='identity_document_proposed' AND target_id=v_document_id;
  END IF;
  RETURN v_result || jsonb_build_object(
    'document_kind',p_document_kind,'display_name',v_definition.display_name,
    'canonical_destination',v_definition.canonical_destination,
    'staff_credential_type',v_definition.staff_credential_type,
    'default_authorized_activities',v_definition.default_authorized_activities
  );
END;
$$;
REVOKE ALL ON FUNCTION public.register_deterministic_identity_document_proposal(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb,real,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_deterministic_identity_document_proposal(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb,real,integer) TO postgres,service_role;

CREATE OR REPLACE FUNCTION public.review_deterministic_identity_evidence(
  p_identity_document_id uuid, p_action text, p_approved_fields jsonb DEFAULT '{}'::jsonb, p_review_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_document public.person_identity_documents%rowtype;
  v_definition public.identity_document_type_definitions%rowtype;
  v_result jsonb;
  v_extras jsonb;
BEGIN
  SELECT * INTO v_document FROM public.person_identity_documents WHERE id=p_identity_document_id;
  IF v_document.id IS NULL THEN RAISE EXCEPTION 'Identity document not found'; END IF;
  SELECT * INTO v_definition FROM public.identity_document_type_definitions WHERE document_kind=v_document.document_kind AND active;
  IF v_definition.document_kind IS NULL THEN RAISE EXCEPTION 'Unsupported identity document kind'; END IF;
  v_result := public.review_identity_evidence(p_identity_document_id,p_action,p_approved_fields,p_review_notes);
  IF p_action='approve' THEN
    v_extras := jsonb_strip_nulls(jsonb_build_object(
      'document_number',nullif(trim(p_approved_fields->>'document_number'),''),
      'issued_date',nullif(p_approved_fields->>'issued_date','')::date,
      'expiry_date',nullif(p_approved_fields->>'expiry_date','')::date,
      'issuing_authority',nullif(trim(p_approved_fields->>'issuing_authority'),''),
      'authorized_activities',nullif(trim(p_approved_fields->>'authorized_activities'),'')
    ));
    UPDATE public.person_identity_documents
    SET extracted_fields=jsonb_set(extracted_fields,'{approved}',coalesce(extracted_fields->'approved','{}'::jsonb)||v_extras,true)
    WHERE id=p_identity_document_id;
  END IF;
  RETURN v_result || jsonb_build_object(
    'document_kind',v_definition.document_kind,
    'canonical_destination',v_definition.canonical_destination,
    'staff_credential_type',v_definition.staff_credential_type,
    'default_authorized_activities',v_definition.default_authorized_activities
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.review_identity_evidence(uuid,text,jsonb,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.review_deterministic_identity_evidence(uuid,text,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_deterministic_identity_evidence(uuid,text,jsonb,text) TO authenticated,service_role;

COMMENT ON TABLE public.identity_document_type_definitions IS 'Deterministic registry for identity, credential, and warrant document intake. Staff destinations use staff_credentials; this table does not grant work readiness.';
COMMENT ON FUNCTION public.register_deterministic_identity_document_proposal(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb,real,integer) IS 'Service-only data-driven identity/warrant proposal registration using the active document definition registry.';
COMMENT ON FUNCTION public.review_deterministic_identity_evidence(uuid,text,jsonb,text) IS 'Human approval wrapper that preserves generic warrant fields and returns the governed staff credential destination without creating staff readiness.';
