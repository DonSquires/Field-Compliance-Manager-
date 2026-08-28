create or replace function public.bob_atlas_fk_reach (
  p_from_type text,
  p_from_name text,
  p_max_depth integer default 8
)
  returns table (
    entity_type text,
    entity_name text,
    depth       integer,
    edge_kind   text,
    edge_from   text,
    edge_to     text,
    path        text[]
  )
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  with recursive walk as (
    select
      p_from_type::text as entity_type,
      p_from_name::text as entity_name,
      0                 as depth,
      null::text        as edge_kind,
      null::text        as edge_from,
      null::text        as edge_to,
      array[p_from_type || ':' || p_from_name]::text[] as path
    union all
    -- UNDIRECTED: step to whichever end of the FK edge is NOT the current node.
    select
      nb.n_type,
      nb.n_name,
      w.depth + 1,
      e.edge_kind,
      e.source_type || ':' || e.source_name,
      e.target_type || ':' || e.target_name,
      w.path || (nb.n_type || ':' || nb.n_name)
    from walk w
    join public.bob_app_map_edges e
      on e.retirement_status = 'live'
     and e.edge_kind in ('fk_references','references')
     and (
           (e.source_type = w.entity_type and e.source_name = w.entity_name)
        or (e.target_type = w.entity_type and e.target_name = w.entity_name)
         )
    cross join lateral (
      select
        case when e.source_type = w.entity_type and e.source_name = w.entity_name
             then e.target_type else e.source_type end as n_type,
        case when e.source_type = w.entity_type and e.source_name = w.entity_name
             then e.target_name else e.source_name end as n_name
    ) nb
    where w.depth < least(p_max_depth, 20)
      and not (nb.n_type || ':' || nb.n_name) = any(w.path)
  )
  select entity_type, entity_name, depth, edge_kind, edge_from, edge_to, path
  from walk
  where depth > 0
$function$;

grant execute on function "public"."bob_atlas_fk_reach"(text, text, integer) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."bob_atlas_fk_reach"(text, text, integer) is 'Atlas blast-radius: UNDIRECTED structural/FK relation reach (fk_references/references) from a node, live edges only, cycle-guarded + depth-capped. Returns the actual live edge direction (edge_from/edge_to) per #313 M4. This is a RELATION, never a proven data-flow path (see bob_atlas_flow_reach).';
