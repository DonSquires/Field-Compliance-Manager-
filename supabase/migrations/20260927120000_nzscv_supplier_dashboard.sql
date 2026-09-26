-- Read-only NZSCV supplier transparency dashboard.
-- The supplier sees its public register data and aggregate Freedom Camping usage only.

CREATE OR REPLACE FUNCTION public.get_nzscv_supplier_dashboard(
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_search text := upper(regexp_replace(coalesce(p_search, ''), '[^A-Za-z0-9]', '', 'g'));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT profile.role INTO v_role
  FROM public.user_profiles profile
  WHERE profile.id = v_actor AND profile.deactivated_at IS NULL;

  IF v_role NOT IN ('nzscv_monitor', 'grand_master') THEN
    RAISE EXCEPTION 'NZSCV supplier access required';
  END IF;

  RETURN jsonb_build_object(
    'summary', (
      SELECT jsonb_build_object(
        'registry_total', count(*),
        'active', count(*) FILTER (WHERE register.certificate_status = 'active'),
        'expired', count(*) FILTER (WHERE register.certificate_status = 'expired'),
        'suspended', count(*) FILTER (WHERE register.certificate_status = 'suspended'),
        'cancelled', count(*) FILTER (WHERE register.certificate_status = 'cancelled'),
        'expiring_90_days', count(*) FILTER (WHERE register.certificate_status = 'active' AND register.expiry_date BETWEEN current_date AND current_date + 90),
        'last_registry_update', max(register.updated_at),
        'freedom_camping_lookups_30_days', (
          SELECT count(*) FROM public.observations observation
          WHERE observation.module_key = 'freedom_camping'
            AND observation.canonical_scv_id IS NOT NULL
            AND observation.observed_at >= clock_timestamp() - interval '30 days'
        ),
        'freedom_camping_lookups_total', (
          SELECT count(*) FROM public.observations observation
          WHERE observation.module_key = 'freedom_camping'
            AND observation.canonical_scv_id IS NOT NULL
        )
      )
      FROM public.canonical_scv register
    ),
    'daily_usage', (
      WITH days AS (
        SELECT generate_series(current_date - 29, current_date, interval '1 day')::date AS day
      ), usage AS (
        SELECT observation.observed_at::date AS day, count(*) AS lookups
        FROM public.observations observation
        WHERE observation.module_key = 'freedom_camping'
          AND observation.canonical_scv_id IS NOT NULL
          AND observation.observed_at >= current_date - 29
        GROUP BY observation.observed_at::date
      )
      SELECT coalesce(jsonb_agg(jsonb_build_object('date', days.day, 'lookups', coalesce(usage.lookups, 0)) ORDER BY days.day), '[]'::jsonb)
      FROM days LEFT JOIN usage USING (day)
    ),
    'imports', (
      SELECT coalesce(jsonb_agg(to_jsonb(history) ORDER BY history.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT batch.id, batch.source_name, batch.status, batch.total_rows, batch.valid_rows,
          batch.inserted_rows, batch.updated_rows, batch.skipped_rows, batch.invalid_rows,
          batch.started_at, batch.completed_at, batch.created_at
        FROM public.scv_import_batches batch
        ORDER BY batch.created_at DESC
        LIMIT 12
      ) history
    ),
    'records', (
      SELECT coalesce(jsonb_agg(to_jsonb(record) ORDER BY record.plate_number), '[]'::jsonb)
      FROM (
        SELECT register.id, register.plate_number, register.certificate_number,
          register.certificate_status, register.issued_date, register.expiry_date
        FROM public.canonical_scv_public register
        WHERE v_search = '' OR register.plate_number LIKE '%' || v_search || '%'
          OR upper(coalesce(register.certificate_number, '')) LIKE '%' || v_search || '%'
        ORDER BY register.plate_number
        LIMIT v_limit OFFSET v_offset
      ) record
    ),
    'page', jsonb_build_object('limit', v_limit, 'offset', v_offset, 'search', v_search),
    'privacy', jsonb_build_object(
      'usage_is_aggregate', true,
      'tenant_details_included', false,
      'officer_details_included', false,
      'incident_details_included', false,
      'raw_source_rows_included', false
    )
  );
END;
$$;

COMMENT ON FUNCTION public.get_nzscv_supplier_dashboard(text, integer, integer) IS
  'Read-only NZSCV supplier view: public register fields plus aggregate Freedom Camping lookup and import health. No tenant, officer, incident, or raw-source detail.';

REVOKE ALL ON FUNCTION public.get_nzscv_supplier_dashboard(text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_nzscv_supplier_dashboard(text, integer, integer) TO authenticated, service_role;
