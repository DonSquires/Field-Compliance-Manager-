create or replace function public.resolve_enforcement_mode (
  p_zone_id uuid
)
  returns text
  language sql
  stable
  security definer
  AS $function$
  select coalesce(
    lz.enforcement_workflow_override,
    o.enforcement_workflow_mode,
    'officer_direct'
  )
  from location_zones lz
  join organizations o on o.id = lz.organization_id
  where lz.id = p_zone_id;
$function$;

grant execute on function "public"."resolve_enforcement_mode"(uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."resolve_enforcement_mode"(uuid) is 'Effective enforcement workflow mode for a zone: zone override else org default (else officer_direct). Used by the field notice flow to gate direct issuance.';
