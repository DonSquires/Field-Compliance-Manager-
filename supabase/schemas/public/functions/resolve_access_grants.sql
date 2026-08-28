create or replace function public.resolve_access_grants (
  p_user_id uuid,
  p_org_id  uuid
)
  returns table (
    area  text,
    level text
  )
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  with rank_map as (
    select * from (values
      ('view', 1), ('verify', 2), ('approve', 3), ('adjust', 4), ('manage', 5)
    ) as r(level, ord)
  ),
  -- (a) direct per-user grants scoped to an org whose subtree contains p_org_id
  direct as (
    select g.area, g.level
    from public.staff_area_grants g
    where g.user_id = p_user_id
      and g.status = 'active'
      and p_org_id = any (public.get_descendant_organizations(g.scope_org_id))
  ),
  -- (b) grants from assigned presets, expanded from the jsonb grants map
  from_presets as (
    select kv.key as area, kv.value as level
    from public.preset_assignments pa
    join public.access_presets ap on ap.id = pa.preset_id
    cross join lateral jsonb_each_text(ap.grants) as kv(key, value)
    where pa.user_id = p_user_id
      and pa.status = 'active'
      and p_org_id = any (public.get_descendant_organizations(pa.scope_org_id))
  ),
  effective as (
    select area, level from direct
    union all
    select area, level from from_presets
  ),
  ranked as (
    select e.area, rm.ord
    from effective e
    join rank_map rm on rm.level = e.level
  ),
  best as (
    select area, max(ord) as ord from ranked group by area
  )
  select b.area, rm.level
  from best b
  join rank_map rm on rm.ord = b.ord
  order by b.area;
$function$;

grant execute on function "public"."resolve_access_grants"(uuid, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."resolve_access_grants"(uuid, uuid) is 'Effective functional-area:level for a user in an org: union of direct grants (staff_area_grants) + assigned-preset grants (preset_assignments -> access_presets.grants), highest level per area. Preset edits cascade to all holders (issue #3, C3).';
