-- 20260917080000_approved_fuel_price_sources.sql
-- Governed source register for website-backed fuel pricing. A finance admin
-- approves a public source once; later observations may reference it and must
-- use a URL under its approved base URL. Existing cited observations remain
-- valid historical evidence and are not retroactively blocked.

CREATE TABLE IF NOT EXISTS public.fuel_price_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_url text NOT NULL,
  fuel_type text NOT NULL CHECK (fuel_type IN ('petrol', 'diesel', 'lpg', 'other')),
  refresh_guidance text,
  active boolean NOT NULL DEFAULT true,
  approved_by uuid REFERENCES public.user_profiles(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fuel_type, source_url)
);

ALTER TABLE public.fuel_price_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fuel_price_sources FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.fuel_price_sources TO authenticated;
GRANT ALL ON public.fuel_price_sources TO service_role;
CREATE POLICY fuel_price_sources_select ON public.fuel_price_sources FOR SELECT TO authenticated USING (org_access_allowed(organization_id));
CREATE POLICY bob_full_read ON public.fuel_price_sources FOR SELECT TO authenticated USING ((SELECT auth.uid()) = '00000000-0000-0000-0000-00000000b0b0'::uuid);

ALTER TABLE public.fuel_price_observations ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES public.fuel_price_sources(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_fuel_price_observations_source ON public.fuel_price_observations (source_id) WHERE source_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.manage_fuel_price_source(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_action text,
  p_source_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_source_url text DEFAULT NULL,
  p_fuel_type text DEFAULT 'petrol',
  p_refresh_guidance text DEFAULT NULL
) RETURNS fuel_price_sources
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_source public.fuel_price_sources%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_url text := nullif(trim(coalesce(p_source_url, '')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if v_actor is null or not public.is_admin_for_org(p_organization_id) then raise exception 'Active organisation administrator required'; end if;
  if p_action = 'approve' then
    if v_name is null or v_url is null or v_url !~ '^https?://' then raise exception 'Source name and a public http(s) URL are required'; end if;
    if p_fuel_type not in ('petrol', 'diesel', 'lpg', 'other') then raise exception 'Unsupported fuel type'; end if;
    insert into public.fuel_price_sources (organization_id, name, source_url, fuel_type, refresh_guidance, approved_by)
    values (p_organization_id, v_name, v_url, p_fuel_type, nullif(trim(coalesce(p_refresh_guidance, '')), ''), v_actor)
    on conflict (organization_id, fuel_type, source_url) do update set name = excluded.name, refresh_guidance = excluded.refresh_guidance, active = true, retired_at = null, approved_by = v_actor, approved_at = now(), updated_at = now()
    returning * into v_source;
  elsif p_action = 'retire' then
    update public.fuel_price_sources set active = false, retired_at = now(), updated_at = now() where id = p_source_id and organization_id = p_organization_id and active returning * into v_source;
    if not found then raise exception 'Active fuel price source not found'; end if;
  else
    raise exception 'Action must be approve or retire';
  end if;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'fuel_price_source_' || p_action || 'd', 'fuel_price_sources', v_source.id,
          jsonb_build_object('name', v_source.name, 'source_url', v_source.source_url, 'fuel_type', v_source.fuel_type, 'client_request_id', p_client_request_id));
  return v_source;
end;
$function$;
REVOKE ALL ON FUNCTION public.manage_fuel_price_source(uuid, uuid, text, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_fuel_price_source(uuid, uuid, text, uuid, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_approved_fuel_price_observation(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_source_id uuid,
  p_observed_on date,
  p_price_per_litre numeric,
  p_source_url text,
  p_source_published_at timestamptz DEFAULT NULL,
  p_source_reference text DEFAULT NULL,
  p_source_hash text DEFAULT NULL
) RETURNS fuel_price_observations
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_source public.fuel_price_sources%rowtype;
  v_row public.fuel_price_observations%rowtype;
  v_url text := nullif(trim(coalesce(p_source_url, '')), '');
begin
  select * into v_source from public.fuel_price_sources where id = p_source_id and organization_id = p_organization_id and active;
  if not found then raise exception 'Choose an active approved fuel price source'; end if;
  if v_url is null or v_url not like trim(trailing '/' from v_source.source_url) || '%' then
    raise exception 'Observation URL must be under the approved source URL';
  end if;
  v_row := public.record_fuel_price_observation(p_client_request_id, p_organization_id, v_source.fuel_type, p_observed_on, p_price_per_litre, v_source.name, v_url, p_source_published_at, p_source_reference, p_source_hash);
  update public.fuel_price_observations set source_id = v_source.id where id = v_row.id returning * into v_row;
  return v_row;
end;
$function$;
REVOKE ALL ON FUNCTION public.record_approved_fuel_price_observation(uuid, uuid, uuid, date, numeric, text, timestamptz, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_approved_fuel_price_observation(uuid, uuid, uuid, date, numeric, text, timestamptz, text, text) TO authenticated;
