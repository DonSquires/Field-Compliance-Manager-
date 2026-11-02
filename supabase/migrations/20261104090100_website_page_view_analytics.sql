-- First-party website analytics stores daily aggregates only. It never writes a
-- visitor-level event, identifier, raw address or user-agent value.

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.website_page_views_daily (
  provider_organization_id uuid NOT NULL REFERENCES public.organizations(id),
  viewed_on date NOT NULL,
  page_path text NOT NULL,
  country_code text NOT NULL DEFAULT 'ZZ',
  region_code text NOT NULL DEFAULT 'ZZ',
  page_views bigint NOT NULL DEFAULT 1,
  CONSTRAINT website_page_views_daily_pkey
    PRIMARY KEY (provider_organization_id, viewed_on, page_path, country_code, region_code),
  CONSTRAINT website_page_views_daily_path_check
    CHECK (page_path ~ '^/(about|contact|gallery|privacy|services(/[a-z0-9-]+)?|blog(/[a-z0-9-]+)?)?$'),
  CONSTRAINT website_page_views_daily_country_check
    CHECK (country_code = 'ZZ' OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT website_page_views_daily_region_check
    CHECK (region_code = 'ZZ' OR region_code ~ '^[A-Z0-9-]{1,15}$'),
  CONSTRAINT website_page_views_daily_count_check
    CHECK (page_views > 0)
);

COMMENT ON TABLE public.website_page_views_daily IS
  'Daily first-party R&M website page-view aggregates by page and approximate country/region. No visitor-level records, unique visitor IDs, raw IP addresses or user-agent values.';
COMMENT ON COLUMN public.website_page_views_daily.viewed_on IS
  'UTC calendar date; individual request timestamps are not stored.';
COMMENT ON COLUMN public.website_page_views_daily.country_code IS
  'Approximate country code from Vercel geolocation headers; ZZ means unavailable.';
COMMENT ON COLUMN public.website_page_views_daily.region_code IS
  'Approximate region code from Vercel geolocation headers; ZZ means unavailable.';

ALTER TABLE public.retention_policies
  DROP CONSTRAINT IF EXISTS retention_policies_category_check;
ALTER TABLE public.retention_policies
  ADD CONSTRAINT retention_policies_category_check CHECK (
    category IN (
      'infringement',
      'non_infringement',
      'hold_default',
      'interaction_permanent',
      'observation_30_day',
      'canonical_indefinite',
      'legal_hold',
      'website_analytics'
    )
  );

INSERT INTO public.retention_policies (
  organization_id,
  module_key,
  category,
  retention_days,
  is_permanent,
  legal_basis
)
SELECT
  t.service_provider_organization_id,
  'website',
  'website_analytics',
  365,
  false,
  'Owner ruling 2026-11-02: website page-view aggregates may be retained for 12 months; represented as a maximum of 365 days.'
FROM private.platform_tenancy AS t
WHERE t.singleton
  AND t.service_provider_organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM public.retention_policies AS rp
     WHERE rp.organization_id = t.service_provider_organization_id
       AND rp.module_key = 'website'
       AND rp.category = 'website_analytics'
       AND rp.is_active
  );

CREATE INDEX website_page_views_daily_provider_date_idx
  ON public.website_page_views_daily (provider_organization_id, viewed_on DESC);

ALTER TABLE public.website_page_views_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.website_page_views_daily FROM PUBLIC, anon, authenticated, service_role;

CREATE POLICY website_page_views_daily_select_provider_admins
  ON public.website_page_views_daily
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_grand_master())
    OR (SELECT public.is_admin_for_org(provider_organization_id))
  );

CREATE TABLE private.website_analytics_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  approved_notice_version text,
  CONSTRAINT website_analytics_notice_required_when_enabled
    CHECK (NOT enabled OR nullif(btrim(approved_notice_version), '') IS NOT NULL),
  CONSTRAINT website_analytics_notice_version_format
    CHECK (approved_notice_version IS NULL OR approved_notice_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')
);

COMMENT ON TABLE private.website_analytics_settings IS
  'Private fail-closed control for first-party website analytics. Keep disabled until a separate notice is issued and its exact version is approved.';

INSERT INTO private.website_analytics_settings (singleton, enabled, approved_notice_version)
VALUES (true, false, NULL)
ON CONFLICT (singleton) DO NOTHING;

REVOKE ALL ON TABLE private.website_analytics_settings FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_website_page_view(
  p_page_path text,
  p_country_code text,
  p_region_code text,
  p_notice_version text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_settings private.website_analytics_settings%ROWTYPE;
  v_provider uuid;
  v_page_path text := btrim(coalesce(p_page_path, ''));
  v_country text := upper(coalesce(nullif(btrim(p_country_code), ''), 'ZZ'));
  v_region text := upper(coalesce(nullif(btrim(p_region_code), ''), 'ZZ'));
BEGIN
  IF char_length(v_page_path) > 160
     OR v_page_path !~ '^/(about|contact|gallery|privacy|services(/[a-z0-9-]+)?|blog(/[a-z0-9-]+)?)?$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_analytics_invalid:page_path';
  END IF;
  IF v_country <> 'ZZ' AND v_country !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_analytics_invalid:country';
  END IF;
  IF v_region <> 'ZZ' AND v_region !~ '^[A-Z0-9-]{1,15}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_analytics_invalid:region';
  END IF;
  IF v_country = 'ZZ' THEN
    v_region := 'ZZ';
  END IF;
  IF p_notice_version IS NULL OR p_notice_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_analytics_invalid:notice_version';
  END IF;

  SELECT s.*
    INTO v_settings
    FROM private.website_analytics_settings AS s
   WHERE s.singleton;

  IF NOT FOUND
     OR NOT v_settings.enabled
     OR v_settings.approved_notice_version IS DISTINCT FROM p_notice_version THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'website_analytics_not_enabled';
  END IF;

  SELECT t.service_provider_organization_id
    INTO v_provider
    FROM private.platform_tenancy AS t
   WHERE t.singleton;

  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'Single-provider tenancy is not configured';
  END IF;

  INSERT INTO public.website_page_views_daily (
    provider_organization_id,
    viewed_on,
    page_path,
    country_code,
    region_code,
    page_views
  )
  VALUES (
    v_provider,
    (pg_catalog.timezone('UTC', pg_catalog.now()))::date,
    v_page_path,
    v_country,
    v_region,
    1
  )
  ON CONFLICT (provider_organization_id, viewed_on, page_path, country_code, region_code)
  DO UPDATE SET page_views = public.website_page_views_daily.page_views + 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_website_page_view(text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_website_page_view(text, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_website_page_view_summary(
  p_from date,
  p_to date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_provider uuid;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 89 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_analytics_invalid:date_range';
  END IF;

  SELECT t.service_provider_organization_id
    INTO v_provider
    FROM private.platform_tenancy AS t
   WHERE t.singleton;

  IF auth.uid() IS NULL
     OR v_provider IS NULL
     OR NOT (public.is_grand_master() OR public.is_admin_for_org(v_provider)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'website_analytics_access_denied';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'total_page_views',
    coalesce((
      SELECT sum(v.page_views)
        FROM public.website_page_views_daily AS v
       WHERE v.provider_organization_id = v_provider
         AND v.viewed_on BETWEEN p_from AND p_to
    ), 0),
    'daily',
    coalesce((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('viewed_on', daily.viewed_on, 'page_views', daily.page_views)
        ORDER BY daily.viewed_on
      )
        FROM (
          SELECT v.viewed_on, sum(v.page_views) AS page_views
            FROM public.website_page_views_daily AS v
           WHERE v.provider_organization_id = v_provider
             AND v.viewed_on BETWEEN p_from AND p_to
           GROUP BY v.viewed_on
        ) AS daily
    ), '[]'::jsonb),
    'pages',
    coalesce((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('page_path', pages.page_path, 'page_views', pages.page_views)
        ORDER BY pages.page_views DESC, pages.page_path
      )
        FROM (
          SELECT v.page_path, sum(v.page_views) AS page_views
            FROM public.website_page_views_daily AS v
           WHERE v.provider_organization_id = v_provider
             AND v.viewed_on BETWEEN p_from AND p_to
           GROUP BY v.page_path
        ) AS pages
    ), '[]'::jsonb),
    'regions',
    coalesce((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'country_code', regions.country_code,
          'region_code', regions.region_code,
          'page_views', regions.page_views
        )
        ORDER BY regions.page_views DESC, regions.country_code, regions.region_code
      )
        FROM (
          SELECT v.country_code, v.region_code, sum(v.page_views) AS page_views
            FROM public.website_page_views_daily AS v
           WHERE v.provider_organization_id = v_provider
             AND v.viewed_on BETWEEN p_from AND p_to
             AND v.country_code <> 'ZZ'
             AND v.region_code <> 'ZZ'
           GROUP BY v.country_code, v.region_code
          HAVING sum(v.page_views) >= 5
        ) AS regions
    ), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_website_page_view_summary(date, date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_website_page_view_summary(date, date)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.purge_website_page_views_daily()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_retention_days integer;
  v_deleted bigint;
BEGIN
  SELECT rp.retention_days
    INTO v_retention_days
    FROM private.platform_tenancy AS t
    JOIN public.retention_policies AS rp
      ON rp.organization_id = t.service_provider_organization_id
   WHERE t.singleton
     AND rp.module_key = 'website'
     AND rp.category = 'website_analytics'
     AND rp.is_active
     AND NOT rp.is_permanent
   ORDER BY rp.effective_from DESC
   LIMIT 1;

  IF NOT FOUND OR v_retention_days IS NULL OR v_retention_days <= 0 THEN
    RAISE EXCEPTION 'Website analytics retention configuration is unavailable';
  END IF;

  DELETE FROM public.website_page_views_daily AS v
   WHERE v.viewed_on <= ((pg_catalog.timezone('UTC', pg_catalog.now()))::date - v_retention_days);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION private.purge_website_page_views_daily()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.purge_website_page_views_daily()
  TO postgres;

DO $schedule$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT j.jobid
    INTO v_job_id
    FROM cron.job AS j
   WHERE j.jobname = 'website-page-views-retention-daily'
   LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule_in_database(
    'website-page-views-retention-daily',
    '17 3 * * *',
    'select private.purge_website_page_views_daily();',
    'postgres',
    NULL,
    TRUE
  );
END;
$schedule$;