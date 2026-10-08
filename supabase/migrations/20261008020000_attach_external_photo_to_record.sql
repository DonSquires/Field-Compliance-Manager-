-- Governed attachment of an externally supplied photo to a logged record (patrol visit / vehicle sighting).
-- External photos have unverified provenance, so they are never court-ready on arrival; sealing stays a separate act.
CREATE OR REPLACE FUNCTION public.attach_external_photo_to_record(
  p_record_kind text,
  p_record_id uuid,
  p_storage_path text,
  p_sha256 text,
  p_description text DEFAULT NULL,
  p_source_note text DEFAULT NULL,
  p_original_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_user uuid := auth.uid();
  v_org uuid;
  v_event_id uuid;
  v_evidence_id uuid;
  v_path text := nullif(trim(coalesce(p_storage_path, '')), '');
  v_hash text := lower(nullif(trim(coalesce(p_sha256, '')), ''));
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_record_kind not in ('location_event', 'observation') then raise exception 'Unsupported record kind %', p_record_kind; end if;
  if v_path is null then raise exception 'storage_path is required'; end if;
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then raise exception 'A SHA-256 hash of the file is required'; end if;

  if p_record_kind = 'location_event' then
    select e.organization_id, e.id into v_org, v_event_id from public.location_events e where e.id = p_record_id;
  else
    select o.organization_id into v_org from public.observations o where o.id = p_record_id;
  end if;
  if v_org is null then raise exception 'Record not found'; end if;
  if not public.org_access_allowed(v_org) then raise exception 'Not permitted to add evidence to this record'; end if;

  -- The object must live in the record's own organisation folder so storage policies and audit agree on ownership.
  if position('org/' || v_org::text || '/record-evidence/' in v_path) <> 1 then
    raise exception 'Evidence must be stored under org/%/record-evidence/', v_org;
  end if;

  insert into public.evidence_items (
    organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at,
    sha256_hash, is_court_ready, retention_class, location_event_id, metadata
  ) values (
    v_org, 'record_review', 'photo', v_path, v_user, clock_timestamp(),
    v_hash, false, 'policy_defined', v_event_id,
    jsonb_strip_nulls(jsonb_build_object(
      'provenance', 'external',
      'record_kind', p_record_kind,
      'record_id', p_record_id,
      'observation_id', case when p_record_kind = 'observation' then p_record_id end,
      'description', nullif(trim(coalesce(p_description, '')), ''),
      'source_note', nullif(trim(coalesce(p_source_note, '')), ''),
      'original_name', nullif(trim(coalesce(p_original_name, '')), '')
    ))
  ) returning id into v_evidence_id;

  if p_record_kind = 'observation' then
    insert into public.observation_supporting_evidence (organization_id, observation_id, evidence_kind, storage_bucket, storage_path, notes, created_by)
    values (v_org, p_record_id, 'external_photo', 'bob-uploads', v_path, nullif(trim(coalesce(p_description, '')), ''), v_user);
  end if;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_org, v_user, 'external_photo_attached', 'evidence_items', v_evidence_id,
    jsonb_build_object('record_kind', p_record_kind, 'record_id', p_record_id, 'sha256_hash', v_hash, 'storage_path', v_path));

  return v_evidence_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.attach_external_photo_to_record(text, uuid, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_external_photo_to_record(text, uuid, text, text, text, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.attach_external_photo_to_record(text, uuid, text, text, text, text, text) IS
  'Registers an externally supplied photo against a location_event or observation. Always provenance=external and not court-ready; audit-logged.';
