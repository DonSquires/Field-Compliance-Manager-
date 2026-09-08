-- Atlas intent layer: compare active authored path assertions against live flow terrain.

create or replace function public.bob_atlas_expectation_report(
  p_limit integer default 200,
  p_offset integer default 0
)
returns table (
  expectation_id uuid,
  spine text,
  assertion_kind text,
  from_type text,
  from_name text,
  to_type text,
  to_name text,
  via_type text,
  via_name text,
  expectation_status text,
  gap_kind text,
  rationale text,
  signal_weight numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with recursive active_expectations as (
    select *
    from public.app_map_expectations
    where status = 'active'
  ), paths as (
    select
      e.id as expectation_id,
      e.from_type as entity_type,
      e.from_name as entity_name,
      0 as depth,
      array[e.from_type || ':' || e.from_name]::text[] as path
    from active_expectations e
    union all
    select
      p.expectation_id,
      edge.target_type,
      edge.target_name,
      p.depth + 1,
      p.path || (edge.target_type || ':' || edge.target_name)
    from paths p
    join public.bob_app_map_edges edge
      on edge.source_type = p.entity_type
     and edge.source_name = p.entity_name
     and edge.retirement_status = 'live'
     and edge.edge_kind in ('writes', 'reads', 'calls', 'invokes')
    where p.depth < 8
      and not (edge.target_type || ':' || edge.target_name) = any(p.path)
  ), evaluated as (
    select
      e.*,
      exists (
        select 1 from paths p
        where p.expectation_id = e.id
          and p.entity_type = e.to_type
          and p.entity_name = e.to_name
      ) as reaches_target,
      exists (
        select 1 from paths p
        where p.expectation_id = e.id
          and p.entity_type = e.to_type
          and p.entity_name = e.to_name
          and e.via_type is not null
          and (e.via_type || ':' || e.via_name) = any(p.path)
      ) as reaches_target_via
    from active_expectations e
  )
  select
    e.id,
    e.spine,
    e.assertion_kind,
    e.from_type,
    e.from_name,
    e.to_type,
    e.to_name,
    e.via_type,
    e.via_name,
    case
      when e.assertion_kind = 'must_reach' and e.reaches_target then 'satisfied'
      when e.assertion_kind = 'must_not_reach' and not e.reaches_target then 'satisfied'
      when e.assertion_kind = 'must_pass_through' and e.reaches_target_via then 'satisfied'
      else 'gap'
    end as expectation_status,
    case
      when e.assertion_kind = 'must_reach' and not e.reaches_target then 'broken_reach'
      when e.assertion_kind = 'must_not_reach' and e.reaches_target then 'prohibited_reach'
      when e.assertion_kind = 'must_pass_through' and not e.reaches_target_via then 'missing_required_hop'
      else null
    end as gap_kind,
    e.rationale,
    e.signal_weight
  from evaluated e
  order by e.spine, e.from_type, e.from_name, e.to_type, e.to_name
  limit greatest(1, least(coalesce(p_limit, 200), 500))
  offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function public.bob_atlas_expectation_report(integer, integer) from public, anon, authenticated;
grant execute on function public.bob_atlas_expectation_report(integer, integer) to service_role;

comment on function public.bob_atlas_expectation_report(integer, integer) is
  'Atlas intent evaluator: tests active authored must_reach, must_not_reach, and must_pass_through assertions against directed live flow edges, cycle-guarded and capped at eight hops.';