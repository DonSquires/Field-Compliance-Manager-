-- 20260917070000_fuel_price_observations_median.sql
-- Website-backed fuel observations are kept as provenance-bearing inputs. The
-- resolver uses the median of observations in the trailing three calendar
-- months; it never overwrites the IRD kilometre-rate charge rule.

CREATE TABLE IF NOT EXISTS public.fuel_price_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  fuel_type text NOT NULL CHECK (fuel_type IN ('petrol', 'diesel', 'lpg', 'other')),
  observed_on date NOT NULL,
  price_per_litre numeric(10,4) NOT NULL CHECK (price_per_litre > 0),
  source_name text NOT NULL,
  source_url text NOT NULL,
  source_published_at timestamptz,
  source_reference text,
  source_hash text,
  created_by uuid REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fuel_type, observed_on, source_url, source_reference)
);

CREATE INDEX IF NOT EXISTS idx_fuel_price_observations_window
  ON public.fuel_price_observations (organization_id, fuel_type, observed_on DESC);

ALTER TABLE public.fuel_price_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fuel_price_observations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.fuel_price_observations TO authenticated;
GRANT ALL ON public.fuel_price_observations TO service_role;
DROP POLICY IF EXISTS fuel_price_observations_select ON public.fuel_price_observations;
CREATE POLICY fuel_price_observations_select ON public.fuel_price_observations
  FOR SELECT TO authenticated USING (org_access_allowed(organization_id));
DROP POLICY IF EXISTS bob_full_read ON public.fuel_price_observations;
CREATE POLICY bob_full_read ON public.fuel_price_observations
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = '00000000-0000-0000-0000-00000000b0b0'::uuid);

CREATE OR REPLACE FUNCTION public.record_fuel_price_observation(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_fuel_type text,
  p_observed_on date,
  p_price_per_litre numeric,
  p_source_name text,
  p_source_url text,
  p_source_published_at timestamptz DEFAULT NULL,
  p_source_reference text DEFAULT NULL,
  p_source_hash text DEFAULT NULL
) RETURNS fuel_price_observations
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.fuel_price_observations%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if v_actor is null or not public.is_admin_for_org(p_organization_id) then raise exception 'Active organisation administrator required'; end if;
  if p_fuel_type not in ('petrol', 'diesel', 'lpg', 'other') then raise exception 'Unsupported fuel type'; end if;
  if p_observed_on is null or p_price_per_litre is null or p_price_per_litre <= 0 then raise exception 'Observed date and positive price are required'; end if;
  if nullif(trim(coalesce(p_source_name, '')), '') is null or nullif(trim(coalesce(p_source_url, '')), '') is null then raise exception 'Source name and URL are required'; end if;
  select * into v_row from public.fuel_price_observations where organization_id = p_organization_id and source_reference = p_client_request_id::text;
  if found then return v_row; end if;
  insert into public.fuel_price_observations (organization_id, fuel_type, observed_on, price_per_litre, source_name, source_url, source_published_at, source_reference, source_hash, created_by)
  values (p_organization_id, p_fuel_type, p_observed_on, p_price_per_litre, trim(p_source_name), trim(p_source_url), p_source_published_at, coalesce(nullif(trim(p_source_reference), ''), p_client_request_id::text), nullif(trim(p_source_hash), ''), v_actor)
  on conflict (organization_id, fuel_type, observed_on, source_url, source_reference) do update
    set price_per_litre = excluded.price_per_litre, source_published_at = excluded.source_published_at, source_hash = excluded.source_hash
  returning * into v_row;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'fuel_price_observation_recorded', 'fuel_price_observations', v_row.id,
          jsonb_build_object('fuel_type', v_row.fuel_type, 'observed_on', v_row.observed_on, 'price_per_litre', v_row.price_per_litre, 'source_name', v_row.source_name, 'source_url', v_row.source_url));
  return v_row;
end;
$function$;
REVOKE ALL ON FUNCTION public.record_fuel_price_observation(uuid, uuid, text, date, numeric, text, text, timestamptz, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_fuel_price_observation(uuid, uuid, text, date, numeric, text, text, timestamptz, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_median_fuel_price(
  p_organization_id uuid,
  p_fuel_type text,
  p_as_at date DEFAULT CURRENT_DATE,
  p_months integer DEFAULT 3
) RETURNS TABLE(fuel_type text, median_price_per_litre numeric, observation_count bigint, window_start date, window_end date, latest_observed_on date, source_names text[], source_urls text[])
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with bounds as (
    select (coalesce(p_as_at, current_date) - make_interval(months => greatest(coalesce(p_months, 3), 1)))::date as start_on,
           coalesce(p_as_at, current_date)::date as end_on
  ), rows as (
    select o.* from public.fuel_price_observations o, bounds b
    where o.organization_id = p_organization_id and o.fuel_type = p_fuel_type
      and o.observed_on >= b.start_on and o.observed_on <= b.end_on
  )
  select p_fuel_type,
         percentile_cont(0.5) within group (order by r.price_per_litre)::numeric,
         count(*)::bigint,
         (select start_on from bounds), (select end_on from bounds), max(r.observed_on),
         array_agg(distinct r.source_name order by r.source_name),
         array_agg(distinct r.source_url order by r.source_url)
  from rows r
  group by p_fuel_type;
$function$;
REVOKE ALL ON FUNCTION public.get_median_fuel_price(uuid, text, date, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_median_fuel_price(uuid, text, date, integer) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_median_fuel_price(uuid, text, date, integer) IS 'Returns the median website-backed fuel price over the trailing p_months calendar window, with count and source provenance. Does not change IRD per-km charge rules.';
