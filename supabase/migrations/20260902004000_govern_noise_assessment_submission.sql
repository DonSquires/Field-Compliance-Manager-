alter table public.noise_assessments
  add column if not exists client_request_id uuid;

create unique index if not exists noise_assessments_org_client_request_uidx
  on public.noise_assessments (organization_id, client_request_id)
  where client_request_id is not null;

create or replace function public.submit_noise_assessment(
  p_client_request_id uuid,
  p_payload jsonb
)
returns table(assessment_id uuid, created boolean, assessed_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_existing public.noise_assessments%rowtype;
  v_item public.noise_assessments%rowtype;
  v_action text := nullif(trim(coalesce(p_payload->>'action', '')), '');
  v_volume smallint;
  v_time smallint;
  v_tone smallint;
  v_total smallint;
  v_hs jsonb := coalesce(p_payload->'hs_checklist_items', '[]'::jsonb);
  v_assessment_photos jsonb := coalesce(p_payload->'photo_assessment_point', '[]'::jsonb);
  v_source_photos jsonb := coalesce(p_payload->'photo_source_address', '[]'::jsonb);
  v_service_photos jsonb := coalesce(p_payload->'photo_service_evidence', '[]'::jsonb);
  v_received_at timestamptz;
  v_arrived_at timestamptz;
  v_departed_at timestamptz;
  v_arrival_lat double precision;
  v_arrival_lng double precision;
  v_assessment_lat double precision;
  v_assessment_lng double precision;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'Noise assessment payload is required'; end if;

  select u.* into v_profile
  from public.user_profiles u
  where u.id = v_actor and u.deactivated_at is null;
  if not found or v_profile.role not in ('officer', 'admin_officer', 'admin', 'master', 'grand_master') then
    raise exception 'Active Noise Control officer required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));
  select n.* into v_existing
  from public.noise_assessments n
  where n.organization_id = v_profile.organization_id
    and n.client_request_id = p_client_request_id;
  if found then
    return query select v_existing.id, false, v_existing.assessed_at;
    return;
  end if;

  if v_action not in ('no_noise', 'acceptable', 'verbal_warning') then
    raise exception 'END and seizure actions require the governed enforcement workflow';
  end if;

  begin
    v_volume := (p_payload->>'volume_score')::smallint;
    v_tone := (p_payload->>'tone_score')::smallint;
    v_time := case when v_volume = 0 then null else (p_payload->>'time_score')::smallint end;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'TDC scores must be valid numbers';
  end;
  if v_volume not between 0 and 4 or v_tone not between 0 and 2 or (v_volume <> 0 and v_time not between 1 and 4) then
    raise exception 'TDC scores are outside the accepted range';
  end if;
  v_total := v_volume + coalesce(v_time, 0) + v_tone;
  if (v_action = 'no_noise' and v_total <> 0)
    or (v_action = 'acceptable' and (v_total < 1 or v_total >= 5))
    or (v_action = 'verbal_warning' and v_total < 5) then
    raise exception 'Selected action does not match the TDC matrix result';
  end if;

  if jsonb_typeof(v_hs) <> 'array' or jsonb_array_length(v_hs) < 5
    or exists (select 1 from jsonb_array_elements(v_hs) item where item <> 'true'::jsonb) then
    raise exception 'All Health and Safety confirmations are required';
  end if;
  if jsonb_typeof(v_assessment_photos) <> 'array' or jsonb_array_length(v_assessment_photos) = 0 then
    raise exception 'Assessment-point evidence photo is required';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_assessment_photos || v_source_photos || v_service_photos) photo
    where coalesce(photo->>'storage_bucket', '') <> 'scans'
      or coalesce(photo->>'storage_path', '') not like 'org/' || v_profile.organization_id::text || '/noise/' || p_client_request_id::text || '/%'
  ) then
    raise exception 'Noise evidence path is outside the authorized case';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_assessment_photos || v_source_photos || v_service_photos) photo
    left join storage.objects object
      on object.bucket_id = 'scans' and object.name = photo->>'storage_path'
    where object.id is null
  ) then
    raise exception 'Noise evidence object does not exist';
  end if;

  if nullif(trim(coalesce(p_payload->>'noise_source', '')), '') is null
    or nullif(trim(coalesce(p_payload->>'scene_description', '')), '') is null
    or nullif(trim(coalesce(p_payload->>'incident_report_text', '')), '') is null
    or nullif(trim(coalesce(p_payload->>'complaint_address', '')), '') is null
    or nullif(trim(coalesce(p_payload->>'noise_source_address', '')), '') is null
    or nullif(trim(coalesce(p_payload->>'assessment_location', '')), '') is null then
    raise exception 'Source, addresses, assessment location, scene description, and incident report are required';
  end if;
  if p_payload->>'received_at' is null or p_payload->>'arrived_at' is null or p_payload->>'departed_at' is null then
    raise exception 'Complaint, arrival, and departure times are required';
  end if;
  if (p_payload->>'arrival_gps_lat') is null or (p_payload->>'arrival_gps_lng') is null
    or (p_payload->>'assessment_gps_lat') is null or (p_payload->>'assessment_gps_lng') is null then
    raise exception 'Arrival and assessment GPS are required';
  end if;
  begin
    v_received_at := (p_payload->>'received_at')::timestamptz;
    v_arrived_at := (p_payload->>'arrived_at')::timestamptz;
    v_departed_at := (p_payload->>'departed_at')::timestamptz;
    v_arrival_lat := (p_payload->>'arrival_gps_lat')::double precision;
    v_arrival_lng := (p_payload->>'arrival_gps_lng')::double precision;
    v_assessment_lat := (p_payload->>'assessment_gps_lat')::double precision;
    v_assessment_lng := (p_payload->>'assessment_gps_lng')::double precision;
  exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
    raise exception 'Timestamps and GPS coordinates must be valid values';
  end;
  if v_received_at > v_arrived_at or v_arrived_at > v_departed_at
    or v_departed_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'Complaint, arrival, and departure times are out of sequence';
  end if;
  if v_arrival_lat not between -90 and 90 or v_assessment_lat not between -90 and 90
    or v_arrival_lng not between -180 and 180 or v_assessment_lng not between -180 and 180 then
    raise exception 'GPS coordinates are outside the accepted range';
  end if;

  insert into public.noise_assessments (
    organization_id, officer_user_id, officer_id, officer_name, client_request_id, job_number,
    noise_source, scene_description, incident_report_text, action, action_taken,
    volume_score, time_score, tone_score, matrix_total, decibel_reading,
    received_at, arrived_at, departed_at, complaint_address, noise_source_address,
    assessment_location, arrival_gps_lat, arrival_gps_lng, arrival_gps_accuracy,
    assessment_gps_lat, assessment_gps_lng, assessment_gps_accuracy,
    hs_checklist_completed, hs_checklist_items, photo_assessment_point,
    photo_source_address, photo_service_evidence, photo_urls, follow_up_required, status
  ) values (
    v_profile.organization_id, v_actor, v_actor, coalesce(nullif(trim(v_profile.display_name), ''), v_profile.email), p_client_request_id,
    public.generate_noise_job_number(),
    trim(p_payload->>'noise_source'), trim(p_payload->>'scene_description'), trim(p_payload->>'incident_report_text'), v_action,
    case v_action when 'no_noise' then 'no_action' when 'acceptable' then 'no_action' else 'verbal_warning' end,
    v_volume, v_time, v_tone, v_total, nullif(p_payload->>'decibel_reading', '')::real,
    v_received_at, v_arrived_at, v_departed_at,
    trim(p_payload->>'complaint_address'), trim(p_payload->>'noise_source_address'), trim(p_payload->>'assessment_location'),
    v_arrival_lat, v_arrival_lng, nullif(p_payload->>'arrival_gps_accuracy', '')::real,
    v_assessment_lat, v_assessment_lng, nullif(p_payload->>'assessment_gps_accuracy', '')::real,
    true, v_hs, v_assessment_photos, v_source_photos, v_service_photos,
    v_assessment_photos || v_source_photos || v_service_photos,
    coalesce((p_payload->>'follow_up_required')::boolean, false), 'open'
  ) returning * into v_item;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_item.organization_id, v_actor, 'noise_assessment_submitted', 'noise_assessments', v_item.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'matrix_total', v_total, 'action', v_action));

  return query select v_item.id, true, v_item.assessed_at;
end;
$$;

revoke insert, update, delete on table public.noise_assessments from public, anon, authenticated;
revoke all on function public.submit_noise_assessment(uuid, jsonb) from public, anon;
grant execute on function public.submit_noise_assessment(uuid, jsonb) to authenticated, service_role;