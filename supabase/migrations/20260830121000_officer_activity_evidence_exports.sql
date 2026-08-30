create table if not exists public.officer_activity_evidence_exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  officer_user_id uuid not null references public.user_profiles(id) on delete restrict,
  generated_by uuid not null references public.user_profiles(id) on delete restrict,
  period_from timestamptz not null,
  period_to timestamptz not null,
  event_count integer not null,
  payload jsonb not null,
  sha256 text not null,
  generated_at timestamptz not null default now(),
  constraint officer_activity_evidence_exports_period_check check (period_from < period_to),
  constraint officer_activity_evidence_exports_event_count_check check (event_count >= 0),
  constraint officer_activity_evidence_exports_sha256_check check (sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.officer_activity_evidence_exports is
  'Append-only canonical snapshots issued from the officer investigation timeline. Normal application roles have no update or delete policy.';

create index if not exists idx_officer_activity_evidence_exports_subject
  on public.officer_activity_evidence_exports (organization_id, officer_user_id, generated_at desc);

alter table public.officer_activity_evidence_exports enable row level security;

create policy officer_activity_evidence_exports_select
  on public.officer_activity_evidence_exports
  for select to authenticated
  using (public.is_admin_for_org(organization_id));

revoke all on table public.officer_activity_evidence_exports from public, anon, authenticated;
grant select on table public.officer_activity_evidence_exports to authenticated;
grant all on table public.officer_activity_evidence_exports to service_role;

create function public.generate_officer_activity_evidence_export(
  p_officer_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 5000
) returns table (
  export_id uuid,
  generated_at timestamptz,
  sha256 text,
  event_count integer,
  package_text text
)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid;
  v_officer_name text;
  v_export_id uuid := gen_random_uuid();
  v_generated_at timestamptz := clock_timestamp();
  v_events jsonb;
  v_payload jsonb;
  v_package_text text;
  v_sha256 text;
  v_event_count integer;
  v_effective_limit integer := least(greatest(coalesce(p_limit, 5000), 1), 5000);
begin
  if v_actor_id is null then raise exception 'Authentication required'; end if;

  select organization_id, display_name
    into v_org_id, v_officer_name
  from public.user_profiles
  where id = p_officer_id;

  if v_org_id is null then raise exception 'Officer profile not found'; end if;
  if not public.is_admin_for_org(v_org_id) then raise exception 'Not authorised to export this officer timeline'; end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '31 days' then
    raise exception 'Export range must be between 1 second and 31 days';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.event_at, t.event_key), '[]'::jsonb)
    into v_events
  from public.get_officer_activity_timeline_unlogged(p_officer_id, p_from, p_to, v_effective_limit) t;

  v_event_count := jsonb_array_length(v_events);
  v_payload := jsonb_build_object(
    'schema_version', 1,
    'export_id', v_export_id,
    'generated_at', v_generated_at,
    'generated_by', v_actor_id,
    'organization_id', v_org_id,
    'officer', jsonb_build_object('id', p_officer_id, 'display_name', v_officer_name),
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'event_count', v_event_count,
    'events', v_events
  );
  v_package_text := v_payload::text;
  v_sha256 := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_package_text, 'UTF8'), 'sha256'), 'hex');

  insert into public.officer_activity_evidence_exports (
    id, organization_id, officer_user_id, generated_by, period_from, period_to,
    event_count, payload, sha256, generated_at
  ) values (
    v_export_id, v_org_id, p_officer_id, v_actor_id, p_from, p_to,
    v_event_count, v_payload, v_sha256, v_generated_at
  );

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_org_id,
    v_actor_id,
    'officer_activity_evidence_exported',
    'officer_activity_evidence_exports',
    v_export_id,
    jsonb_build_object(
      'officer_user_id', p_officer_id,
      'from', p_from,
      'to', p_to,
      'event_count', v_event_count,
      'sha256', v_sha256
    )
  );

  return query select v_export_id, v_generated_at, v_sha256, v_event_count, v_package_text;
end;
$$;

comment on function public.generate_officer_activity_evidence_export(uuid, timestamptz, timestamptz, integer) is
  'Creates an immutable canonical officer timeline snapshot, hashes its exact returned JSON bytes, and audits issuance.';

revoke all on function public.generate_officer_activity_evidence_export(uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.generate_officer_activity_evidence_export(uuid, timestamptz, timestamptz, integer) to authenticated, service_role;