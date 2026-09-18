-- 20260917090000_fuel_source_url_origin_validation.sql
-- Harden the approved-source observation boundary. A string prefix alone would
-- accept https://fuel.example.test.evil for base https://fuel.example.test.
-- Require the same URL origin and a real path/query/fragment boundary.

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
  v_base text;
  v_base_origin text;
  v_url_origin text;
  v_next_char text;
begin
  select * into v_source from public.fuel_price_sources where id = p_source_id and organization_id = p_organization_id and active;
  if not found then raise exception 'Choose an active approved fuel price source'; end if;
  v_base := trim(trailing '/' from v_source.source_url);
  if v_url is null or v_url !~ '^https?://' or v_base !~ '^https?://' then
    raise exception 'Observation URL must be a public http(s) URL';
  end if;
  v_base_origin := lower(regexp_replace(v_base, '^https?://([^/]+).*$','\1'));
  v_url_origin := lower(regexp_replace(v_url, '^https?://([^/]+).*$','\1'));
  v_next_char := substr(v_url, length(v_base) + 1, 1);
  if v_url_origin <> v_base_origin or not (v_url = v_base or v_next_char in ('/', '?', '#')) then
    raise exception 'Observation URL must be under the approved source URL';
  end if;
  v_row := public.record_fuel_price_observation(p_client_request_id, p_organization_id, v_source.fuel_type, p_observed_on, p_price_per_litre, v_source.name, v_url, p_source_published_at, p_source_reference, p_source_hash);
  update public.fuel_price_observations set source_id = v_source.id where id = v_row.id returning * into v_row;
  return v_row;
end;
$function$;
