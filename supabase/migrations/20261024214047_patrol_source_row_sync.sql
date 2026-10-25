-- Row-aware patrol source synchronisation.
--
-- Owner ruling (2026-10-25): when a row in an R&M patrol workbook is edited, the
-- matching FCM record must be updated too, so the build must know which rows
-- changed. stage_patrol_import_chunk deliberately refuses changed source
-- provenance and never overwrites core fields, so edits need their own path.
--
-- This migration adds:
--   * patrol_import_record_versions: append-only per-record source history
--     (who/when/which workbook version/which fields changed, before and after).
--   * adopt_patrol_source_baseline: records the first source version for an
--     imported record, but only when FCM already equals the source row.
--   * apply_patrol_source_updates: applies an edited source row, but only when
--     the FCM record still equals what the last sync wrote.
--
-- Both RPCs use the configured tenant import identity and an open staging batch,
-- report per-row holds instead of guessing, and never delete. Locked observation
-- evidence and rows with dependent finance/workshop proposals are held for review.

create table if not exists public.patrol_import_record_versions (
  id uuid primary key default gen_random_uuid(),
  provider_organization_id uuid not null references public.organizations(id),
  client_organization_id uuid not null references public.organizations(id),
  record_kind text not null check (record_kind in ('observation', 'event')),
  record_id uuid not null,
  external_ref text not null check (btrim(external_ref) <> ''),
  source_profile text not null,
  source_file text not null check (btrim(source_file) <> ''),
  source_sheet text,
  source_row integer not null check (source_row > 0),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  derivative_sha256 text not null check (derivative_sha256 ~ '^[a-f0-9]{64}$'),
  source_fingerprint text not null check (source_fingerprint ~ '^[a-f0-9]{64}$'),
  batch_id uuid not null references public.file_import_batches(id),
  version_no integer not null check (version_no > 0),
  change_kind text not null check (change_kind in ('baseline', 'update')),
  changed_fields text[] not null default '{}'::text[],
  state_before jsonb,
  state_after jsonb not null,
  is_current boolean not null default true,
  applied_by uuid not null,
  applied_at timestamptz not null default clock_timestamp(),
  constraint patrol_import_record_versions_version_unique unique (record_kind, record_id, version_no),
  constraint patrol_import_record_versions_baseline_first check ((change_kind = 'baseline') = (version_no = 1))
);

comment on table public.patrol_import_record_versions is
  'Append-only source history for patrol records imported from R&M workbooks. One current row per record holds the last synced source fingerprint and the FCM state that sync wrote; edits apply only while FCM still equals that state.';

create unique index if not exists patrol_import_record_versions_current_record
  on public.patrol_import_record_versions (record_kind, record_id) where is_current;
create unique index if not exists patrol_import_record_versions_current_ref
  on public.patrol_import_record_versions (client_organization_id, record_kind, external_ref) where is_current;
create index if not exists patrol_import_record_versions_batch
  on public.patrol_import_record_versions (batch_id);
create index if not exists patrol_import_record_versions_provider_source
  on public.patrol_import_record_versions (provider_organization_id, source_file, source_sheet) where is_current;

alter table public.patrol_import_record_versions enable row level security;
revoke all on table public.patrol_import_record_versions from public, anon, authenticated, service_role;
grant select on table public.patrol_import_record_versions to authenticated;
grant all on table public.patrol_import_record_versions to postgres;

drop policy if exists patrol_import_record_versions_import_admin_read on public.patrol_import_record_versions;
create policy patrol_import_record_versions_import_admin_read
  on public.patrol_import_record_versions
  for select
  to authenticated
  using (public.is_tenant_import_admin(provider_organization_id));

create or replace function public.patrol_import_record_versions_append_only()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Patrol source history is append-only';
  end if;
  if (to_jsonb(new) - 'is_current') is distinct from (to_jsonb(old) - 'is_current')
     or not (old.is_current and not new.is_current) then
    raise exception 'Patrol source history is append-only; only the current marker may be retired';
  end if;
  return new;
end;
$$;
revoke all on function public.patrol_import_record_versions_append_only() from public, anon, authenticated, service_role;

drop trigger if exists trg_patrol_import_record_versions_append_only on public.patrol_import_record_versions;
create trigger trg_patrol_import_record_versions_append_only
  before update or delete on public.patrol_import_record_versions
  for each row execute function public.patrol_import_record_versions_append_only();

-- Server-side comparable state of the import-managed fields of one record.
-- Timestamps are rendered in UTC so the value does not depend on session time zone.
create or replace function public.patrol_source_record_state(p_kind text, p_record_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select case p_kind
    when 'event' then (
      select jsonb_build_object(
        'occurred_at', to_char(event.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'zone_id', event.zone_id,
        'site_id', event.client_site_id,
        'officer_id', event.observed_entity_id,
        'event_type', event.event_type,
        'status', event.status,
        'observed_entity_type', event.observed_entity_type,
        'distance_km', event.distance_km,
        'payload', coalesce(event.payload, '{}'::jsonb)
      )
      from public.location_events event where event.id = p_record_id
    )
    when 'observation' then (
      select jsonb_build_object(
        'occurred_at', to_char(observation.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'zone_id', observation.zone_id,
        'site_id', observation.site_id,
        'officer_id', observation.officer_id,
        'plate', upper(observation.plate_number),
        'officer_notes', observation.officer_notes,
        'distance_km', observation.distance_km,
        'payload', coalesce(observation.external_refs->'import', '{}'::jsonb)
      )
      from public.observations observation where observation.id = p_record_id
    )
  end;
$$;
revoke all on function public.patrol_source_record_state(text, uuid) from public, anon, authenticated, service_role;

-- Field names (never values) that differ between two record states.
create or replace function public.patrol_source_state_diff(p_before jsonb, p_after jsonb)
returns text[]
language sql
immutable
set search_path to 'public'
as $$
  select coalesce(array_agg(field order by field), '{}'::text[])
  from (
    select key as field
    from (select jsonb_object_keys(coalesce(p_before, '{}'::jsonb) || coalesce(p_after, '{}'::jsonb)) as key) keys
    where key <> 'payload' and p_before->key is distinct from p_after->key
    union all
    select 'payload.' || key
    from (
      select jsonb_object_keys(coalesce(p_before->'payload', '{}'::jsonb) || coalesce(p_after->'payload', '{}'::jsonb)) as key
    ) payload_keys
    where coalesce(p_before->'payload'->key, 'null'::jsonb) is distinct from coalesce(p_after->'payload'->key, 'null'::jsonb)
  ) changed;
$$;
revoke all on function public.patrol_source_state_diff(jsonb, jsonb) from public, anon, authenticated, service_role;

-- Shared gate: open staging batch created by the configured import identity,
-- for this provider/client, with an active contracted patrol module.
create or replace function public.patrol_source_sync_batch(
  p_batch_id uuid,
  p_provider_organization_id uuid,
  p_client_organization_id uuid
)
returns public.file_import_batches
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_batch public.file_import_batches%rowtype;
  v_profile public.import_source_profiles%rowtype;
begin
  select * into v_batch from public.file_import_batches where id = p_batch_id for update;
  if not found or v_batch.organization_id <> p_provider_organization_id or v_batch.status <> 'staging' then
    raise exception 'Open provider import batch required';
  end if;
  if v_batch.manifest_json->>'target_client_organization_id' is distinct from p_client_organization_id::text then
    raise exception 'Import batch client mismatch';
  end if;
  select * into v_profile from public.import_source_profiles
  where organization_id = p_provider_organization_id
    and profile_code = v_batch.manifest_json->>'source_profile'
    and active;
  if not found or v_profile.import_actor_id is null or v_profile.import_actor_id <> auth.uid()
     or v_batch.created_by <> auth.uid() then
    raise exception 'Configured tenant import identity required';
  end if;
  if not public.is_tenant_import_admin(p_provider_organization_id) then
    raise exception 'Tenant import administrator required';
  end if;
  if v_batch.source_sha256 is null or coalesce(v_batch.manifest_json->>'derivative_sha256', '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Import batch provenance is incomplete';
  end if;
  if not exists (
    select 1 from public.service_agreements agreement
    join public.service_agreement_modules module
      on module.service_agreement_id = agreement.id and module.module_key = 'patrol' and module.enabled
    where agreement.provider_organization_id = p_provider_organization_id
      and agreement.client_organization_id = p_client_organization_id
      and agreement.agreement_type = 'operational'
      and (agreement.starts_on is null or agreement.starts_on <= current_date)
      and (agreement.ends_on is null or agreement.ends_on >= current_date)
  ) then
    raise exception 'Active contracted patrol module required';
  end if;
  return v_batch;
end;
$$;
revoke all on function public.patrol_source_sync_batch(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Desired-row provenance must belong to the batch; violations are errors, not holds.
create or replace function public.patrol_source_assert_row_provenance(
  p_batch public.file_import_batches,
  p_item jsonb
)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $$
declare
  v_payload jsonb := p_item->'desired'->'payload';
begin
  if p_item->>'kind' not in ('observation', 'event')
     or nullif(p_item->>'record_id', '') is null
     or jsonb_typeof(p_item->'desired') <> 'object'
     or jsonb_typeof(v_payload) <> 'object'
     or nullif(btrim(p_item->>'external_ref'), '') is null
     or p_item->'desired'->>'external_ref' is distinct from p_item->>'external_ref'
     or coalesce(p_item->>'source_fingerprint', '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Source sync rows require kind, record, external reference, desired state and fingerprint';
  end if;
  if v_payload->>'source_sha256' is distinct from p_batch.source_sha256
     or v_payload->>'derivative_sha256' is distinct from p_batch.manifest_json->>'derivative_sha256'
     or nullif(v_payload->>'source_file', '') is null
     or v_payload->>'source_file' is distinct from p_batch.source_file
     or coalesce(v_payload->>'source_row', '') !~ '^[1-9][0-9]*$'
     or v_payload->>'classification_profile' is distinct from p_batch.manifest_json->>'source_profile' then
    raise exception 'Source sync row provenance does not match its batch';
  end if;
  return jsonb_set(v_payload, '{source}', '"rm_patrol_log_import"'::jsonb, true);
end;
$$;
revoke all on function public.patrol_source_assert_row_provenance(public.file_import_batches, jsonb) from public, anon, authenticated, service_role;

create or replace function public.adopt_patrol_source_baseline(
  p_batch_id uuid,
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_records jsonb
)
returns table(external_ref text, record_id uuid, outcome text, detail text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_batch public.file_import_batches%rowtype;
  v_item jsonb;
  v_desired jsonb;
  v_payload jsonb;
  v_kind text;
  v_ref text;
  v_id uuid;
  v_version public.patrol_import_record_versions%rowtype;
  v_existing jsonb;
  v_current jsonb;
  v_target jsonb;
  v_before jsonb;
  v_after jsonb;
  v_mismatch text[];
  v_provenance constant text[] := array['source', 'source_file', 'source_sheet', 'source_row', 'source_sha256', 'derivative_sha256', 'classification_profile'];
begin
  v_batch := public.patrol_source_sync_batch(p_batch_id, p_provider_organization_id, p_client_organization_id);
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 500 then
    raise exception 'Between 0 and 500 baseline rows are required per call';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_records) value order by value->>'kind', value->>'external_ref'
  loop
    v_payload := public.patrol_source_assert_row_provenance(v_batch, v_item);
    v_kind := v_item->>'kind';
    v_ref := v_item->>'external_ref';
    v_id := (v_item->>'record_id')::uuid;
    v_desired := v_item->'desired';
    perform pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text || ':evidence:' || v_ref, 0));

    if v_kind = 'event' then
      select event.payload into v_existing from public.location_events event
      where event.id = v_id and event.organization_id = p_client_organization_id
        and event.external_ref = v_ref and event.source = 'rm_patrol_log_import'
      for update;
    else
      select observation.external_refs->'import' into v_existing from public.observations observation
      where observation.id = v_id and observation.organization_id = p_client_organization_id
        and observation.external_refs->>'external_ref' = v_ref
        and coalesce(observation.external_refs->'import'->>'source', 'rm_patrol_log_import') = 'rm_patrol_log_import'
      for update;
    end if;
    if not found then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := 'record_not_owned_by_importer';
      return next; continue;
    end if;

    select * into v_version from public.patrol_import_record_versions version
    where version.record_kind = v_kind and version.record_id = v_id and version.is_current;
    if found then
      external_ref := v_ref; record_id := v_id;
      if v_version.source_fingerprint = v_item->>'source_fingerprint' then
        outcome := 'already_current'; detail := null;
      else
        outcome := 'held'; detail := 'baseline_already_recorded';
      end if;
      return next; continue;
    end if;

    if (nullif(v_existing->>'source_file', '') is not null and v_existing->>'source_file' is distinct from v_payload->>'source_file')
       or (nullif(v_existing->>'source_sheet', '') is not null and v_existing->>'source_sheet' is distinct from v_payload->>'source_sheet') then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := 'existing_source_identity_mismatch';
      return next; continue;
    end if;

    v_current := public.patrol_source_record_state(v_kind, v_id);
    v_target := jsonb_build_object(
      'occurred_at', to_char((v_desired->>'occurred_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'zone_id', nullif(v_desired->>'zone_id', ''),
      'site_id', nullif(v_desired->>'site_id', ''),
      'distance_km', case when v_desired->'distance_km' is null or jsonb_typeof(v_desired->'distance_km') = 'null' then null else (v_desired->>'distance_km')::numeric end
    ) || case v_kind
      when 'event' then jsonb_build_object(
        'officer_id', nullif(v_desired->>'observed_entity_id', ''),
        'event_type', v_desired->>'event_type',
        'status', v_desired->>'status',
        'observed_entity_type', v_desired->>'observed_entity_type')
      else jsonb_build_object(
        'officer_id', nullif(v_desired->>'officer_id', ''),
        'plate', upper(v_desired->>'plate'),
        'officer_notes', v_desired->>'officer_notes')
    end;

    select coalesce(array_agg(field order by field), '{}'::text[]) into v_mismatch
    from (
      select key as field from jsonb_each(v_target) target
      where (v_current->key) is distinct from target.value
        and not (jsonb_typeof(v_current->key) = 'number' and jsonb_typeof(target.value) = 'number'
                 and (v_current->>key)::numeric = (target.value#>>'{}')::numeric)
      union all
      select 'payload.' || key from (
        select jsonb_object_keys(v_payload || coalesce(v_existing, '{}'::jsonb)) as key
      ) payload_keys
      where key <> all (v_provenance)
        and coalesce(v_existing->key, 'null'::jsonb) is distinct from coalesce(v_payload->key, 'null'::jsonb)
    ) differences;

    if cardinality(v_mismatch) > 0 then
      external_ref := v_ref; record_id := v_id; outcome := 'held';
      detail := 'initial_difference_requires_review:' || array_to_string(v_mismatch, ',');
      return next; continue;
    end if;

    v_before := v_current;
    if v_kind = 'event' then
      update public.location_events event
      set payload = coalesce(event.payload, '{}'::jsonb) || jsonb_build_object(
        'source', v_payload->'source', 'source_file', v_payload->'source_file', 'source_sheet', v_payload->'source_sheet',
        'source_row', v_payload->'source_row', 'source_sha256', v_payload->'source_sha256',
        'derivative_sha256', v_payload->'derivative_sha256', 'classification_profile', v_payload->'classification_profile')
      where event.id = v_id;
    else
      update public.observations observation
      set external_refs = jsonb_set(coalesce(observation.external_refs, '{}'::jsonb), '{import}',
        coalesce(observation.external_refs->'import', '{}'::jsonb) || jsonb_build_object(
          'source', v_payload->'source', 'source_file', v_payload->'source_file', 'source_sheet', v_payload->'source_sheet',
          'source_row', v_payload->'source_row', 'source_sha256', v_payload->'source_sha256',
          'derivative_sha256', v_payload->'derivative_sha256', 'classification_profile', v_payload->'classification_profile'), true)
      where observation.id = v_id;
    end if;
    v_after := public.patrol_source_record_state(v_kind, v_id);

    insert into public.patrol_import_record_versions(
      provider_organization_id, client_organization_id, record_kind, record_id, external_ref, source_profile,
      source_file, source_sheet, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
      version_no, change_kind, changed_fields, state_before, state_after, applied_by
    ) values (
      p_provider_organization_id, p_client_organization_id, v_kind, v_id, v_ref, v_payload->>'classification_profile',
      v_payload->>'source_file', v_payload->>'source_sheet', (v_payload->>'source_row')::integer,
      v_payload->>'source_sha256', v_payload->>'derivative_sha256', v_item->>'source_fingerprint', p_batch_id,
      1, 'baseline', public.patrol_source_state_diff(v_before, v_after), v_before, v_after, auth.uid()
    );

    external_ref := v_ref; record_id := v_id; outcome := 'adopted'; detail := null;
    return next;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_provider_organization_id, auth.uid(), 'patrol_source_baseline_recorded', 'file_import_batches', p_batch_id,
    jsonb_build_object('client_organization_id', p_client_organization_id, 'rows', jsonb_array_length(p_records)));
end;
$$;
revoke all on function public.adopt_patrol_source_baseline(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.adopt_patrol_source_baseline(uuid, uuid, uuid, jsonb) to authenticated;

create or replace function public.apply_patrol_source_updates(
  p_batch_id uuid,
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_updates jsonb
)
returns table(external_ref text, record_id uuid, outcome text, detail text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_batch public.file_import_batches%rowtype;
  v_item jsonb;
  v_desired jsonb;
  v_payload jsonb;
  v_kind text;
  v_ref text;
  v_id uuid;
  v_version public.patrol_import_record_versions%rowtype;
  v_observation public.observations%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_zone uuid;
  v_site uuid;
  v_officer uuid;
  v_occurred timestamptz;
  v_distance numeric;
  v_plate text;
  v_vehicle uuid;
  v_hold text;
  v_updated integer := 0;
  v_ignored constant text[] := array['source', 'source_file', 'source_sheet', 'source_row', 'source_sha256', 'derivative_sha256',
    'classification_profile', 'source_profile', 'evidence_record_type', 'evidence_external_ref', 'client_organization_id'];
begin
  v_batch := public.patrol_source_sync_batch(p_batch_id, p_provider_organization_id, p_client_organization_id);
  if jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) > 500 then
    raise exception 'Between 0 and 500 update rows are required per call';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_updates) value order by value->>'kind', value->>'external_ref'
  loop
    v_payload := public.patrol_source_assert_row_provenance(v_batch, v_item);
    if coalesce(v_item->>'prior_source_fingerprint', '') !~ '^[a-f0-9]{64}$' then
      raise exception 'Source updates require the prior source fingerprint';
    end if;
    v_kind := v_item->>'kind';
    v_ref := v_item->>'external_ref';
    v_id := (v_item->>'record_id')::uuid;
    v_desired := v_item->'desired';
    v_hold := null;
    perform pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text || ':evidence:' || v_ref, 0));

    select * into v_version from public.patrol_import_record_versions version
    where version.record_kind = v_kind and version.record_id = v_id and version.is_current
    for update;
    if not found then
      v_hold := 'source_baseline_required';
    elsif v_version.client_organization_id <> p_client_organization_id
       or v_version.provider_organization_id <> p_provider_organization_id
       or v_version.external_ref <> v_ref then
      raise exception 'Source history scope does not match the requested record';
    elsif v_version.source_fingerprint = v_item->>'source_fingerprint' and v_version.batch_id = p_batch_id then
      external_ref := v_ref; record_id := v_id; outcome := 'already_applied'; detail := null;
      return next; continue;
    elsif v_version.source_fingerprint <> v_item->>'prior_source_fingerprint' then
      v_hold := 'stale_source_comparison';
    elsif v_version.source_file <> v_payload->>'source_file'
       or v_version.source_sheet is distinct from v_payload->>'source_sheet'
       or v_version.source_profile <> v_payload->>'classification_profile' then
      v_hold := 'source_identity_changed';
    end if;

    if v_hold is null then
      v_before := public.patrol_source_record_state(v_kind, v_id);
      if v_before is null then
        v_hold := 'previously_linked_record_missing';
      elsif v_before is distinct from v_version.state_after then
        v_hold := 'fcm_record_changed_since_last_sync';
      end if;
    end if;

    if v_hold is null then
      v_occurred := (v_desired->>'occurred_at')::timestamptz;
      v_zone := nullif(v_desired->>'zone_id', '')::uuid;
      v_site := nullif(v_desired->>'site_id', '')::uuid;
      v_officer := nullif(v_desired->>(case when v_kind = 'event' then 'observed_entity_id' else 'officer_id' end), '')::uuid;
      v_distance := case when v_desired->'distance_km' is null or jsonb_typeof(v_desired->'distance_km') = 'null'
        then null else (v_desired->>'distance_km')::numeric end;
      if (v_zone is null) = (v_site is null) then
        v_hold := 'one_resolved_place_required';
      elsif v_distance is not null and v_distance < 0 then
        v_hold := 'invalid_source_distance';
      elsif not exists (
        select 1 from public.service_agreements agreement
        join public.service_agreement_modules module
          on module.service_agreement_id = agreement.id and module.module_key = 'patrol' and module.enabled
        join public.service_agreement_locations location
          on location.service_agreement_id = agreement.id and location.status = 'active'
        where agreement.provider_organization_id = p_provider_organization_id
          and agreement.client_organization_id = p_client_organization_id
          and agreement.agreement_type = 'operational'
          and (agreement.starts_on is null or agreement.starts_on <= current_date)
          and (agreement.ends_on is null or agreement.ends_on >= current_date)
          and ((v_zone is not null and location.zone_id = v_zone) or (v_site is not null and location.site_id = v_site))
      ) then
        v_hold := 'place_outside_contracted_patrol_coverage';
      elsif (v_officer is not null or v_kind = 'observation') and not exists (
        select 1 from public.user_profiles profile
        where profile.id = v_officer and profile.deactivated_at is null
          and (profile.organization_id = p_provider_organization_id or profile.employer_organization_id = p_provider_organization_id)
      ) then
        v_hold := 'source_staff_not_active_for_provider';
      elsif exists (
        select 1
        from public.file_import_row_proposals proposal
        cross join lateral jsonb_each(proposal.source_values) source_value
        where proposal.organization_id = p_provider_organization_id
          and proposal.source_record_key = v_ref
          -- Only an undecided or unapplied review of the old values blocks the edit; applied
          -- outcomes are revisited through the fresh proposal staged in this batch.
          and proposal.batch_id <> p_batch_id
          and proposal.status in ('proposed', 'approved')
          and source_value.key <> all (v_ignored)
          and v_payload ? source_value.key
          and v_payload->source_value.key is distinct from source_value.value
      ) then
        v_hold := 'dependent_proposal_review_required';
      end if;
    end if;

    if v_hold is null and v_kind = 'observation' then
      select * into v_observation from public.observations where id = v_id for update;
      v_plate := upper(btrim(v_desired->>'plate'));
      if nullif(v_plate, '') is null then
        v_hold := 'observation_plate_required';
      elsif v_observation.locked_at is not null and (
        v_observation.observed_at is distinct from v_occurred
        or upper(v_observation.plate_number) is distinct from v_plate
        or v_observation.officer_id is distinct from v_officer
        or v_observation.zone_id is distinct from v_zone
      ) then
        v_hold := 'locked_evidence_requires_correction_review';
      end if;
    end if;

    if v_hold is not null then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := v_hold;
      return next; continue;
    end if;

    if v_kind = 'event' then
      update public.location_events event
      set occurred_at = v_occurred,
          zone_id = v_zone,
          client_site_id = v_site,
          observed_entity_id = v_officer,
          observed_entity_type = v_desired->>'observed_entity_type',
          event_type = v_desired->>'event_type',
          status = v_desired->>'status',
          distance_km = v_distance,
          payload = v_payload
      where event.id = v_id and event.organization_id = p_client_organization_id
        and event.external_ref = v_ref and event.source = 'rm_patrol_log_import';
    else
      if upper(v_observation.plate_number) is distinct from v_plate then
        perform pg_advisory_xact_lock(hashtextextended('vehicle:' || v_plate, 0));
        select id into v_vehicle from public.canonical_vehicles where upper(plate_number) = v_plate limit 1;
        if v_vehicle is null then
          insert into public.canonical_vehicles(plate_number, compliance_source) values (v_plate, 'canonical') returning id into v_vehicle;
        end if;
      else
        v_vehicle := v_observation.canonical_vehicle_id;
      end if;
      update public.observations observation
      set observed_at = v_occurred,
          -- Plate identity is case-insensitive; keep the stored spelling so locked evidence is not rewritten.
          plate_number = case when upper(observation.plate_number) = v_plate then observation.plate_number else v_plate end,
          canonical_vehicle_id = v_vehicle,
          zone_id = v_zone,
          site_id = v_site,
          officer_id = v_officer,
          officer_notes = v_desired->>'officer_notes',
          distance_km = v_distance,
          external_refs = jsonb_set(coalesce(observation.external_refs, '{}'::jsonb), '{import}', v_payload, true)
      where observation.id = v_id and observation.organization_id = p_client_organization_id
        and observation.external_refs->>'external_ref' = v_ref;
    end if;
    if not found then
      raise exception 'Source update target changed during synchronisation';
    end if;

    v_after := public.patrol_source_record_state(v_kind, v_id);
    v_changed := public.patrol_source_state_diff(v_before, v_after);

    update public.patrol_import_record_versions set is_current = false where id = v_version.id;
    insert into public.patrol_import_record_versions(
      provider_organization_id, client_organization_id, record_kind, record_id, external_ref, source_profile,
      source_file, source_sheet, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
      version_no, change_kind, changed_fields, state_before, state_after, applied_by
    ) values (
      p_provider_organization_id, p_client_organization_id, v_kind, v_id, v_ref, v_payload->>'classification_profile',
      v_payload->>'source_file', v_payload->>'source_sheet', (v_payload->>'source_row')::integer,
      v_payload->>'source_sha256', v_payload->>'derivative_sha256', v_item->>'source_fingerprint', p_batch_id,
      v_version.version_no + 1, 'update', v_changed, v_before, v_after, auth.uid()
    );

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (p_provider_organization_id, auth.uid(), 'patrol_source_row_updated',
      case v_kind when 'event' then 'location_events' else 'observations' end, v_id,
      jsonb_build_object('batch_id', p_batch_id, 'client_organization_id', p_client_organization_id,
        'external_ref', v_ref, 'version_no', v_version.version_no + 1, 'changed_fields', to_jsonb(v_changed),
        'source_file', v_payload->>'source_file', 'source_sheet', v_payload->>'source_sheet',
        'source_row', (v_payload->>'source_row')::integer, 'source_sha256', v_payload->>'source_sha256'));

    v_updated := v_updated + 1;
    external_ref := v_ref; record_id := v_id; outcome := 'updated'; detail := array_to_string(v_changed, ',');
    return next;
  end loop;
end;
$$;
revoke all on function public.apply_patrol_source_updates(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.apply_patrol_source_updates(uuid, uuid, uuid, jsonb) to authenticated;
