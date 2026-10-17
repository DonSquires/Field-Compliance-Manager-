ALTER TABLE public.canonical_vehicles
    ADD COLUMN IF NOT EXISTS external_data_source_name text,
    ADD COLUMN IF NOT EXISTS external_data_source_url text,
    ADD COLUMN IF NOT EXISTS external_data_source_location text,
    ADD COLUMN IF NOT EXISTS external_data_source_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS external_data_source_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.canonical_vehicles.external_data_source_name IS
    'Provider named by the latest licensed enrichment receipt; not a claim that the provider supplied every current vehicle field.';
COMMENT ON COLUMN public.canonical_vehicles.external_data_source_url IS
    'Credential-free source locator for the latest licensed vehicle enrichment.';
COMMENT ON COLUMN public.canonical_vehicles.external_data_source_location IS
    'Geographic or registry scope represented by the latest external source.';
COMMENT ON COLUMN public.canonical_vehicles.external_data_source_checked_at IS
    'Time the latest licensed external source was retrieved.';
COMMENT ON COLUMN public.canonical_vehicles.external_data_source_meta IS
    'Minimized source metadata. Raw provider responses and credentials are never stored.';

CREATE TABLE public.vehicle_data_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_vehicle_id uuid NOT NULL
        REFERENCES public.canonical_vehicles(id) ON DELETE CASCADE,
    client_request_id uuid NOT NULL,
    source_name text NOT NULL,
    source_url text NOT NULL,
    source_location text NOT NULL,
    source_terms_url text NOT NULL,
    storage_authorization_reference text NOT NULL,
    source_key text NOT NULL,
    normalized_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    response_sha256 text NOT NULL,
    retrieved_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT vehicle_data_sources_client_request_key UNIQUE (client_request_id),
    CONSTRAINT vehicle_data_sources_source_name_check
        CHECK (source_name IN ('CarJam Developer Connection API')),
    CONSTRAINT vehicle_data_sources_source_url_check
        CHECK (
            source_url =
                'https://www.carjam.co.nz/api/car/?plate='
                || source_key
                || '&basic=1&f=json'
        ),
    CONSTRAINT vehicle_data_sources_source_location_check
        CHECK (length(btrim(source_location)) BETWEEN 2 AND 200),
    CONSTRAINT vehicle_data_sources_terms_url_check
        CHECK (source_terms_url = 'https://www.carjam.co.nz/cms:page?t=api-terms-and-conditions'),
    CONSTRAINT vehicle_data_sources_authorization_check
        CHECK (
            length(btrim(storage_authorization_reference)) BETWEEN 3 AND 200
            AND storage_authorization_reference !~ E'[\r\n]'
        ),
    CONSTRAINT vehicle_data_sources_source_key_check
        CHECK (source_key = upper(source_key) AND source_key ~ '^[A-Z0-9]{1,10}$'),
    CONSTRAINT vehicle_data_sources_response_sha256_check
        CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT vehicle_data_sources_normalized_payload_object_check
        CHECK (jsonb_typeof(normalized_payload) = 'object')
);

CREATE INDEX idx_vehicle_data_sources_vehicle_time
    ON public.vehicle_data_sources (canonical_vehicle_id, retrieved_at DESC);

ALTER TABLE public.vehicle_data_sources ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.vehicle_data_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.vehicle_data_sources TO service_role;

COMMENT ON TABLE public.vehicle_data_sources IS
    'Minimized, source-attributed vehicle enrichment receipts. CarJam rows require a written storage-authorization reference; raw responses, API keys, ownership and personal information are prohibited.';
COMMENT ON COLUMN public.vehicle_data_sources.source_url IS
    'Exact credential-free provider endpoint and plate query used for retrieval.';
COMMENT ON COLUMN public.vehicle_data_sources.source_location IS
    'Provider and geographic registry scope, shown with the canonical vehicle.';
COMMENT ON COLUMN public.vehicle_data_sources.storage_authorization_reference IS
    'Non-secret reference to CarJam written consent permitting automated storage.';
COMMENT ON COLUMN public.vehicle_data_sources.normalized_payload IS
    'Only the normalized non-personal attributes promoted to the canonical record.';
COMMENT ON COLUMN public.vehicle_data_sources.response_sha256 IS
    'SHA-256 digest of the provider response; the raw response is not retained.';

CREATE OR REPLACE VIEW public.canonical_vehicle_public AS
SELECT id,
       plate_number,
       make,
       model,
       year,
       colour,
       body_type,
       fuel_type,
       rego_status,
       rego_expiry,
       wof_status,
       wof_expiry,
       cof_status,
       cof_expiry,
       homeless_status,
       last_seen_at,
       created_at,
       updated_at,
       external_data_source_name,
       external_data_source_url,
       external_data_source_location,
       external_data_source_checked_at
FROM public.canonical_vehicles;

COMMENT ON VIEW public.canonical_vehicle_public IS
    'Platform-wide Tier 0 plate attributes and credential-free source attribution. Excludes owner identity, welfare notes, provider payload metadata and authorization references.';
REVOKE ALL ON public.canonical_vehicle_public FROM PUBLIC, anon;
GRANT SELECT ON public.canonical_vehicle_public TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_carjam_vehicle_enrichment(
    p_client_request_id uuid,
    p_canonical_vehicle_id uuid,
    p_plate text,
    p_make text,
    p_model text,
    p_year integer,
    p_colour text,
    p_body_type text,
    p_fuel_type text,
    p_source_url text,
    p_source_location text,
    p_source_terms_url text,
    p_storage_authorization_reference text,
    p_response_sha256 text,
    p_retrieved_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
    v_vehicle public.canonical_vehicles%ROWTYPE;
    v_existing public.vehicle_data_sources%ROWTYPE;
    v_plate text := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
    v_payload jsonb;
BEGIN
    IF p_client_request_id IS NULL THEN
        RAISE EXCEPTION 'client request id is required';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('carjam-vehicle:' || p_client_request_id::text, 0));

    SELECT *
      INTO v_existing
      FROM public.vehicle_data_sources
     WHERE client_request_id = p_client_request_id;

    IF FOUND THEN
        IF v_existing.canonical_vehicle_id <> p_canonical_vehicle_id
           OR v_existing.source_key <> v_plate THEN
            RAISE EXCEPTION 'client request id has already been used for a different vehicle';
        END IF;

        SELECT *
          INTO v_vehicle
          FROM public.canonical_vehicles
         WHERE id = p_canonical_vehicle_id;

        RETURN jsonb_build_object(
            'replayed', true,
            'receipt_id', v_existing.id,
            'vehicle', jsonb_build_object(
                'id', v_vehicle.id,
                'plate_number', v_vehicle.plate_number,
                'make', v_vehicle.make,
                'model', v_vehicle.model,
                'year', v_vehicle.year,
                'colour', v_vehicle.colour,
                'body_type', v_vehicle.body_type,
                'fuel_type', v_vehicle.fuel_type,
                'external_data_source_name', v_vehicle.external_data_source_name,
                'external_data_source_url', v_vehicle.external_data_source_url,
                'external_data_source_location', v_vehicle.external_data_source_location,
                'external_data_source_checked_at', v_vehicle.external_data_source_checked_at
            )
        );
    END IF;

    IF v_plate = '' OR v_plate !~ '^[A-Z0-9]{1,10}$' THEN
        RAISE EXCEPTION 'valid plate is required';
    END IF;
    IF p_year IS NOT NULL
       AND (p_year < 1886 OR p_year > extract(year FROM current_date)::integer + 1) THEN
        RAISE EXCEPTION 'vehicle year is outside the supported range';
    END IF;
    IF p_source_url IS NULL
       OR p_source_url IS DISTINCT FROM
          'https://www.carjam.co.nz/api/car/?plate='
          || v_plate
          || '&basic=1&f=json' THEN
        RAISE EXCEPTION 'credential-free CarJam API source URL is required';
    END IF;
    IF p_source_terms_url IS DISTINCT FROM
       'https://www.carjam.co.nz/cms:page?t=api-terms-and-conditions' THEN
        RAISE EXCEPTION 'CarJam API terms URL is required';
    END IF;
    IF length(btrim(coalesce(p_storage_authorization_reference, ''))) < 3 THEN
        RAISE EXCEPTION 'CarJam written storage authorization reference is required';
    END IF;
    IF p_response_sha256 IS NULL OR p_response_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'valid response digest is required';
    END IF;
    IF p_retrieved_at IS NULL OR p_retrieved_at > clock_timestamp() + interval '5 minutes' THEN
        RAISE EXCEPTION 'valid retrieval timestamp is required';
    END IF;

    SELECT *
      INTO v_vehicle
      FROM public.canonical_vehicles
     WHERE id = p_canonical_vehicle_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'canonical vehicle not found';
    END IF;
    IF upper(regexp_replace(coalesce(v_vehicle.plate_number, ''), '[^A-Za-z0-9]', '', 'g'))
       IS DISTINCT FROM v_plate THEN
        RAISE EXCEPTION 'plate does not match canonical vehicle';
    END IF;

    v_payload := jsonb_strip_nulls(jsonb_build_object(
        'plate', v_plate,
        'make', nullif(btrim(p_make), ''),
        'model', nullif(btrim(p_model), ''),
        'year', p_year,
        'colour', nullif(btrim(p_colour), ''),
        'body_type', nullif(btrim(p_body_type), ''),
        'fuel_type', nullif(btrim(p_fuel_type), '')
    ));

    UPDATE public.canonical_vehicles
       SET make = coalesce(make, nullif(btrim(p_make), '')),
           model = coalesce(model, nullif(btrim(p_model), '')),
           year = coalesce(year, p_year),
           colour = coalesce(colour, nullif(btrim(p_colour), '')),
           body_type = coalesce(body_type, nullif(btrim(p_body_type), '')),
           fuel_type = coalesce(fuel_type, nullif(btrim(p_fuel_type), '')),
           external_data_source_name = CASE
               WHEN external_data_source_checked_at IS NULL
                    OR external_data_source_checked_at <= p_retrieved_at
               THEN 'CarJam Developer Connection API'
               ELSE external_data_source_name
           END,
           external_data_source_url = CASE
               WHEN external_data_source_checked_at IS NULL
                    OR external_data_source_checked_at <= p_retrieved_at
               THEN p_source_url
               ELSE external_data_source_url
           END,
           external_data_source_location = CASE
               WHEN external_data_source_checked_at IS NULL
                    OR external_data_source_checked_at <= p_retrieved_at
               THEN p_source_location
               ELSE external_data_source_location
           END,
           external_data_source_checked_at = CASE
               WHEN external_data_source_checked_at IS NULL
                    OR external_data_source_checked_at <= p_retrieved_at
               THEN p_retrieved_at
               ELSE external_data_source_checked_at
           END,
           external_data_source_meta = CASE
               WHEN external_data_source_checked_at IS NULL
                    OR external_data_source_checked_at <= p_retrieved_at
               THEN jsonb_build_object(
                   'terms_url', p_source_terms_url,
                   'response_sha256', p_response_sha256
               )
               ELSE external_data_source_meta
           END,
           updated_at = clock_timestamp()
     WHERE id = p_canonical_vehicle_id
     RETURNING * INTO v_vehicle;

    INSERT INTO public.vehicle_data_sources (
        canonical_vehicle_id,
        client_request_id,
        source_name,
        source_url,
        source_location,
        source_terms_url,
        storage_authorization_reference,
        source_key,
        normalized_payload,
        response_sha256,
        retrieved_at
    ) VALUES (
        p_canonical_vehicle_id,
        p_client_request_id,
        'CarJam Developer Connection API',
        p_source_url,
        p_source_location,
        p_source_terms_url,
        p_storage_authorization_reference,
        v_plate,
        v_payload,
        p_response_sha256,
        p_retrieved_at
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object(
        'replayed', false,
        'receipt_id', v_existing.id,
        'vehicle', jsonb_build_object(
            'id', v_vehicle.id,
            'plate_number', v_vehicle.plate_number,
            'make', v_vehicle.make,
            'model', v_vehicle.model,
            'year', v_vehicle.year,
            'colour', v_vehicle.colour,
            'body_type', v_vehicle.body_type,
            'fuel_type', v_vehicle.fuel_type,
            'external_data_source_name', v_vehicle.external_data_source_name,
            'external_data_source_url', v_vehicle.external_data_source_url,
            'external_data_source_location', v_vehicle.external_data_source_location,
            'external_data_source_checked_at', v_vehicle.external_data_source_checked_at
        )
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_carjam_vehicle_enrichment(
    uuid, uuid, text, text, text, integer, text, text, text,
    text, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_carjam_vehicle_enrichment(
    uuid, uuid, text, text, text, integer, text, text, text,
    text, text, text, text, text, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.record_carjam_vehicle_enrichment(
    uuid, uuid, text, text, text, integer, text, text, text,
    text, text, text, text, text, timestamptz
) IS 'Atomic, service-role-only CarJam enrichment receipt. Requires an existing canonical vehicle, exact plate match, credential-free source URL, response digest and written storage authorization reference. Older concurrent receipts remain in history but cannot replace the canonical latest-source attribution.';