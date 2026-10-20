create or replace function public.bob_atlas_flow_reach (
  p_from_type text,
  p_from_name text,
  p_direction text    default 'downstream'::text,
  p_max_depth integer default 8
)
  returns table (
    entity_type text,
    entity_name text,
    depth       integer,
    edge_kind   text,
    path        text[]
  )
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  with recursive walk as (
    -- Seed: the origin node itself, depth 0.
    select
      p_from_type::text as entity_type,
      p_from_name::text as entity_name,
      0                 as depth,
      null::text        as edge_kind,
      array[p_from_type || ':' || p_from_name]::text[] as path
    union all
    select
      case when p_direction = 'upstream' then e.source_type else e.target_type end,
      case when p_direction = 'upstream' then e.source_name else e.target_name end,
      w.depth + 1,
      e.edge_kind,
      w.path || (
        (case when p_direction = 'upstream' then e.source_type else e.target_type end)
        || ':' ||
        (case when p_direction = 'upstream' then e.source_name else e.target_name end)
      )
    from walk w
    join public.bob_app_map_edges e
      on e.retirement_status = 'live'
     and e.edge_kind in ('writes','reads','calls','invokes')
     and (
           (p_direction = 'upstream'
              and e.target_type = w.entity_type and e.target_name = w.entity_name)
        or (p_direction <> 'upstream'
              and e.source_type = w.entity_type and e.source_name = w.entity_name)
         )
    where w.depth < least(p_max_depth, 20)
      -- cycle guard: do not revisit a node already on this path (#313 M1)
      and not (
        (case when p_direction = 'upstream' then e.source_type else e.target_type end)
        || ':' ||
        (case when p_direction = 'upstream' then e.source_name else e.target_name end)
      ) = any(w.path)
  )
  select entity_type, entity_name, depth, edge_kind, path
  from walk
  where depth > 0
$function$;

revoke all on function "public"."bob_atlas_flow_reach"(text, text, text, integer) from public;
grant execute on function "public"."bob_atlas_flow_reach"(text, text, text, integer) to "postgres", "service_role";

comment on function "public"."bob_atlas_flow_reach"(text, text, text, integer) is 'Atlas blast-radius: directed data-FLOW reachability (writes/reads/calls/invokes) from a node, live edges only, cycle-guarded + depth-capped. FLOW only - never conflate with FK relation (bob_atlas_fk_reach).';
