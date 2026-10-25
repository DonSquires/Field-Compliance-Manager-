-- DART Step B: legacy patrol record correction and duplicate supersede.
--
-- Owner rulings (2026-10-25):
--   * Legacy records are corrected in place, through a governed, versioned path.
--   * 2025 and 2026 are distinct source years and remain separate.
--   * The "Update 251215" worksheet is applied only where one source row maps
--     to one 2025 event; the 2025 job number is preserved. Collisions and
--     unmatched copies stay live and held.
--   * Any record that is already invoiced or linked to another record is held.
--
-- The 2026-09-23 importer stored no source provenance, applied a fixed +12
-- offset (one hour late in NZDT months), never filled distance_km, and wrote
-- job_time_hours at 15 significant digits. correct_legacy_patrol_source_records
-- repairs exactly those artifacts and holds every other difference.
--
-- Superseding archives the full row into location_events_superseded and then
-- removes it from location_events, so none of the ~30 location_events readers
-- double count. An insert guard stops a superseded reference being imported
-- again.

alter table public.patrol_import_record_versions
  drop constraint if exists patrol_import_record_versions_change_kind_check;
alter table public.patrol_import_record_versions
  add constraint patrol_import_record_versions_change_kind_check
  check (change_kind in ('baseline', 'update', 'legacy_correction', 'superseded'));
alter table public.patrol_import_record_versions
  drop constraint if exists patrol_import_record_versions_baseline_first;
alter table public.patrol_import_record_versions
  add constraint patrol_import_record_versions_baseline_first
  check (change_kind = 'superseded' or ((change_kind in ('baseline', 'legacy_correction')) = (version_no = 1)));

-- A reviewed Update overlay leaves FCM deliberately different from its canonical source row.
-- The version keeps the canonical source identity and fingerprint; record_fingerprint is what
-- FCM held after that sync and overlay_source records where the overlay came from.
alter table public.patrol_import_record_versions
  add column if not exists record_fingerprint text,
  add column if not exists overlay_source jsonb;
alter table public.patrol_import_record_versions
  drop constraint if exists patrol_import_record_versions_overlay_check;
alter table public.patrol_import_record_versions
  add constraint patrol_import_record_versions_overlay_check
  check ((record_fingerprint is null) = (overlay_source is null)
    and (record_fingerprint is null or record_fingerprint ~ '^[a-f0-9]{64}$')
    and (overlay_source is null or jsonb_typeof(overlay_source) = 'object'));

-- The legacy importer's one-hour artifact exists only while New Zealand is on daylight time.
create or replace function public.patrol_nz_daylight(p_at timestamptz)
returns boolean
language sql
stable
set search_path to 'pg_catalog'
as $$
  select (p_at at time zone 'Pacific/Auckland') - (p_at at time zone 'UTC') = interval '13 hours';
$$;
revoke all on function public.patrol_nz_daylight(timestamptz) from public, anon, authenticated, service_role;

create table if not exists public.location_events_superseded (
  id uuid primary key default gen_random_uuid(),
  provider_organization_id uuid not null references public.organizations(id),
  client_organization_id uuid not null references public.organizations(id),
  location_event_id uuid not null unique,
  external_ref text not null check (btrim(external_ref) <> ''),
  canonical_location_event_id uuid not null,
  canonical_external_ref text not null check (btrim(canonical_external_ref) <> ''),
  reason_code text not null check (reason_code in ('duplicate_of_canonical_sheet')),
  batch_id uuid not null references public.file_import_batches(id),
  event_snapshot jsonb not null check (jsonb_typeof(event_snapshot) = 'object'),
  superseded_by uuid not null,
  superseded_at timestamptz not null default clock_timestamp(),
  check (location_event_id <> canonical_location_event_id)
);

comment on table public.location_events_superseded is
  'Append-only archive of imported patrol events removed as duplicates of a canonical source record. Holds the full original row, the canonical record it duplicated, the batch and the actor.';

create unique index if not exists location_events_superseded_client_ref
  on public.location_events_superseded (client_organization_id, external_ref);
create index if not exists location_events_superseded_canonical
  on public.location_events_superseded (canonical_location_event_id);
create index if not exists location_events_superseded_batch
  on public.location_events_superseded (batch_id);

alter table public.location_events_superseded enable row level security;
revoke all on table public.location_events_superseded from public, anon, authenticated, service_role;
grant select on table public.location_events_superseded to authenticated;
grant all on table public.location_events_superseded to postgres;

drop policy if exists location_events_superseded_import_admin_read on public.location_events_superseded;
create policy location_events_superseded_import_admin_read
  on public.location_events_superseded
  for select
  to authenticated
  using (public.is_tenant_import_admin(provider_organization_id));

create or replace function public.location_events_superseded_append_only()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  raise exception 'Superseded patrol event archive is append-only';
end;
$$;
revoke all on function public.location_events_superseded_append_only() from public, anon, authenticated, service_role;

drop trigger if exists trg_location_events_superseded_append_only on public.location_events_superseded;
create trigger trg_location_events_superseded_append_only
  before update or delete on public.location_events_superseded
  for each row execute function public.location_events_superseded_append_only();

-- A superseded import reference must never come back through any import path.
create or replace function public.location_events_block_superseded_reimport()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.source = 'rm_patrol_log_import' and new.external_ref is not null and exists (
    select 1 from public.location_events_superseded archived
    where archived.client_organization_id = new.organization_id and archived.external_ref = new.external_ref
  ) then
    raise exception 'Patrol source record % was superseded and cannot be imported again', new.external_ref;
  end if;
  return new;
end;
$$;
revoke all on function public.location_events_block_superseded_reimport() from public, anon, authenticated, service_role;

drop trigger if exists trg_location_events_block_superseded_reimport on public.location_events;
create trigger trg_location_events_block_superseded_reimport
  before insert on public.location_events
  for each row execute function public.location_events_block_superseded_reimport();

-- Why a patrol event may not be corrected or removed: invoiced, finance-linked,
-- referenced by another record, or under an open import review. Null when clear.
create or replace function public.patrol_source_event_dependency_hold(
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_event_id uuid,
  p_external_ref text,
  p_batch_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_fk record;
  v_linked boolean;
begin
  if exists (
    select 1 from public.file_import_finance_cost_rows cost_row
    join public.finance_service_costs cost on cost.id = cost_row.finance_service_cost_id
    where cost_row.client_organization_id = p_client_organization_id
      and cost_row.evidence_external_ref = p_external_ref
      and (cost.invoice_line_item_id is not null or cost.invoiced_at is not null)
  ) then
    return 'invoiced_record';
  end if;
  if exists (
    select 1 from public.file_import_finance_cost_rows cost_row
    where cost_row.client_organization_id = p_client_organization_id
      and cost_row.evidence_external_ref = p_external_ref
  ) then
    return 'finance_cost_linked';
  end if;
  if exists (
    select 1 from public.file_import_row_proposals proposal
    where proposal.organization_id = p_provider_organization_id
      and proposal.source_record_key = p_external_ref
      and proposal.batch_id <> p_batch_id
      and proposal.status in ('proposed', 'approved')
  ) then
    return 'dependent_proposal_review_required';
  end if;
  for v_fk in
    select constraint_def.conrelid::regclass as table_name, attribute.attname as column_name
    from pg_constraint constraint_def
    join pg_attribute attribute
      on attribute.attrelid = constraint_def.conrelid and attribute.attnum = constraint_def.conkey[1]
    where constraint_def.contype = 'f'
      and constraint_def.confrelid = 'public.location_events'::regclass
      and cardinality(constraint_def.conkey) = 1
  loop
    execute format('select exists(select 1 from %s where %I = $1)', v_fk.table_name, v_fk.column_name)
      into v_linked using p_event_id;
    if v_linked then
      return 'linked_record:' || v_fk.table_name::text;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function public.patrol_source_event_dependency_hold(uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- Two text values are the same number (legacy job_time_hours precision).
create or replace function public.patrol_source_numeric_text_equal(p_left jsonb, p_right jsonb)
returns boolean
language plpgsql
immutable
set search_path to 'public'
as $$
begin
  if p_left is null or p_right is null then
    return false;
  end if;
  if jsonb_typeof(p_left) not in ('string', 'number') or jsonb_typeof(p_right) not in ('string', 'number')
     or (p_left#>>'{}') !~ '^-?[0-9]+(\.[0-9]+)?$' or (p_right#>>'{}') !~ '^-?[0-9]+(\.[0-9]+)?$' then
    return false;
  end if;
  return abs((p_left#>>'{}')::numeric - (p_right#>>'{}')::numeric) < 0.000000001;
end;
$$;
revoke all on function public.patrol_source_numeric_text_equal(jsonb, jsonb) from public, anon, authenticated, service_role;

create or replace function public.correct_legacy_patrol_source_records(
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
  v_ref text;
  v_id uuid;
  v_event public.location_events%rowtype;
  v_version public.patrol_import_record_versions%rowtype;
  v_occurred timestamptz;
  v_distance numeric;
  v_offset interval;
  v_mismatch text[];
  v_source_leg jsonb;
  v_hold text;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_corrected integer := 0;
begin
  v_batch := public.patrol_source_sync_batch(p_batch_id, p_provider_organization_id, p_client_organization_id);
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 500 then
    raise exception 'Between 0 and 500 legacy correction rows are required per call';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_records) value order by value->>'external_ref'
  loop
    v_payload := public.patrol_source_assert_row_provenance(v_batch, v_item);
    if v_item->>'kind' <> 'event' then
      raise exception 'Legacy correction applies to patrol events only';
    end if;
    v_ref := v_item->>'external_ref';
    v_id := (v_item->>'record_id')::uuid;
    v_desired := v_item->'desired';
    v_hold := null;
    perform pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text || ':evidence:' || v_ref, 0));

    select * into v_event from public.location_events event
    where event.id = v_id and event.organization_id = p_client_organization_id
      and event.external_ref = v_ref and event.source = 'rm_patrol_log_import'
    for update;
    if not found then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := 'record_not_owned_by_importer';
      return next; continue;
    end if;

    select * into v_version from public.patrol_import_record_versions version
    where version.record_kind = 'event' and version.record_id = v_id and version.is_current;
    if found then
      external_ref := v_ref; record_id := v_id;
      if v_version.change_kind = 'legacy_correction' and v_version.source_fingerprint = v_item->>'source_fingerprint' then
        outcome := 'already_current'; detail := null;
      else
        outcome := 'held'; detail := 'source_history_already_recorded';
      end if;
      return next; continue;
    end if;

    if nullif(v_event.payload->>'source_file', '') is not null or nullif(v_event.payload->>'source_sheet', '') is not null then
      v_hold := 'not_a_legacy_record';
    end if;

    if v_hold is null then
      select coalesce(array_agg(field order by field), '{}'::text[]) into v_mismatch
      from (
        select 'zone_id' as field where v_event.zone_id is distinct from nullif(v_desired->>'zone_id', '')::uuid
        union all select 'site_id' where v_event.client_site_id is distinct from nullif(v_desired->>'site_id', '')::uuid
        union all select 'officer_id' where v_event.observed_entity_id is distinct from nullif(v_desired->>'observed_entity_id', '')::uuid
        union all select 'observed_entity_type' where v_event.observed_entity_type is distinct from v_desired->>'observed_entity_type'
        union all select 'event_type' where v_event.event_type is distinct from v_desired->>'event_type'
        union all select 'status' where v_event.status is distinct from v_desired->>'status'
      ) identity_fields;
      if cardinality(v_mismatch) > 0 then
        v_hold := 'legacy_identity_difference:' || array_to_string(v_mismatch, ',');
      end if;
    end if;

    if v_hold is null then
      v_occurred := (v_desired->>'occurred_at')::timestamptz;
      -- The legacy importer used a fixed +12 offset, so NZDT visits were stored one hour late.
      v_offset := (v_occurred at time zone 'Pacific/Auckland') - (v_occurred at time zone 'UTC');
      if not (v_event.occurred_at = v_occurred
              or (v_event.occurred_at = v_occurred + interval '1 hour' and v_offset = interval '13 hours')) then
        v_hold := 'legacy_time_difference_not_offset_artifact';
      end if;
    end if;

    if v_hold is null then
      -- A recorded source-leg correction keeps the sheet's original values; legacy rows that still hold
      -- those values are the same source facts, not a conflicting edit.
      v_source_leg := case when v_payload->'source_leg_correction'->>'rule' = 'formula_skipped_start_row'
          and coalesce(v_payload->'source_leg_correction'->>'job_kms', '') ~ '^-[0-9]+([.][0-9]+)?$'
        then v_payload->'source_leg_correction' end;
      v_distance := case when v_desired->'distance_km' is null or jsonb_typeof(v_desired->'distance_km') = 'null'
        then null else (v_desired->>'distance_km')::numeric end;
      if v_distance is not null and v_distance < 0 then
        v_hold := 'invalid_source_distance';
      elsif v_event.distance_km is not null and v_event.distance_km is distinct from v_distance
        and not (v_source_leg is not null and v_event.distance_km = (v_source_leg->>'job_kms')::numeric) then
        v_hold := 'legacy_distance_difference';
      end if;
    end if;

    if v_hold is null then
      select coalesce(array_agg(key order by key), '{}'::text[]) into v_mismatch
      from jsonb_each(coalesce(v_event.payload, '{}'::jsonb)) existing
      where jsonb_typeof(existing.value) <> 'null'
        and existing.value is distinct from v_payload->existing.key
        and not public.patrol_source_numeric_text_equal(existing.value, v_payload->existing.key)
        and not (coalesce(v_source_leg ? existing.key, false)
          and (existing.value = v_source_leg->existing.key
            or public.patrol_source_numeric_text_equal(existing.value, v_source_leg->existing.key)));
      if cardinality(v_mismatch) > 0 then
        v_hold := 'legacy_payload_difference:' || array_to_string(v_mismatch, ',');
      end if;
    end if;

    if v_hold is null then
      v_hold := public.patrol_source_event_dependency_hold(p_provider_organization_id, p_client_organization_id, v_id, v_ref, p_batch_id);
    end if;

    if v_hold is not null then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := v_hold;
      return next; continue;
    end if;

    v_before := public.patrol_source_record_state('event', v_id);
    update public.location_events event
    set occurred_at = v_occurred,
        distance_km = v_distance,
        payload = coalesce(event.payload, '{}'::jsonb) || v_payload
    where event.id = v_id;
    v_after := public.patrol_source_record_state('event', v_id);
    v_changed := public.patrol_source_state_diff(v_before, v_after);

    insert into public.patrol_import_record_versions(
      provider_organization_id, client_organization_id, record_kind, record_id, external_ref, source_profile,
      source_file, source_sheet, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
      version_no, change_kind, changed_fields, state_before, state_after, applied_by
    ) values (
      p_provider_organization_id, p_client_organization_id, 'event', v_id, v_ref, v_payload->>'classification_profile',
      v_payload->>'source_file', v_payload->>'source_sheet', (v_payload->>'source_row')::integer,
      v_payload->>'source_sha256', v_payload->>'derivative_sha256', v_item->>'source_fingerprint', p_batch_id,
      1, 'legacy_correction', v_changed, v_before, v_after, auth.uid()
    );

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (p_provider_organization_id, auth.uid(), 'patrol_legacy_source_corrected', 'location_events', v_id,
      jsonb_build_object('batch_id', p_batch_id, 'client_organization_id', p_client_organization_id,
        'external_ref', v_ref, 'changed_fields', to_jsonb(v_changed),
        'time_shift_seconds', extract(epoch from (v_before->>'occurred_at')::timestamptz - v_occurred),
        'source_file', v_payload->>'source_file', 'source_sheet', v_payload->>'source_sheet',
        'source_row', (v_payload->>'source_row')::integer, 'source_sha256', v_payload->>'source_sha256'));

    v_corrected := v_corrected + 1;
    external_ref := v_ref; record_id := v_id; outcome := 'corrected'; detail := array_to_string(v_changed, ',');
    return next;
  end loop;
end;
$$;
revoke all on function public.correct_legacy_patrol_source_records(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.correct_legacy_patrol_source_records(uuid, uuid, uuid, jsonb) to authenticated;

-- Items: { kind: 'event', external_ref, canonical_external_ref,
--          [desired, source_fingerprint] when the duplicate still exists in the batch's workbook }.
create or replace function public.supersede_duplicate_patrol_events(
  p_batch_id uuid,
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_items jsonb
)
returns table(external_ref text, record_id uuid, outcome text, detail text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_batch public.file_import_batches%rowtype;
  v_item jsonb;
  v_payload jsonb;
  v_ref text;
  v_canonical_ref text;
  v_event public.location_events%rowtype;
  v_canonical public.location_events%rowtype;
  v_version public.patrol_import_record_versions%rowtype;
  v_has_version boolean;
  v_shift numeric;
  v_mismatch text[];
  v_hold text;
begin
  v_batch := public.patrol_source_sync_batch(p_batch_id, p_provider_organization_id, p_client_organization_id);
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'Between 0 and 500 supersede rows are required per call';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_items) value order by value->>'external_ref'
  loop
    v_ref := nullif(btrim(v_item->>'external_ref'), '');
    v_canonical_ref := nullif(btrim(v_item->>'canonical_external_ref'), '');
    if v_item->>'kind' is distinct from 'event' or v_ref is null or v_canonical_ref is null or v_ref = v_canonical_ref then
      raise exception 'Supersede rows require an event reference and a different canonical reference';
    end if;
    v_payload := case when v_item ? 'desired' then public.patrol_source_assert_row_provenance(v_batch, v_item || jsonb_build_object(
      'record_id', coalesce(nullif(v_item->>'record_id', ''), '00000000-0000-0000-0000-000000000000'))) end;
    v_hold := null;
    perform pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text || ':evidence:' || least(v_ref, v_canonical_ref), 0));
    perform pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text || ':evidence:' || greatest(v_ref, v_canonical_ref), 0));

    if exists (select 1 from public.location_events_superseded archived
               where archived.client_organization_id = p_client_organization_id and archived.external_ref = v_ref) then
      external_ref := v_ref; record_id := null; outcome := 'already_superseded'; detail := null;
      return next; continue;
    end if;

    select * into v_event from public.location_events event
    where event.organization_id = p_client_organization_id and event.external_ref = v_ref
      and event.source = 'rm_patrol_log_import'
    for update;
    if not found then
      external_ref := v_ref; record_id := null; outcome := 'held'; detail := 'record_not_owned_by_importer';
      return next; continue;
    end if;
    select * into v_canonical from public.location_events event
    where event.organization_id = p_client_organization_id and event.external_ref = v_canonical_ref
      and event.source = 'rm_patrol_log_import'
    for update;
    if not found then
      v_hold := 'canonical_record_missing';
    end if;

    -- Only same-workbook duplicates qualify. Year sheets stay separate (owner ruling) and
    -- Update worksheet copies must go through the one-to-one paired path.
    if v_hold is null then
      v_hold := (select case
        when nullif(source->>'source_sheet', '') is null or nullif(v_canonical.payload->>'source_sheet', '') is null
          or nullif(source->>'source_sha256', '') is null
          or source->>'source_sha256' is distinct from v_canonical.payload->>'source_sha256'
          or source->>'source_file' is distinct from v_canonical.payload->>'source_file'
          then 'supersede_requires_same_workbook_provenance'
        when source->>'source_sheet' ~* '^update\M' then 'update_copy_requires_paired_path'
        when source->>'source_sheet' ~ '^[0-9]{4}$' then 'source_year_records_remain_separate'
      end from (select coalesce(v_payload, v_event.payload) as source) copy_source);
    end if;

    if v_hold is null then
      v_shift := extract(epoch from v_event.occurred_at - v_canonical.occurred_at);
      select coalesce(array_agg(field order by field), '{}'::text[]) into v_mismatch
      from (
        select 'zone_id' as field where v_event.zone_id is distinct from v_canonical.zone_id
        union all select 'site_id' where v_event.client_site_id is distinct from v_canonical.client_site_id
        union all select 'officer_id' where v_event.observed_entity_id is distinct from v_canonical.observed_entity_id
        union all select 'event_type' where v_event.event_type is distinct from v_canonical.event_type
        -- A visit-level copy (no issue status) may stand for any job row of the same visit.
        union all select 'status' where v_event.status is not null and v_event.status is distinct from v_canonical.status
        union all select 'comments' where nullif(btrim(v_event.payload->>'comments'), '') is distinct from nullif(btrim(v_canonical.payload->>'comments'), '')
        -- A copy may carry the legacy one-hour artifact on either side, but only in NZ daylight time.
        union all select 'occurred_at' where not (v_shift = 0 or (abs(v_shift) = 3600
          and public.patrol_nz_daylight(least(v_event.occurred_at, v_canonical.occurred_at))))
      ) compared;
      if cardinality(v_mismatch) > 0 then
        v_hold := 'not_an_identical_copy:' || array_to_string(v_mismatch, ',');
      end if;
    end if;

    if v_hold is null then
      v_hold := public.patrol_source_event_dependency_hold(p_provider_organization_id, p_client_organization_id, v_event.id, v_ref, p_batch_id);
    end if;

    if v_hold is null then
      select * into v_version from public.patrol_import_record_versions version
      where version.record_kind = 'event' and version.record_id = v_event.id and version.is_current
      for update;
      v_has_version := found;
      if v_has_version and v_version.external_ref <> v_ref then
        raise exception 'Source history scope does not match the requested record';
      end if;
    end if;

    if v_hold is not null then
      external_ref := v_ref; record_id := v_event.id; outcome := 'held'; detail := v_hold;
      return next; continue;
    end if;

    insert into public.location_events_superseded(
      provider_organization_id, client_organization_id, location_event_id, external_ref,
      canonical_location_event_id, canonical_external_ref, reason_code, batch_id, event_snapshot, superseded_by
    ) values (
      p_provider_organization_id, p_client_organization_id, v_event.id, v_ref,
      v_canonical.id, v_canonical_ref, 'duplicate_of_canonical_sheet', p_batch_id, to_jsonb(v_event), auth.uid()
    );

    if v_has_version or v_payload is not null then
      if v_has_version then
        update public.patrol_import_record_versions set is_current = false where id = v_version.id;
      end if;
      insert into public.patrol_import_record_versions(
        provider_organization_id, client_organization_id, record_kind, record_id, external_ref, source_profile,
        source_file, source_sheet, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
        version_no, change_kind, changed_fields, state_before, state_after, applied_by
      ) values (
        p_provider_organization_id, p_client_organization_id, 'event', v_event.id, v_ref,
        coalesce(v_payload->>'classification_profile', v_version.source_profile),
        coalesce(v_payload->>'source_file', v_version.source_file),
        case when v_payload is null then v_version.source_sheet else v_payload->>'source_sheet' end,
        coalesce((v_payload->>'source_row')::integer, v_version.source_row),
        coalesce(v_payload->>'source_sha256', v_version.source_sha256),
        coalesce(v_payload->>'derivative_sha256', v_version.derivative_sha256),
        coalesce(v_item->>'source_fingerprint', v_version.source_fingerprint), p_batch_id,
        case when v_has_version then v_version.version_no + 1 else 1 end, 'superseded', array['superseded'],
        public.patrol_source_record_state('event', v_event.id),
        jsonb_build_object('superseded_by_external_ref', v_canonical_ref, 'canonical_location_event_id', v_canonical.id),
        auth.uid()
      );
    end if;

    delete from public.location_events event where event.id = v_event.id;

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (p_provider_organization_id, auth.uid(), 'patrol_duplicate_event_superseded', 'location_events', v_event.id,
      jsonb_build_object('batch_id', p_batch_id, 'client_organization_id', p_client_organization_id,
        'external_ref', v_ref, 'canonical_external_ref', v_canonical_ref,
        'canonical_location_event_id', v_canonical.id, 'time_shift_seconds', v_shift));

    external_ref := v_ref; record_id := v_event.id; outcome := 'superseded'; detail := v_canonical_ref;
    return next;
  end loop;
end;
$$;
revoke all on function public.supersede_duplicate_patrol_events(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.supersede_duplicate_patrol_events(uuid, uuid, uuid, jsonb) to authenticated;

-- Applies one deterministic Update-sheet patch to its 2025 canonical event
-- and archives the matching Update copy in the same transaction.
create or replace function public.apply_dart_patrol_source_updates_and_supersede(
  p_canonical_batch_id uuid,
  p_update_batch_id uuid,
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_items jsonb
)
returns table(external_ref text, record_id uuid, outcome text, detail text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_canonical_batch public.file_import_batches%rowtype;
  v_update_batch public.file_import_batches%rowtype;
  v_item jsonb;
  v_canonical_item jsonb;
  v_update_item jsonb;
  v_update_desired jsonb;
  v_canonical_payload jsonb;
  v_update_payload jsonb;
  v_patch jsonb;
  v_ref text;
  v_copy_ref text;
  v_update_ref text;
  v_canonical_id uuid;
  v_copy_id uuid;
  v_canonical public.location_events%rowtype;
  v_copy public.location_events%rowtype;
  v_canonical_version public.patrol_import_record_versions%rowtype;
  v_copy_version public.patrol_import_record_versions%rowtype;
  v_archive public.location_events_superseded%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_copy_before jsonb;
  v_changed text[];
  v_shift numeric;
  v_hold text;
  v_field text;
  v_version_no integer;
  v_current_copy_version boolean;
  v_repeated_canonical text[];
  v_repeated_copy text[];
begin
  v_canonical_batch := public.patrol_source_sync_batch(
    p_canonical_batch_id, p_provider_organization_id, p_client_organization_id);
  v_update_batch := public.patrol_source_sync_batch(
    p_update_batch_id, p_provider_organization_id, p_client_organization_id);

  if v_canonical_batch.source_file is distinct from v_update_batch.source_file
     or v_canonical_batch.source_sha256 is distinct from v_update_batch.source_sha256
     or v_canonical_batch.manifest_json->>'source_profile' is distinct from v_update_batch.manifest_json->>'source_profile'
     or v_canonical_batch.manifest_json->>'source_sheet' is distinct from '2025'
     or v_update_batch.manifest_json->>'source_sheet' is distinct from 'Update 251215' then
    raise exception 'DART canonical and Update worksheet batches do not match';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'Between 0 and 500 DART Update rows are required per call';
  end if;

  -- An Update row must pair one canonical with one copy. Any repeat in the call makes every
  -- item it touches ambiguous, so none of them are written.
  select coalesce(array_agg(key), '{}') into v_repeated_canonical
  from (select value->'canonical'->>'record_id' key from jsonb_array_elements(p_items) value
        group by 1 having count(*) > 1) repeated;
  select coalesce(array_agg(key), '{}') into v_repeated_copy
  from (select value->>'copy_record_id' key from jsonb_array_elements(p_items) value
        group by 1 having count(*) > 1) repeated;

  for v_item in
    select value from jsonb_array_elements(p_items) value order by value->>'copy_external_ref'
  loop
    v_canonical_item := v_item->'canonical';
    v_canonical_payload := public.patrol_source_assert_row_provenance(v_canonical_batch, v_canonical_item);
    v_ref := v_canonical_item->>'external_ref';
    v_canonical_id := (v_canonical_item->>'record_id')::uuid;
    v_copy_ref := nullif(btrim(v_item->>'copy_external_ref'), '');
    v_copy_id := nullif(v_item->>'copy_record_id', '')::uuid;
    v_update_ref := nullif(btrim(v_item->>'update_external_ref'), '');
    v_update_desired := v_item->'update_desired';
    v_update_item := jsonb_build_object(
      'kind', 'event',
      'record_id', v_canonical_id,
      'external_ref', v_update_ref,
      'source_fingerprint', v_item->>'update_source_fingerprint',
      'desired', v_update_desired
    );
    v_update_payload := public.patrol_source_assert_row_provenance(v_update_batch, v_update_item);
    v_hold := null;

    if v_ref is null or v_copy_ref is null or v_update_ref is null or v_copy_id is null
       or v_ref = v_copy_ref or v_canonical_item->>'kind' is distinct from 'event'
       or coalesce(v_item->>'update_source_fingerprint', '') !~ '^[a-f0-9]{64}$' then
      raise exception 'DART Update rows require distinct canonical and copy references with source provenance';
    end if;
    if v_canonical_payload->>'source_sheet' is distinct from '2025'
       or v_update_payload->>'source_sheet' is distinct from 'Update 251215'
       or v_canonical_payload->>'source_file' is distinct from v_update_payload->>'source_file'
       or v_canonical_payload->>'source_sha256' is distinct from v_update_payload->>'source_sha256' then
      raise exception 'DART Update row provenance does not match the canonical workbook';
    end if;
    if jsonb_typeof(v_update_payload->'plates_found') is distinct from 'array'
       or nullif(btrim(v_update_payload->>'location_raw'), '') is null then
      raise exception 'DART Update row is missing a mapped source field';
    end if;
    if coalesce(v_item->>'record_fingerprint', '') !~ '^[a-f0-9]{64}$' then
      raise exception 'DART Update row is missing the reviewed record fingerprint';
    end if;
    if v_canonical_id::text = any(v_repeated_canonical) or v_copy_id::text = any(v_repeated_copy) then
      external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'held'; detail := 'ambiguous_update_pairing';
      return next; continue;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      p_client_organization_id::text || ':evidence:' || least(v_ref, v_copy_ref), 0));
    perform pg_advisory_xact_lock(hashtextextended(
      p_client_organization_id::text || ':evidence:' || greatest(v_ref, v_copy_ref), 0));

    select * into v_archive
    from public.location_events_superseded archived
    where archived.client_organization_id = p_client_organization_id
      and archived.external_ref = v_copy_ref;
    if found then
      select * into v_canonical_version
      from public.patrol_import_record_versions version
      where version.record_kind = 'event' and version.record_id = v_canonical_id and version.is_current;
      if v_archive.canonical_location_event_id = v_canonical_id
         and v_archive.canonical_external_ref = v_ref
         and v_archive.batch_id = p_update_batch_id
         and v_canonical_version.provider_organization_id = p_provider_organization_id
         and v_canonical_version.client_organization_id = p_client_organization_id
         and v_canonical_version.external_ref = v_ref
         and v_canonical_version.change_kind = 'update'
         and v_canonical_version.batch_id = p_update_batch_id
         and v_canonical_version.overlay_source->>'source_fingerprint' = v_item->>'update_source_fingerprint'
         and public.patrol_source_record_state('event', v_canonical_id) is not distinct from v_canonical_version.state_after then
        external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'already_applied'; detail := null;
      else
        external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'held'; detail := 'archive_or_update_history_mismatch';
      end if;
      return next; continue;
    end if;

    select * into v_canonical
    from public.location_events event
    where event.id = v_canonical_id and event.organization_id = p_client_organization_id
      and event.external_ref = v_ref and event.source = 'rm_patrol_log_import'
    for update;
    if not found then
      external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'held'; detail := 'canonical_record_missing';
      return next; continue;
    end if;
    select * into v_copy
    from public.location_events event
    where event.id = v_copy_id and event.organization_id = p_client_organization_id
      and event.external_ref = v_copy_ref and event.source = 'rm_patrol_log_import'
    for update;
    if not found then
      external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'held'; detail := 'source_copy_missing';
      return next; continue;
    end if;

    select * into v_canonical_version
    from public.patrol_import_record_versions version
    where version.record_kind = 'event' and version.record_id = v_canonical_id and version.is_current
    for update;
    if not found then
      external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'held'; detail := 'canonical_source_baseline_required';
      return next; continue;
    end if;
    if v_canonical_version.provider_organization_id <> p_provider_organization_id
       or v_canonical_version.client_organization_id <> p_client_organization_id
       or v_canonical_version.external_ref <> v_ref
       or v_canonical_version.source_sheet is distinct from '2025'
       or v_canonical_version.change_kind not in ('legacy_correction', 'update') then
      external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'held'; detail := 'canonical_source_identity_mismatch';
      return next; continue;
    end if;
    if v_canonical_version.change_kind = 'update' then
      external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'held'; detail := 'canonical_already_updated_from_another_source';
      return next; continue;
    end if;

    if v_canonical.payload->>'source_sheet' is distinct from '2025'
       or nullif(v_canonical.payload->>'job_number', '') is null
       or v_copy.payload->>'source_file' is distinct from v_update_payload->>'source_file'
       or v_copy.payload->>'source_sheet' is distinct from 'Update 251215'
       or v_copy.payload->>'source_row' is distinct from v_update_payload->>'source_row' then
      v_hold := 'source_copy_identity_mismatch';
    end if;

    v_before := public.patrol_source_record_state('event', v_canonical_id);
    if v_hold is null and v_before is distinct from v_canonical_version.state_after then
      v_hold := 'fcm_record_changed_since_last_sync';
    end if;
    if v_hold is null and (
      v_canonical.occurred_at is distinct from (v_update_desired->>'occurred_at')::timestamptz
      or v_canonical.zone_id is distinct from nullif(v_update_desired->>'zone_id', '')::uuid
      or v_canonical.client_site_id is distinct from nullif(v_update_desired->>'site_id', '')::uuid
      or v_canonical.observed_entity_id is distinct from nullif(v_update_desired->>'observed_entity_id', '')::uuid
      or v_canonical.observed_entity_type is distinct from v_update_desired->>'observed_entity_type'
      or v_canonical.event_type is distinct from v_update_desired->>'event_type'
      or nullif(btrim(v_canonical.payload->>'comments'), '') is distinct from nullif(btrim(v_update_payload->>'comments'), '')
    ) then
      v_hold := 'update_visit_identity_mismatch';
    end if;

    if v_hold is null then
      v_shift := extract(epoch from v_copy.occurred_at - v_canonical.occurred_at);
      if v_copy.zone_id is distinct from v_canonical.zone_id
         or v_copy.client_site_id is distinct from v_canonical.client_site_id
         or v_copy.observed_entity_id is distinct from v_canonical.observed_entity_id
         or v_copy.event_type is distinct from v_canonical.event_type
         or (v_copy.status is not null and v_copy.status is distinct from v_canonical.status)
         or nullif(btrim(v_copy.payload->>'comments'), '') is distinct from nullif(btrim(v_canonical.payload->>'comments'), '')
         -- The legacy artifact only ever made the copy one hour late, and only in NZ daylight time.
         or not (v_shift = 0 or (v_shift = 3600 and public.patrol_nz_daylight(v_canonical.occurred_at))) then
        v_hold := 'not_an_identical_copy';
      end if;
    end if;

    -- A second live Update copy of the same visit means the pairing is not one-to-one.
    if v_hold is null and exists (
      select 1
      from public.location_events other
      where other.organization_id = p_client_organization_id
        and other.source = 'rm_patrol_log_import'
        and other.id <> v_copy_id
        and other.id <> v_canonical_id
        and other.payload->>'source_sheet' = 'Update 251215'
        and other.zone_id is not distinct from v_canonical.zone_id
        and other.client_site_id is not distinct from v_canonical.client_site_id
        and other.observed_entity_id is not distinct from v_canonical.observed_entity_id
        and other.event_type is not distinct from v_canonical.event_type
        and (other.status is null or other.status is not distinct from v_canonical.status)
        and nullif(btrim(other.payload->>'comments'), '') is not distinct from nullif(btrim(v_canonical.payload->>'comments'), '')
        and (other.occurred_at = v_canonical.occurred_at
          or (other.occurred_at = v_canonical.occurred_at + interval '1 hour'
            and public.patrol_nz_daylight(v_canonical.occurred_at)))
    ) then
      v_hold := 'ambiguous_update_copy_group';
    end if;

    if v_hold is null then
      v_hold := public.patrol_source_event_dependency_hold(
        p_provider_organization_id, p_client_organization_id, v_canonical_id, v_ref, p_update_batch_id);
    end if;
    if v_hold is null then
      v_hold := public.patrol_source_event_dependency_hold(
        p_provider_organization_id, p_client_organization_id, v_copy_id, v_copy_ref, p_update_batch_id);
    end if;
    if v_hold is not null then
      external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'held'; detail := v_hold;
      return next; continue;
    end if;

    v_patch := jsonb_build_object('location_raw', v_update_payload->'location_raw');
    foreach v_field in array array['reserve_raw', 'source_category', 'comments', 'patroller_raw', 'plates_found']
    loop
      if v_update_payload ? v_field and v_update_payload->v_field not in ('null'::jsonb, '""'::jsonb) then
        v_patch := v_patch || jsonb_build_object(v_field, v_update_payload->v_field);
      end if;
    end loop;
    if (v_canonical.payload || v_patch) is not distinct from v_canonical.payload then
      external_ref := v_update_ref; record_id := v_canonical_id; outcome := 'held'; detail := 'no_source_update_difference';
      return next; continue;
    end if;

    v_copy_before := public.patrol_source_record_state('event', v_copy_id);
    update public.location_events event
    set payload = coalesce(event.payload, '{}'::jsonb) || v_patch
    where event.id = v_canonical_id;
    v_after := public.patrol_source_record_state('event', v_canonical_id);
    v_changed := public.patrol_source_state_diff(v_before, v_after);

    update public.patrol_import_record_versions
    set is_current = false
    where id = v_canonical_version.id;
    -- The canonical keeps its 2025 source identity so a later resync still recognises it;
    -- the Update row is recorded as an overlay with its own provenance.
    insert into public.patrol_import_record_versions(
      provider_organization_id, client_organization_id, record_kind, record_id, external_ref, source_profile,
      source_file, source_sheet, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
      version_no, change_kind, changed_fields, state_before, state_after, applied_by,
      record_fingerprint, overlay_source
    ) values (
      p_provider_organization_id, p_client_organization_id, 'event', v_canonical_id, v_ref,
      v_canonical_version.source_profile, v_canonical_version.source_file, v_canonical_version.source_sheet,
      v_canonical_version.source_row, v_canonical_version.source_sha256,
      v_canonical_version.derivative_sha256, v_canonical_version.source_fingerprint, p_update_batch_id,
      v_canonical_version.version_no + 1, 'update', v_changed, v_before, v_after, auth.uid(),
      v_item->>'record_fingerprint',
      jsonb_build_object(
        'external_ref', v_update_ref,
        'source_file', v_update_payload->>'source_file',
        'source_sheet', v_update_payload->>'source_sheet',
        'source_row', (v_update_payload->>'source_row')::integer,
        'source_sha256', v_update_payload->>'source_sha256',
        'derivative_sha256', v_update_payload->>'derivative_sha256',
        'source_fingerprint', v_item->>'update_source_fingerprint',
        'batch_id', p_update_batch_id)
    );

    select * into v_copy_version
    from public.patrol_import_record_versions version
    where version.record_kind = 'event' and version.record_id = v_copy_id and version.is_current
    for update;
    v_current_copy_version := found;
    if v_current_copy_version and (
      v_copy_version.provider_organization_id <> p_provider_organization_id
      or v_copy_version.client_organization_id <> p_client_organization_id
      or v_copy_version.external_ref <> v_copy_ref
    ) then
      raise exception 'Source history scope does not match the DART Update copy';
    end if;
    if v_current_copy_version then
      update public.patrol_import_record_versions set is_current = false where id = v_copy_version.id;
      v_version_no := v_copy_version.version_no + 1;
    else
      v_version_no := 1;
    end if;
    insert into public.location_events_superseded(
      provider_organization_id, client_organization_id, location_event_id, external_ref,
      canonical_location_event_id, canonical_external_ref, reason_code, batch_id, event_snapshot, superseded_by
    ) values (
      p_provider_organization_id, p_client_organization_id, v_copy_id, v_copy_ref,
      v_canonical_id, v_ref, 'duplicate_of_canonical_sheet', p_update_batch_id, to_jsonb(v_copy), auth.uid()
    );
    insert into public.patrol_import_record_versions(
      provider_organization_id, client_organization_id, record_kind, record_id, external_ref, source_profile,
      source_file, source_sheet, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
      version_no, change_kind, changed_fields, state_before, state_after, applied_by
    ) values (
      p_provider_organization_id, p_client_organization_id, 'event', v_copy_id, v_copy_ref,
      v_update_payload->>'classification_profile', v_update_payload->>'source_file', v_update_payload->>'source_sheet',
      (v_update_payload->>'source_row')::integer, v_update_payload->>'source_sha256',
      v_update_payload->>'derivative_sha256', v_item->>'update_source_fingerprint', p_update_batch_id,
      v_version_no, 'superseded', array['superseded'], v_copy_before,
      jsonb_build_object('superseded_by_external_ref', v_ref, 'canonical_location_event_id', v_canonical_id), auth.uid()
    );
    delete from public.location_events event where event.id = v_copy_id;

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (p_provider_organization_id, auth.uid(), 'dart_update_row_applied_and_copy_archived',
      'location_events', v_canonical_id,
      jsonb_build_object('canonical_external_ref', v_ref, 'update_external_ref', v_update_ref,
        'copy_external_ref', v_copy_ref, 'canonical_batch_id', p_canonical_batch_id,
        'update_batch_id', p_update_batch_id, 'source_sheet', v_update_payload->>'source_sheet',
        'source_row', (v_update_payload->>'source_row')::integer, 'changed_fields', to_jsonb(v_changed)));

    external_ref := v_update_ref; record_id := v_canonical_id;
    outcome := 'updated_and_superseded'; detail := array_to_string(v_changed, ',');
    return next;
  end loop;
end;
$$;
revoke all on function public.apply_dart_patrol_source_updates_and_supersede(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.apply_dart_patrol_source_updates_and_supersede(uuid, uuid, uuid, uuid, jsonb) to authenticated;
