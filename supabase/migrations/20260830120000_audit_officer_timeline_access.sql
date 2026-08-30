alter function public.get_officer_activity_timeline(uuid, timestamptz, timestamptz, integer)
  rename to get_officer_activity_timeline_unlogged;

revoke all on function public.get_officer_activity_timeline_unlogged(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;

create function public.get_officer_activity_timeline(
  p_officer_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 1000
) returns table (
  event_key text,
  event_type text,
  event_at timestamptz,
  received_at timestamptz,
  source_table text,
  source_id uuid,
  gps_lat double precision,
  gps_lng double precision,
  shift_id uuid,
  site_id uuid,
  zone_id uuid,
  summary text,
  details jsonb
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_event_count integer;
begin
  return query
  select *
  from public.get_officer_activity_timeline_unlogged(p_officer_id, p_from, p_to, p_limit);

  get diagnostics v_event_count = row_count;
  select organization_id into v_org_id from public.user_profiles where id = p_officer_id;

  if v_org_id is not null then
    insert into public.audit_log (
      organization_id,
      actor_user_id,
      action,
      target_table,
      target_id,
      metadata
    ) values (
      v_org_id,
      auth.uid(),
      'officer_activity_timeline_viewed',
      'user_profiles',
      p_officer_id,
      jsonb_build_object(
        'from', p_from,
        'to', p_to,
        'requested_limit', p_limit,
        'effective_limit', least(greatest(coalesce(p_limit, 1000), 1), 5000),
        'event_count', v_event_count
      )
    );
  end if;
end;
$$;

comment on function public.get_officer_activity_timeline(uuid, timestamptz, timestamptz, integer)
  is 'Returns the authorized officer evidence timeline and atomically audits each successful access.';

revoke all on function public.get_officer_activity_timeline(uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.get_officer_activity_timeline(uuid, timestamptz, timestamptz, integer) to authenticated, service_role;