create or replace function public.get_descendant_organizations (
  org_id uuid
)
  returns uuid[]
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  with recursive org_tree as (
    select id from public.organizations where id = org_id
    union all
    select o.id from public.organizations o
      join org_tree t on o.parent_organization_id = t.id
  )
  select coalesce(array_agg(id), array[]::uuid[]) from org_tree;
$function$;

grant execute on function "public"."get_descendant_organizations"(uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."get_descendant_organizations"(uuid) is 'Inclusive descendant org id array for a root org. SECURITY DEFINER (0098) so it reads the full org tree regardless of the caller RLS - required by is_master_for_org / master_manage_orgs_insert (0093). Body unchanged from 0074.';
