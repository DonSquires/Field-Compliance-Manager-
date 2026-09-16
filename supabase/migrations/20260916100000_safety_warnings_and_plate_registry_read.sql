-- Platform-wide safety warnings (owner ruling 2026-09-15, ORG_SERVICE_MODEL.md § "The one cross-tenant
-- exception: health-and-safety flags") and the plate registry made readable to the people who use it.
--
-- 1. canonical_vehicles / canonical_scv were readable only by Bob (bob_full_read was their sole
--    policy), so the officer vehicle lookup, the admin vehicle search and the observation search
--    returned nothing for every real user (live probe as the R&M master: 0 of 8,975 vehicles
--    visible). Plate attributes are platform-level (Tier 0). Two projections expose them without
--    the personal columns: canonical_vehicle_public (no registered_owner_name, no homeless_notes)
--    and canonical_scv_public. The base tables keep their policies.
-- 2. entity_flags.hazard_class marks a flag as a health-and-safety warning. Flags without a hazard
--    class stay exactly as they were: org-scoped of-interest status (Privacy Act).
-- 3. get_safety_warnings(): any active user, for a vehicle / person / place / site they are about
--    to deal with, sees every organisation's ACTIVE hazard-classed flag with the detail redacted
--    to hazard class, severity, when it was raised, and the raising organisation's name and
--    contact path. The narrative (reason) and who raised it are returned only for the caller's
--    own organisation. Basis: HSWA 2015 s.34 / s.36 with Privacy Act 2020 IPP 11(1)(f).
-- 4. raise_entity_flag() / resolve_entity_flag(): the governed write path (until now flags were
--    only written by Bob's generic upsert or by direct RLS writes). Any active member of an
--    organisation may raise a warning for their organisation; the raiser or an organisation
--    administrator resolves it. Both audited.

-- ---------------------------------------------------------------------------
-- 1. Plate registry projections (Tier 0 columns only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.canonical_vehicle_public AS
SELECT id, plate_number, make, model, year, colour, body_type, fuel_type,
       rego_status, rego_expiry, wof_status, wof_expiry, cof_status, cof_expiry,
       homeless_status, last_seen_at, created_at, updated_at
FROM public.canonical_vehicles;
COMMENT ON VIEW public.canonical_vehicle_public IS 'Platform-wide plate attributes (Tier 0): identity, make/model, rego/WoF/CoF status, and the homeless status signal an officer must know before approaching. Deliberately excludes registered_owner_name and homeless_notes (personal information; governed paths only). Definer view over canonical_vehicles, which stays Bob-only at the table.';
REVOKE ALL ON public.canonical_vehicle_public FROM PUBLIC, anon;
GRANT SELECT ON public.canonical_vehicle_public TO authenticated, service_role;

CREATE OR REPLACE VIEW public.canonical_scv_public AS
SELECT id, plate_number, certificate_number, certificate_status, issued_date, expiry_date
FROM public.canonical_scv;
COMMENT ON VIEW public.canonical_scv_public IS 'Self-containment certificate status per plate (a public register). Definer view over canonical_scv, which stays Bob-only at the table.';
REVOKE ALL ON public.canonical_scv_public FROM PUBLIC, anon;
GRANT SELECT ON public.canonical_scv_public TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Hazard class on entity_flags
-- ---------------------------------------------------------------------------
ALTER TABLE public.entity_flags ADD COLUMN IF NOT EXISTS hazard_class text;
ALTER TABLE public.entity_flags DROP CONSTRAINT IF EXISTS entity_flags_hazard_class_check;
ALTER TABLE public.entity_flags ADD CONSTRAINT entity_flags_hazard_class_check
  CHECK (hazard_class IS NULL OR hazard_class = ANY (ARRAY[
    'violence_or_aggression', 'weapons', 'dangerous_dog', 'hazardous_substances',
    'unsafe_structure_or_ground', 'vehicle_defect', 'medical_or_welfare', 'other'
  ]));
ALTER TABLE public.entity_flags ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.entity_flags ADD COLUMN IF NOT EXISTS client_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_flags_client_request ON public.entity_flags (organization_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_flags_safety ON public.entity_flags (entity_type, entity_id) WHERE active AND hazard_class IS NOT NULL;
COMMENT ON COLUMN public.entity_flags.hazard_class IS 'When set, this flag is a health-and-safety warning and its existence (hazard class, severity, raising organisation contact) is visible platform-wide through get_safety_warnings; the reason stays with the raising organisation. NULL = ordinary org-scoped of-interest flag.';

-- ---------------------------------------------------------------------------
-- 3. Redacted platform-wide read
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_flag_entity(p_entity_type text, p_entity_id uuid, OUT entity_type text, OUT entity_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_entity_type = 'site' then
    -- A site is a facet of its house; the house carries the canonical place (locations.canonical_place_id is NOT NULL),
    -- so warnings live on the place and every organisation working at that address sees them.
    select 'place', l.canonical_place_id into entity_type, entity_id
    from public.client_sites s join public.locations l on l.id = s.location_id where s.id = p_entity_id;
    if entity_id is null then raise exception 'Site is not linked to a place'; end if;
  elsif p_entity_type = 'zone' then
    select 'place', l.canonical_place_id into entity_type, entity_id
    from public.location_zones z join public.locations l on l.id = z.location_id where z.id = p_entity_id;
    if entity_id is null then raise exception 'Zone is not linked to a place'; end if;
  elsif p_entity_type in ('vehicle', 'person', 'place') then
    entity_type := p_entity_type; entity_id := p_entity_id;
  else
    raise exception 'Safety warnings apply to vehicles, people, places, sites and zones';
  end if;
end;
$function$;
REVOKE ALL ON FUNCTION public.resolve_flag_entity(text, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_safety_warnings(p_entity_type text, p_entity_ids uuid[])
 RETURNS TABLE(
   id uuid, entity_type text, entity_id uuid, requested_id uuid, hazard_class text, alert_level text, raised_at timestamptz,
   organization_id uuid, organization_name text, contact_email text, contact_phone text,
   is_own_organization boolean, reason text
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_ids uuid[] := coalesce(p_entity_ids, '{}'::uuid[]);
begin
  -- Service-role callers (edge functions such as the officer scan) have no auth.uid(); they see the same redacted rows.
  if v_actor is not null then
    select up.organization_id into v_org from public.user_profiles up where up.id = v_actor and up.deactivated_at is null;
    if v_org is null then raise exception 'Active user required'; end if;
  elsif current_setting('request.jwt.claim.role', true) is distinct from 'service_role' and current_user <> 'postgres' then
    raise exception 'Active user required';
  end if;
  if cardinality(v_ids) = 0 or cardinality(v_ids) > 200 then return; end if;

  return query
  with requested as (
    select r.requested_id, e.entity_type, e.entity_id
    from unnest(v_ids) as r(requested_id)
    cross join lateral public.resolve_flag_entity(p_entity_type, r.requested_id) e
  )
  select f.id, f.entity_type, f.entity_id, q.requested_id, f.hazard_class, f.alert_level, f.raised_at,
         o.id, o.name, o.contact_email, o.contact_phone,
         (f.organization_id = v_org),
         case when f.organization_id = v_org then f.reason else null end
  from requested q
  join public.entity_flags f on f.entity_type = q.entity_type and f.entity_id = q.entity_id
  join public.organizations o on o.id = f.organization_id
  where f.active and f.hazard_class is not null
  order by case f.alert_level when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, f.raised_at desc;
end;
$function$;
REVOKE ALL ON FUNCTION public.get_safety_warnings(text, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_safety_warnings(text, uuid[]) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_safety_warnings(text, uuid[]) IS 'Platform-wide health-and-safety warnings for vehicles, people, places (or sites/zones, resolved to their place): every organisation''s active hazard-classed flag, redacted to hazard class, severity, raised_at and the raising organisation''s contact path. reason is returned only for the caller''s own organisation. HSWA 2015 s.34/s.36 with Privacy Act 2020 IPP 11(1)(f); owner ruling 2026-09-15.';

-- ---------------------------------------------------------------------------
-- 4. Governed write path
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.raise_entity_flag(
  p_client_request_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_flag_type text,
  p_alert_level text,
  p_reason text,
  p_hazard_class text DEFAULT NULL
) RETURNS entity_flags
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_entity record;
  v_flag public.entity_flags%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_flag_type text := nullif(lower(trim(coalesce(p_flag_type, ''))), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select organization_id into v_org from public.user_profiles where id = v_actor and deactivated_at is null;
  if v_org is null then raise exception 'Active user required'; end if;
  select * into v_flag from public.entity_flags where organization_id = v_org and client_request_id = p_client_request_id;
  if found then return v_flag; end if;

  select * into v_entity from public.resolve_flag_entity(p_entity_type, p_entity_id);
  if v_entity.entity_type = 'vehicle' and not exists (select 1 from public.canonical_vehicles v where v.id = v_entity.entity_id) then raise exception 'Vehicle not found'; end if;
  if v_entity.entity_type = 'person' and not exists (select 1 from public.canonical_people p where p.id = v_entity.entity_id) then raise exception 'Person not found'; end if;
  if v_entity.entity_type = 'place' and not exists (select 1 from public.canonical_places p where p.id = v_entity.entity_id) then raise exception 'Place not found'; end if;
  if p_alert_level not in ('low', 'medium', 'high', 'critical') then raise exception 'Severity must be low, medium, high or critical'; end if;
  if v_flag_type is null then v_flag_type := case when p_hazard_class is not null then 'safety_warning' else 'watchlist' end; end if;
  if p_hazard_class is not null and v_reason is null then raise exception 'A safety warning needs a short note of what to expect'; end if;

  insert into public.entity_flags (organization_id, entity_type, entity_id, flag_type, alert_level, reason, hazard_class, active, raised_by, client_request_id)
  values (v_org, v_entity.entity_type, v_entity.entity_id, v_flag_type, p_alert_level, v_reason, p_hazard_class, true, v_actor, p_client_request_id)
  returning * into v_flag;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_org, v_actor, case when p_hazard_class is null then 'entity_flag_raised' else 'safety_warning_raised' end, 'entity_flags', v_flag.id,
          jsonb_build_object('entity_type', v_flag.entity_type, 'entity_id', v_flag.entity_id, 'flag_type', v_flag.flag_type, 'alert_level', v_flag.alert_level, 'hazard_class', v_flag.hazard_class, 'client_request_id', p_client_request_id));
  return v_flag;
end;
$function$;
REVOKE ALL ON FUNCTION public.raise_entity_flag(uuid, text, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.raise_entity_flag(uuid, text, uuid, text, text, text, text) TO authenticated;
COMMENT ON FUNCTION public.raise_entity_flag(uuid, text, uuid, text, text, text, text) IS 'Raise an of-interest flag, or (with p_hazard_class) a platform-wide safety warning, on a vehicle / person / place / site / zone for the caller''s organisation. Any active member may raise; idempotent on client_request_id; audited.';

CREATE OR REPLACE FUNCTION public.resolve_entity_flag(p_flag_id uuid, p_note text DEFAULT NULL)
 RETURNS entity_flags
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_flag public.entity_flags%rowtype;
begin
  select * into v_flag from public.entity_flags where id = p_flag_id for update;
  if not found then raise exception 'Flag not found'; end if;
  if v_actor is null or not (v_flag.raised_by = v_actor or public.is_admin_for_org(v_flag.organization_id)) then
    raise exception 'Only the person who raised this flag or an administrator of their organisation can resolve it';
  end if;
  if not v_flag.active then return v_flag; end if;
  update public.entity_flags set active = false, resolved_at = now(), resolved_by = v_actor where id = v_flag.id returning * into v_flag;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_flag.organization_id, v_actor, case when v_flag.hazard_class is null then 'entity_flag_resolved' else 'safety_warning_resolved' end, 'entity_flags', v_flag.id,
          jsonb_build_object('entity_type', v_flag.entity_type, 'entity_id', v_flag.entity_id, 'hazard_class', v_flag.hazard_class, 'note', nullif(trim(coalesce(p_note, '')), '')));
  return v_flag;
end;
$function$;
REVOKE ALL ON FUNCTION public.resolve_entity_flag(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_entity_flag(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.resolve_entity_flag(uuid, text) IS 'Resolve (deactivate) a flag or safety warning: the raiser or an administrator of the raising organisation. Audited.';
