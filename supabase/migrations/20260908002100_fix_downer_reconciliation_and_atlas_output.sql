-- Mark every Downer reconciliation attempt terminally so unresolved rows do not stall batches.

create or replace function public.reconcile_downer_linz_vehicle_log(p_limit integer default 1000)
returns table (scanned_rows integer, linked_rows integer, unresolved_rows integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scanned_rows integer;
  v_linked_rows integer;
  v_unresolved_rows integer;
begin
  with candidates as (
    select raw.source_id,
      coalesce(nullif(btrim(raw.normalized_plate), ''), nullif(regexp_replace(upper(coalesce(raw.rego, '')), '[^A-Z0-9]', '', 'g'), '')) as plate
    from public._seed_downer_linz_vehicle_log_raw raw
    where raw.processed_at is null
      and raw.canonical_vehicle_id is null
    order by raw.created_at, raw.source_id
    limit greatest(1, least(coalesce(p_limit, 1000), 5000))
  ), reconciled as (
    select candidate.source_id, vehicle.id as vehicle_id
    from candidates candidate
    left join public.canonical_vehicles vehicle on vehicle.plate_number = candidate.plate
  ), updated as (
    update public._seed_downer_linz_vehicle_log_raw raw
    set canonical_vehicle_id = reconciled.vehicle_id,
      processed_at = now(),
      error = case when reconciled.vehicle_id is null then 'No exact canonical vehicle match' else null end
    from reconciled
    where raw.source_id = reconciled.source_id
    returning reconciled.vehicle_id
  )
  select count(*)::integer,
    count(*) filter (where vehicle_id is not null)::integer,
    count(*) filter (where vehicle_id is null)::integer
  into v_scanned_rows, v_linked_rows, v_unresolved_rows
  from updated;

  return query select v_scanned_rows, v_linked_rows, v_unresolved_rows;
end;
$$;

comment on function public.reconcile_downer_linz_vehicle_log(integer) is
  'Service-role staging reconciliation: links Downer/LINZ rows to exact existing canonical vehicles only. Every attempt is marked processed; unmatched rows retain a review reason and it never creates observations or vehicles.';