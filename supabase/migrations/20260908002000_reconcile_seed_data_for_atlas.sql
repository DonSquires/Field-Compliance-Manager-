-- Reconcile staging data into reviewable canonical paths without creating owned records.

create or replace function public.refresh_fs_nelson_clients_clean()
returns table (raw_rows integer, clean_rows integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw_rows integer;
  v_clean_rows integer;
begin
  select count(*)::integer into v_raw_rows from public._seed_fs_nelson_clients_raw;

  truncate public.fs_nelson_clients_clean;

  insert into public.fs_nelson_clients_clean (
    bureau_id, bureau_name, client_id, client_name, client_address, client_suburb,
    client_postcode, client_state, patrol_type, onsite_datetime, offsite_datetime,
    comments, is_incident_report, patrol_complete_status, visit_charge_ex_gst,
    despatch_zone, subcontractor, onsite_distance_from_site, time_onsite_variation_mins,
    despatch_datetime, internal_clientid, internal_despatchid
  )
  select distinct on (
    coalesce(nullif(btrim(raw.client_id), ''), nullif(btrim(raw.internal_clientid), ''),
      lower(btrim(coalesce(raw.client_name, ''))) || '|' || lower(btrim(coalesce(raw.client_address, ''))))
  )
    nullif(btrim(raw.bureau_id), ''), nullif(btrim(raw.bureau_name), ''),
    nullif(btrim(raw.client_id), ''), nullif(btrim(raw.client_name), ''),
    nullif(btrim(raw.client_address), ''), nullif(btrim(raw.client_suburb), ''),
    nullif(btrim(raw.client_postcode), ''), nullif(btrim(raw.client_state), ''),
    nullif(btrim(raw.patrol_type), ''), nullif(btrim(raw.onsite_datetime), ''),
    nullif(btrim(raw.offsite_datetime), ''), nullif(btrim(raw.comments), ''),
    nullif(btrim(raw.is_incident_report), ''), nullif(btrim(raw.patrol_complete_status), ''),
    nullif(btrim(raw.visit_charge_ex_gst), ''), nullif(btrim(raw.despatch_zone), ''),
    nullif(btrim(raw.subcontractor), ''), nullif(btrim(raw.onsite_distance_from_site), ''),
    nullif(btrim(raw.time_onsite_variation_mins), ''), nullif(btrim(raw.despatch_datetime), ''),
    nullif(btrim(raw.internal_clientid), ''), nullif(btrim(raw.internal_despatchid), '')
  from public._seed_fs_nelson_clients_raw raw
  where nullif(btrim(raw.client_name), '') is not null
     or nullif(btrim(raw.client_address), '') is not null
  order by coalesce(nullif(btrim(raw.client_id), ''), nullif(btrim(raw.internal_clientid), ''),
      lower(btrim(coalesce(raw.client_name, ''))) || '|' || lower(btrim(coalesce(raw.client_address, '')))),
    raw.client_name, raw.client_address;

  get diagnostics v_clean_rows = row_count;
  return query select v_raw_rows, v_clean_rows;
end;
$$;

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
    order by raw.created_at, raw.source_id
    limit greatest(1, least(coalesce(p_limit, 1000), 5000))
  ), reconciled as (
    select candidate.source_id, vehicle.id as vehicle_id
    from candidates candidate
    left join public.canonical_vehicles vehicle on vehicle.plate_number = candidate.plate
  ), updated as (
    update public._seed_downer_linz_vehicle_log_raw raw
    set canonical_vehicle_id = reconciled.vehicle_id,
      processed_at = case when reconciled.vehicle_id is not null then now() else raw.processed_at end,
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

revoke all on function public.refresh_fs_nelson_clients_clean() from public, anon, authenticated;
revoke all on function public.reconcile_downer_linz_vehicle_log(integer) from public, anon, authenticated;
grant execute on function public.refresh_fs_nelson_clients_clean() to service_role;
grant execute on function public.reconcile_downer_linz_vehicle_log(integer) to service_role;

comment on function public.refresh_fs_nelson_clients_clean() is
  'Service-role staging reconciliation: normalizes and deduplicates Nelson client rows for canonical client/site comparison. It never creates organizations or sites.';
comment on function public.reconcile_downer_linz_vehicle_log(integer) is
  'Service-role staging reconciliation: links Downer/LINZ rows to exact existing canonical vehicles only. Unmatched rows remain unresolved for review; it never creates observations or vehicles.';