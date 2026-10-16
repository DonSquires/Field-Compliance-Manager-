create or replace function public.resolve_enforcement_mode (
  p_zone_id uuid
)
  returns text
  language sql
  stable
  security definer
  set search_path = public
  AS $function$
  select coalesce(
    lz.enforcement_workflow_override,
    o.enforcement_workflow_mode,
    'officer_direct'
  )
  from public.location_zones lz
  join public.organizations o on o.id = lz.organization_id
  where lz.id = p_zone_id;
$function$;

revoke all on function "public"."resolve_enforcement_mode"(uuid) from public, "anon", "authenticated";
grant execute on function "public"."resolve_enforcement_mode"(uuid) to "postgres", "service_role";

comment on function "public"."resolve_enforcement_mode"(uuid) is 'Internal effective enforcement workflow resolver: zone override, then organization default, then officer_direct. Called only from governed server-side paths.';
