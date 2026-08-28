create or replace function public.resolve_retention_days (
  p_org_id     uuid,
  p_module_key text,
  p_category   text
)
  returns integer
  language sql
  stable
  AS $function$
  select retention_days
  from public.retention_policies
  where category = p_category
    and is_active
    and (
      (organization_id = p_org_id and module_key = p_module_key)
      or (organization_id = p_org_id and module_key is null)
      or (organization_id is null and module_key is null)
    )
  order by
    -- most specific wins: org+module, then org, then platform
    (organization_id is not null and module_key is not null) desc,
    (organization_id is not null) desc
  limit 1;
$function$;

grant execute on function "public"."resolve_retention_days"(uuid, text, text) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."resolve_retention_days"(uuid, text, text) is 'Effective retention days for (org, module, category): module policy -> org default -> platform default. Drives observations.retention_until; periods are per-council, not hardcoded.';
