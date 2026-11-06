-- get_identity_registry hit the 8s authenticated statement timeout in production
-- (three cancellations on 2026-11-06). Profiling against the live catalog showed
-- ~3s spent calling nzta_document_restricted once for each of ~2.9k NZTA
-- documents, plus per-person document counts and per-vehicle evidence counts
-- that scan without a supporting index. Same contract and masking result;
-- access is resolved set-wise and the two lookups gain indexes.

CREATE INDEX IF NOT EXISTS person_identity_documents_person_record_idx
  ON public.person_identity_documents (person_record_id)
  WHERE person_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_items_observation_link_idx
  ON public.evidence_items (organization_id, (metadata->>'observation_id'));
CREATE OR REPLACE FUNCTION public.get_identity_registry(p_organization_id uuid, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_search text := lower(trim(coalesce(p_search, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 250));
  v_visible_organizations uuid[];
  v_uid uuid := auth.uid();
  v_owner_access_orgs uuid[];
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;

  SELECT array_agg(DISTINCT scope.id)
    INTO v_visible_organizations
    FROM (
      SELECT p_organization_id AS id
      UNION
      SELECT unnest(public.get_descendant_organizations(p_organization_id))
      UNION
      SELECT agreement.client_organization_id
      FROM public.service_agreements AS agreement
      WHERE agreement.provider_organization_id = p_organization_id
        AND agreement.agreement_type = 'operational'
    ) AS scope;

  -- Owner-identity access is resolved once per checking organisation rather than
  -- once per document; the per-document test below mirrors nzta_document_restricted.
  SELECT array_agg(scope.organization_id)
    INTO v_owner_access_orgs
    FROM (
      SELECT DISTINCT nzta_check.organization_id
      FROM public.person_identity_documents AS document
      JOIN public.vehicle_identity_checks AS nzta_check
        ON nzta_check.identity_document_id = document.id
      WHERE document.organization_id = p_organization_id
        AND document.document_kind = 'nzta_mvr_record'
    ) AS scope
   WHERE public.can_access_vehicle_owner_identity(scope.organization_id);

  RETURN jsonb_build_object(
    'people', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'person_record_id', person.id,
        'canonical_person_id', link.canonical_person_id,
        'display_name', person.display_name,
        'review_state', person.review_state,
        'profile_details', coalesce(person.metadata->'profile_details', '{}'::jsonb),
        'date_of_birth', coalesce(person.metadata->'profile_details'->>'date_of_birth', canonical.date_of_birth::text),
        'canonical_review_state', canonical.review_state,
        'face_candidate_ready', EXISTS (
          SELECT 1 FROM public.person_face_templates face
          WHERE face.person_record_id = person.id
            AND face.organization_id = person.organization_id
        ),
        'document_count', (
          SELECT count(*)
          FROM public.person_identity_documents document
          WHERE document.person_record_id = person.id
        )
      ) ORDER BY lower(coalesce(person.display_name, '')), person.created_at)
      FROM (
        SELECT *
        FROM public.person_records
        WHERE organization_id = p_organization_id
          AND (
            v_search = ''
            OR lower(coalesce(display_name, '') || ' ' || coalesce(metadata::text, ''))
              LIKE '%' || v_search || '%'
          )
        ORDER BY created_at DESC
        LIMIT v_limit
      ) AS person
      LEFT JOIN public.canonical_person_links AS link
        ON link.source_table = 'person_records'
       AND link.source_id = person.id
      LEFT JOIN public.canonical_people AS canonical
        ON canonical.id = link.canonical_person_id
    ), '[]'::jsonb),
    'vehicle_total', (
      SELECT count(*)
      FROM public.canonical_vehicles AS vehicle
      WHERE (
        vehicle.org_notes ? p_organization_id::text
        OR EXISTS (
          SELECT 1
          FROM public.canonical_vehicle_links AS link
          WHERE link.canonical_vehicle_id = vehicle.id
            AND nullif(link.metadata->>'organization_id', '')::uuid = ANY(v_visible_organizations)
        )
        OR EXISTS (
          SELECT 1
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        )
        OR EXISTS (
          SELECT 1
          FROM public.cctv_entity_observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        )
      )
      AND (
        v_search = ''
        OR lower(concat_ws(
          ' ',
          vehicle.plate_number,
          vehicle.make,
          vehicle.model,
          vehicle.colour,
          vehicle.body_type
        )) LIKE '%' || v_search || '%'
      )
    ),
    'vehicles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', vehicle.id,
        'plate_number', vehicle.plate_number,
        'make', vehicle.make,
        'model', vehicle.model,
        'year', vehicle.year,
        'colour', vehicle.colour,
        'body_type', vehicle.body_type,
        'rego_status', vehicle.rego_status,
        'rego_expiry', vehicle.rego_expiry,
        'wof_status', vehicle.wof_status,
        'wof_expiry', vehicle.wof_expiry,
        'cof_status', vehicle.cof_status,
        'cof_expiry', vehicle.cof_expiry,
        'notes', vehicle.org_notes->p_organization_id::text->>'text',
        'compliance_source', vehicle.compliance_source,
        'compliance_checked_at', vehicle.compliance_checked_at,
        'observation_count', (
          SELECT count(*)
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'evidence_count', (
          SELECT count(*)
          FROM public.observations AS observation
          JOIN public.evidence_items AS evidence
            ON evidence.organization_id = observation.organization_id
           AND evidence.metadata->>'observation_id' = observation.id::text
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'first_seen_at', (
          SELECT min(observation.observed_at)
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'last_seen_at', (
          SELECT max(observation.observed_at)
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'source_kinds', coalesce((
          SELECT jsonb_agg(source.kind ORDER BY source.kind)
          FROM (
            SELECT DISTINCT CASE
              WHEN observation.module_key = 'cctv_review' THEN 'CCTV review'
              WHEN observation.plate_source = 'historical_import' THEN 'Approved patrol record'
              ELSE 'Field observation'
            END AS kind
            FROM public.observations AS observation
            WHERE observation.organization_id = ANY(v_visible_organizations)
              AND observation.canonical_vehicle_id = vehicle.id
          ) AS source
        ), '[]'::jsonb)
      ) ORDER BY coalesce(vehicle.last_seen_at, vehicle.updated_at) DESC, vehicle.plate_number)
      FROM (
        SELECT *
        FROM public.canonical_vehicles AS candidate
        WHERE (
          candidate.org_notes ? p_organization_id::text
          OR EXISTS (
            SELECT 1
            FROM public.canonical_vehicle_links AS link
            WHERE link.canonical_vehicle_id = candidate.id
              AND nullif(link.metadata->>'organization_id', '')::uuid = ANY(v_visible_organizations)
          )
          OR EXISTS (
            SELECT 1
            FROM public.observations AS observation
            WHERE observation.organization_id = ANY(v_visible_organizations)
              AND observation.canonical_vehicle_id = candidate.id
          )
          OR EXISTS (
            SELECT 1
            FROM public.cctv_entity_observations AS observation
            WHERE observation.organization_id = ANY(v_visible_organizations)
              AND observation.canonical_vehicle_id = candidate.id
          )
        )
        AND (
          v_search = ''
          OR lower(concat_ws(
            ' ',
            candidate.plate_number,
            candidate.make,
            candidate.model,
            candidate.colour,
            candidate.body_type
          )) LIKE '%' || v_search || '%'
        )
        ORDER BY coalesce(candidate.last_seen_at, candidate.updated_at) DESC, candidate.plate_number
        LIMIT v_limit
      ) AS vehicle
    ), '[]'::jsonb),
    'documents', coalesce((
      -- NZTA Motor Vehicle Register records linked to a check stay masked until
      -- the caller opens a purpose-stated reveal for that vehicle or person.
      SELECT jsonb_agg(CASE WHEN restriction.restricted THEN jsonb_build_object(
        'id', document.id,
        'document_kind', document.document_kind,
        'review_state', document.review_state,
        'created_at', document.created_at,
        'reviewed_at', document.reviewed_at,
        'nzta_restricted', true,
        'canonical_vehicle_id', nzta_check.canonical_vehicle_id,
        'plate_number', nzta_vehicle.plate_number
      ) ELSE jsonb_build_object(
        'id', document.id,
        'person_record_id', document.person_record_id,
        'evidence_item_id', document.evidence_item_id,
        'attachment_id', document.attachment_id,
        'document_kind', document.document_kind,
        'extracted_fields', document.extracted_fields,
        'review_state', document.review_state,
        'review_notes', document.review_notes,
        'created_at', document.created_at,
        'reviewed_at', document.reviewed_at,
        'file_name', attachment.file_name,
        'file_type', attachment.file_type,
        'storage_bucket', attachment.storage_bucket,
        'storage_path', attachment.storage_path,
        'nzta_restricted', false,
        'canonical_vehicle_id', nzta_check.canonical_vehicle_id,
        'plate_number', nzta_vehicle.plate_number
      ) END ORDER BY document.created_at DESC)
      FROM public.person_identity_documents AS document
      LEFT JOIN public.bob_attachments AS attachment
        ON attachment.id = document.attachment_id
      LEFT JOIN public.vehicle_identity_checks AS nzta_check
        ON nzta_check.identity_document_id = document.id
      LEFT JOIN public.canonical_vehicles AS nzta_vehicle
        ON nzta_vehicle.id = nzta_check.canonical_vehicle_id
      CROSS JOIN LATERAL (
        SELECT document.document_kind = 'nzta_mvr_record' AND nzta_check.id IS NOT NULL
          AND NOT coalesce(
            nzta_check.organization_id = ANY(coalesce(v_owner_access_orgs, ARRAY[]::uuid[]))
            AND (
              EXISTS (
                SELECT 1 FROM public.nzta_register_access_log AS reveal
                WHERE reveal.actor_user_id = v_uid
                  AND reveal.subject_type = 'vehicle'
                  AND reveal.subject_id = nzta_check.canonical_vehicle_id
                  AND reveal.organization_id = nzta_check.organization_id
                  AND reveal.expires_at > clock_timestamp()
              )
              OR (
                nzta_check.canonical_person_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM public.nzta_register_access_log AS reveal
                  WHERE reveal.actor_user_id = v_uid
                    AND reveal.subject_type = 'person'
                    AND reveal.subject_id = nzta_check.canonical_person_id
                    AND reveal.organization_id = nzta_check.organization_id
                    AND reveal.expires_at > clock_timestamp()
                )
              )
            ),
            false
          ) AS restricted
      ) AS restriction
      WHERE document.organization_id = p_organization_id
    ), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_identity_registry(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_identity_registry(uuid, text, integer) TO authenticated, service_role;