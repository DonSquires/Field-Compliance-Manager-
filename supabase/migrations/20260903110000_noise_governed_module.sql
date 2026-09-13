-- ============================================================
-- Migration 20260903110000 — Governed Noise Control Module Submission & Idempotency
-- ============================================================
-- Issue #96: Idempotent governed noise control submission RPC, RLS hardening,
-- matrix calculation validation, and audit provenance.

-- 1. Add client_request_id for idempotency
alter table public.noise_assessments
  add column if not exists client_request_id uuid;

create unique index if not exists idx_na_org_officer_request
  on public.noise_assessments (organization_id, officer_user_id, client_request_id)
  where client_request_id is not null;

-- 2. Revoke direct inserts from authenticated / anon (require RPC)
revoke insert on table public.noise_assessments from authenticated, anon;

-- 3. Idempotent governed submission RPC
create or replace function public.submit_officer_noise_assessment(
  p_client_request_id uuid,
  p_assessed_at timestamptz,
  p_noise_source text,
  p_noise_source_address text,
  p_action_taken text DEFAULT 'no_action',
  p_volume_score smallint DEFAULT 0,
  p_time_score smallint DEFAULT 1,
  p_tone_score smallint DEFAULT 0,
  p_complaint_address text DEFAULT NULL,
  p_complainant_site_id uuid DEFAULT NULL,
  p_notice_number text DEFAULT NULL,
  p_end_number text DEFAULT NULL,
  p_occupant_name text DEFAULT NULL,
  p_occupant_dob date DEFAULT NULL,
  p_is_large_event_or_commercial boolean DEFAULT false,
  p_police_requested boolean DEFAULT false,
  p_police_present boolean DEFAULT false,
  p_scene_description text DEFAULT NULL,
  p_incident_report_text text DEFAULT NULL,
  p_follow_up_required boolean DEFAULT false,
  p_shift_id uuid DEFAULT NULL,
  p_dispatch_job_id uuid DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL
) returns table (
  id uuid,
  created boolean,
  received_at timestamptz,
  review_status text,
  matrix_total smallint
) language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_existing public.noise_assessments%rowtype;
  v_assessment public.noise_assessments%rowtype;
  v_matrix_total smallint;
  v_threshold smallint := 5;
  v_excessive boolean;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null and p.role in ('officer', 'admin_officer', 'admin', 'master', 'grand_master');
  if v_org_id is null then raise exception 'Active officer profile required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;

  if p_assessed_at is null or p_assessed_at > now() + interval '5 minutes' or p_assessed_at < now() - interval '24 hours' then
    raise exception 'assessed_at is outside the accepted capture window';
  end if;

  if nullif(trim(coalesce(p_noise_source_address, '')), '') is null then
    raise exception 'Noise source address is required';
  end if;

  if nullif(trim(coalesce(p_noise_source, '')), '') is null then
    raise exception 'Noise source type is required';
  end if;

  if p_volume_score not between 0 and 4 then raise exception 'Volume score must be between 0 and 4'; end if;
  if p_time_score not between 1 and 4 then raise exception 'Time score must be between 1 and 4'; end if;
  if p_tone_score not between 0 and 2 then raise exception 'Tone score must be between 0 and 2'; end if;

  v_matrix_total := coalesce(p_volume_score, 0) + coalesce(p_time_score, 1) + coalesce(p_tone_score, 0);

  -- Resolve the authoritative current/effective organization matrix row.
  select n.excessive_threshold into v_threshold
  from public.noise_module_config n
  where n.organization_id = v_org_id
    and n.is_current
    and n.effective_from <= current_date
    and (n.effective_to is null or n.effective_to >= current_date)
  order by n.effective_from desc, n.version desc
  limit 1;
  if v_threshold is null then v_threshold := 5; end if;

  v_excessive := (v_matrix_total >= v_threshold);

  if p_action_taken in ('abatement_notice', 'direction_notice', 'enforcement_notice', 'equipment_seized') and nullif(trim(coalesce(p_notice_number, coalesce(p_end_number, ''))), '') is null then
    raise exception 'Notice or END number is required for statutory noise enforcement actions';
  end if;

  if p_shift_id is not null and not exists (select 1 from public.shifts s where s.id = p_shift_id and s.organization_id = v_org_id) then
    raise exception 'Shift does not belong to the officer organisation';
  end if;

  if p_dispatch_job_id is not null and not exists (select 1 from public.dispatch_jobs d where d.id = p_dispatch_job_id and d.organization_id = v_org_id) then
    raise exception 'Dispatch job does not belong to the officer organisation';
  end if;

  -- Idempotency check
  select n.* into v_existing from public.noise_assessments n
    where n.organization_id = v_org_id and n.officer_user_id = v_user_id and n.client_request_id = p_client_request_id;
  if found then
    return query select v_existing.id, false, v_existing.created_at, v_existing.review_status, v_existing.matrix_total;
    return;
  end if;

  insert into public.noise_assessments (
    organization_id, officer_user_id, officer_id, client_request_id, assessed_at,
    noise_source, noise_source_address, assessment_location, action_taken, action,
    volume_score, time_score, tone_score, matrix_total,
    complaint_address, complainant_site_id, notice_number, end_number,
    occupant_name, occupant_dob, is_large_event_or_commercial,
    police_requested, police_present, scene_description, incident_report_text,
    follow_up_required, shift_id, dispatch_job_id, status, review_status,
    assessment_gps_lat, assessment_gps_lng
  ) values (
    v_org_id, v_user_id, v_user_id, p_client_request_id, p_assessed_at,
    trim(p_noise_source), trim(p_noise_source_address), trim(p_noise_source_address), p_action_taken, p_action_taken,
    p_volume_score, p_time_score, p_tone_score, v_matrix_total,
    nullif(trim(coalesce(p_complaint_address, '')), ''), p_complainant_site_id, nullif(trim(coalesce(p_notice_number, '')), ''), nullif(trim(coalesce(p_end_number, '')), ''),
    nullif(trim(coalesce(p_occupant_name, '')), ''), p_occupant_dob, coalesce(p_is_large_event_or_commercial, false),
    coalesce(p_police_requested, false), coalesce(p_police_present, false), nullif(trim(coalesce(p_scene_description, '')), ''), nullif(trim(coalesce(p_incident_report_text, '')), ''),
    coalesce(p_follow_up_required, false), p_shift_id, p_dispatch_job_id, 'open', 'open',
    p_gps_lat, p_gps_lng
  ) returning * into v_assessment;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'noise_assessment_submitted', 'noise_assessments', v_assessment.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'noise_source', v_assessment.noise_source,
      'matrix_total', v_matrix_total,
      'excessive', v_excessive,
      'action_taken', v_assessment.action_taken,
      'notice_number', v_assessment.notice_number
    )
  );

  return query select v_assessment.id, true, v_assessment.created_at, v_assessment.review_status, v_assessment.matrix_total;
end;
$$;

revoke all on function public.submit_officer_noise_assessment from public, anon;
grant execute on function public.submit_officer_noise_assessment to authenticated, service_role;
