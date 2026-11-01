-- Source-truth artifact correction for imported patrol observations and events.
--
-- Owner ruling (2026-10-30): R&M's patrol workbooks are verified truth and the
-- source of truth until R&M operate inside FCM. Records already imported from
-- them must agree with the sheet.
--
-- Evidence (rolled-back read of every R&M workbook, 2026-10-30): about 11,000
-- imported rows were held as initial_difference_requires_review. The differences
-- are almost entirely the known artifacts of the 2026-09-23 importer that
-- correct_legacy_patrol_source_records already repairs for provenance-free
-- events:
--   * a fixed +12 offset, so NZDT visits were stored one hour late;
--   * job_time_hours written at 15 significant digits;
--   * distance_km never filled;
--   * source keys and classification added by later importer versions.
-- They were held only because the record was an observation, or because it
-- already carried provenance for the same workbook and sheet from an earlier
-- version without a recorded baseline.
--
-- This replaces correct_legacy_patrol_source_records (same signature, same
-- caller) so it also corrects:
--   * observations (time, distance and import payload; its observation_trigger
--     context event moves with it while it still carries the old time);
--   * records whose provenance names the same file and sheet.
-- Everything else is still held: identity differences (place, officer, plate,
-- notes, event type, status), time differences that are not the NZDT artifact,
-- conflicting distances, conflicting payload values, locked evidence, invoiced
-- records, finance-linked records whose local service date would move, open
-- import reviews and (for events) records linked from other tables. Each
-- correction writes version 1
-- (change_kind legacy_correction) with the before and after state, and an
-- audit entry.

-- Why an imported record may not be corrected: invoiced, finance-linked when the
-- correction would move its local service date, under an open import review, or
-- (events) linked from another table. Null when clear. Uninvoiced finance cost rows
-- carry the record's local service date and amounts, so a correction that keeps
-- that date leaves them true. Evidence links (photos) attach to the observation id,
-- which a correction never changes, so they do not block it.
create or replace function public.patrol_source_correction_dependency_hold(
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_kind text,
  p_record_id uuid,
  p_external_ref text,
  p_batch_id uuid,
  p_service_date_unchanged boolean
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
  if not coalesce(p_service_date_unchanged, false) and exists (
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
  if p_kind = 'event' then
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
        into v_linked using p_record_id;
      if v_linked then
        return 'linked_record:' || v_fk.table_name::text;
      end if;
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function public.patrol_source_correction_dependency_hold(uuid, uuid, text, uuid, text, uuid, boolean) from public, anon, authenticated, service_role;

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
  v_kind text;
  v_ref text;
  v_id uuid;
  v_event public.location_events%rowtype;
  v_observation public.observations%rowtype;
  v_existing jsonb;
  v_stored_at timestamptz;
  v_stored_distance numeric;
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
  v_context_moved integer;
  -- Provenance from an earlier workbook version is replaced, not compared.
  v_provenance constant text[] := array['source', 'source_file', 'source_sheet', 'source_row', 'source_sha256',
    'derivative_sha256', 'classification_profile'];
begin
  v_batch := public.patrol_source_sync_batch(p_batch_id, p_provider_organization_id, p_client_organization_id);
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 500 then
    raise exception 'Between 0 and 500 legacy correction rows are required per call';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_records) value order by value->>'kind', value->>'external_ref'
  loop
    v_payload := public.patrol_source_assert_row_provenance(v_batch, v_item);
    v_kind := v_item->>'kind';
    if v_kind is null or v_kind not in ('event', 'observation') then
      raise exception 'Legacy correction applies to patrol events and observations only';
    end if;
    v_ref := v_item->>'external_ref';
    v_id := (v_item->>'record_id')::uuid;
    v_desired := v_item->'desired';
    v_hold := null;
    perform pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text || ':evidence:' || v_ref, 0));

    if v_kind = 'event' then
      select * into v_event from public.location_events event
      where event.id = v_id and event.organization_id = p_client_organization_id
        and event.external_ref = v_ref and event.source = 'rm_patrol_log_import'
      for update;
      if found then
        v_existing := coalesce(v_event.payload, '{}'::jsonb);
        v_stored_at := v_event.occurred_at;
        v_stored_distance := v_event.distance_km;
      end if;
    else
      select * into v_observation from public.observations observation
      where observation.id = v_id and observation.organization_id = p_client_organization_id
        and observation.external_refs->>'external_ref' = v_ref
        and coalesce(observation.external_refs->'import'->>'source', 'rm_patrol_log_import') = 'rm_patrol_log_import'
      for update;
      if found then
        v_existing := coalesce(v_observation.external_refs->'import', '{}'::jsonb);
        v_stored_at := v_observation.observed_at;
        v_stored_distance := v_observation.distance_km;
      end if;
    end if;
    if not found then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := 'record_not_owned_by_importer';
      return next; continue;
    end if;

    select * into v_version from public.patrol_import_record_versions version
    where version.record_kind = v_kind and version.record_id = v_id and version.is_current;
    if found then
      external_ref := v_ref; record_id := v_id;
      if v_version.change_kind = 'legacy_correction' and v_version.source_fingerprint = v_item->>'source_fingerprint' then
        outcome := 'already_current'; detail := null;
      else
        outcome := 'held'; detail := 'source_history_already_recorded';
      end if;
      return next; continue;
    end if;

    -- Provenance-free (pre-provenance import) or already naming this same workbook and sheet.
    if (nullif(v_existing->>'source_file', '') is not null and v_existing->>'source_file' is distinct from v_payload->>'source_file')
       or (nullif(v_existing->>'source_sheet', '') is not null and v_existing->>'source_sheet' is distinct from v_payload->>'source_sheet') then
      v_hold := 'existing_source_identity_mismatch';
    end if;

    if v_hold is null and v_kind = 'observation' and v_observation.locked_at is not null then
      v_hold := 'locked_evidence_requires_correction_review';
    end if;

    if v_hold is null then
      if v_kind = 'event' then
        select coalesce(array_agg(field order by field), '{}'::text[]) into v_mismatch
        from (
          select 'zone_id' as field where v_event.zone_id is distinct from nullif(v_desired->>'zone_id', '')::uuid
          union all select 'site_id' where v_event.client_site_id is distinct from nullif(v_desired->>'site_id', '')::uuid
          union all select 'officer_id' where v_event.observed_entity_id is distinct from nullif(v_desired->>'observed_entity_id', '')::uuid
          union all select 'observed_entity_type' where v_event.observed_entity_type is distinct from v_desired->>'observed_entity_type'
          union all select 'event_type' where v_event.event_type is distinct from v_desired->>'event_type'
          union all select 'status' where v_event.status is distinct from v_desired->>'status'
        ) identity_fields;
      else
        select coalesce(array_agg(field order by field), '{}'::text[]) into v_mismatch
        from (
          select 'zone_id' as field where v_observation.zone_id is distinct from nullif(v_desired->>'zone_id', '')::uuid
          union all select 'site_id' where v_observation.site_id is distinct from nullif(v_desired->>'site_id', '')::uuid
          union all select 'officer_id' where v_observation.officer_id is distinct from nullif(v_desired->>'officer_id', '')::uuid
          union all select 'plate' where upper(v_observation.plate_number) is distinct from upper(v_desired->>'plate')
          union all select 'officer_notes' where v_observation.officer_notes is distinct from v_desired->>'officer_notes'
        ) identity_fields;
      end if;
      if cardinality(v_mismatch) > 0 then
        v_hold := 'legacy_identity_difference:' || array_to_string(v_mismatch, ',');
      end if;
    end if;

    if v_hold is null then
      v_occurred := (v_desired->>'occurred_at')::timestamptz;
      -- The legacy importer used a fixed +12 offset, so NZDT visits were stored one hour late.
      v_offset := (v_occurred at time zone 'Pacific/Auckland') - (v_occurred at time zone 'UTC');
      if not (v_stored_at = v_occurred
              or (v_stored_at = v_occurred + interval '1 hour' and v_offset = interval '13 hours')) then
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
      elsif v_stored_distance is not null and v_stored_distance is distinct from v_distance
        and not (v_source_leg is not null and v_stored_distance = (v_source_leg->>'job_kms')::numeric) then
        v_hold := 'legacy_distance_difference';
      end if;
    end if;

    if v_hold is null then
      -- Stored values must equal the sheet (numerically for legacy text numbers); objects may only
      -- have gained keys. Null or missing stored values are filled from the sheet.
      select coalesce(array_agg(key order by key), '{}'::text[]) into v_mismatch
      from jsonb_each(v_existing) existing
      where existing.key <> all (v_provenance)
        and jsonb_typeof(existing.value) <> 'null'
        and existing.value is distinct from v_payload->existing.key
        and not public.patrol_source_numeric_text_equal(existing.value, v_payload->existing.key)
        and not (jsonb_typeof(existing.value) = 'object' and jsonb_typeof(v_payload->existing.key) = 'object'
          and (v_payload->existing.key) @> existing.value)
        and not (coalesce(v_source_leg ? existing.key, false)
          and (existing.value = v_source_leg->existing.key
            or public.patrol_source_numeric_text_equal(existing.value, v_source_leg->existing.key)));
      if cardinality(v_mismatch) > 0 then
        v_hold := 'legacy_payload_difference:' || array_to_string(v_mismatch, ',');
      end if;
    end if;

    if v_hold is null then
      v_hold := public.patrol_source_correction_dependency_hold(
        p_provider_organization_id, p_client_organization_id, v_kind, v_id, v_ref, p_batch_id,
        (v_stored_at at time zone 'Pacific/Auckland')::date = (v_occurred at time zone 'Pacific/Auckland')::date);
    end if;

    if v_hold is not null then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := v_hold;
      return next; continue;
    end if;

    v_before := public.patrol_source_record_state(v_kind, v_id);
    v_context_moved := 0;
    if v_kind = 'event' then
      update public.location_events event
      set occurred_at = v_occurred,
          distance_km = v_distance,
          payload = coalesce(event.payload, '{}'::jsonb) || v_payload
      where event.id = v_id;
    else
      update public.observations observation
      set observed_at = v_occurred,
          distance_km = v_distance,
          external_refs = jsonb_set(coalesce(observation.external_refs, '{}'::jsonb), '{import}',
            coalesce(observation.external_refs->'import', '{}'::jsonb) || v_payload, true)
      where observation.id = v_id;
      -- The observation's timeline context event was written from the same stored time.
      update public.location_events context_event
      set occurred_at = v_occurred
      where context_event.organization_id = p_client_organization_id
        and context_event.source = 'observation_trigger'
        and context_event.external_ref = v_id::text
        and context_event.occurred_at = v_stored_at;
      get diagnostics v_context_moved = row_count;
    end if;
    v_after := public.patrol_source_record_state(v_kind, v_id);
    v_changed := public.patrol_source_state_diff(v_before, v_after);

    insert into public.patrol_import_record_versions(
      provider_organization_id, client_organization_id, record_kind, record_id, external_ref, source_profile,
      source_file, source_sheet, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
      version_no, change_kind, changed_fields, state_before, state_after, applied_by
    ) values (
      p_provider_organization_id, p_client_organization_id, v_kind, v_id, v_ref, v_payload->>'classification_profile',
      v_payload->>'source_file', v_payload->>'source_sheet', (v_payload->>'source_row')::integer,
      v_payload->>'source_sha256', v_payload->>'derivative_sha256', v_item->>'source_fingerprint', p_batch_id,
      1, 'legacy_correction', v_changed, v_before, v_after, auth.uid()
    );

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (p_provider_organization_id, auth.uid(), 'patrol_legacy_source_corrected',
      case v_kind when 'event' then 'location_events' else 'observations' end, v_id,
      jsonb_build_object('batch_id', p_batch_id, 'client_organization_id', p_client_organization_id,
        'record_kind', v_kind, 'external_ref', v_ref, 'changed_fields', to_jsonb(v_changed),
        'time_shift_seconds', extract(epoch from (v_before->>'occurred_at')::timestamptz - v_occurred),
        'context_events_moved', v_context_moved,
        'finance_cost_rows_linked', (select count(*) from public.file_import_finance_cost_rows cost_row
          where cost_row.client_organization_id = p_client_organization_id and cost_row.evidence_external_ref = v_ref),
        'prior_source_sha256', v_existing->>'source_sha256',
        'source_file', v_payload->>'source_file', 'source_sheet', v_payload->>'source_sheet',
        'source_row', (v_payload->>'source_row')::integer, 'source_sha256', v_payload->>'source_sha256',
        'ruling', 'R&M workbooks are verified source truth (owner ruling 2026-10-30)'));

    external_ref := v_ref; record_id := v_id; outcome := 'corrected'; detail := array_to_string(v_changed, ',');
    return next;
  end loop;
end;
$$;
revoke all on function public.correct_legacy_patrol_source_records(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.correct_legacy_patrol_source_records(uuid, uuid, uuid, jsonb) to authenticated;
