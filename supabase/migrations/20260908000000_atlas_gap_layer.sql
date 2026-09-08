-- Atlas gap layer: expose lifecycle gaps through a deployable, service-role-only RPC.

create or replace function public.bob_atlas_gap_report(
  p_limit integer default 200,
  p_offset integer default 0
)
returns table (
  entity_type text,
  entity_name text,
  gap_kind text,
  present boolean,
  wired boolean,
  exercised boolean,
  caller_summary text,
  notes text,
  retirement_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.entity_type,
    c.entity_name,
    case
      when c.present = true and c.wired = false then 'unwired'
      when c.present = true and (c.exercised is null or c.exercised = false) then 'unexercised'
      else 'dormant'
    end as gap_kind,
    c.present,
    c.wired,
    c.exercised,
    c.caller_summary,
    c.notes,
    c.retirement_status
  from public.bob_capability_map c
  where c.retirement_status <> 'retired'
    and c.present = true
    and (
      c.wired = false
      or c.exercised is null
      or c.exercised = false
    )
  order by c.entity_type, c.entity_name
  limit greatest(1, least(coalesce(p_limit, 200), 500))
  offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function public.bob_atlas_gap_report(integer, integer) from public, anon, authenticated;
grant execute on function public.bob_atlas_gap_report(integer, integer) to service_role;

comment on function public.bob_atlas_gap_report(integer, integer) is
  'Atlas gap-report: list capabilities that are present but not wired or not exercised, scoped to live non-retired entities. This is the formal gap layer for Bob/Atlas and is distinct from the raw bob_capability_map inventory.';
