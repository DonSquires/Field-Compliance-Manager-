-- ============================================================
-- Migration 20260903100000 — Governed Biosecurity Module Submission & Review
-- ============================================================
-- Issue #95: Governed biosecurity submission, single DB receipt RPC,
-- linked evidence table, RLS hardening, and supervisor review.

-- 1. Add governance columns to biosecurity_assessments
alter table public.biosecurity_assessments
  add column if not exists client_request_id uuid,
  add column if not exists evidence_state text not null default 'pending',
  add column if not exists review_state text not null default 'submitted',
  add column if not exists reviewed_by uuid references public.user_profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_notes text;

alter table public.biosecurity_assessments drop constraint if exists biosecurity_assessments_evidence_state_check;
alter table public.biosecurity_assessments add constraint biosecurity_assessments_evidence_state_check
  check (evidence_state in ('pending', 'verified', 'unavailable', 'rejected'));

alter table public.biosecurity_assessments drop constraint if exists biosecurity_assessments_review_state_check;
alter table public.biosecurity_assessments add constraint biosecurity_assessments_review_state_check
  check (review_state in ('submitted', 'requires_supervisor_review', 'triaged', 'closed'));

create unique index if not exists idx_ba_org_officer_request
  on public.biosecurity_assessments (organization_id, officer_user_id, client_request_id)
  where client_request_id is not null;

-- 2. Link table for evidence items
create table if not exists public.biosecurity_assessment_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  biosecurity_assessment_id uuid not null references public.biosecurity_assessments(id) on delete cascade,
  evidence_item_id uuid not null references public.evidence_items(id) on delete cascade,
  ordinal integer not null default 0,
  purpose text not null default 'primary_evidence',
  created_at timestamptz not null default now(),
  constraint uq_bae_assessment_evidence unique (biosecurity_assessment_id, evidence_item_id)
);

comment on table public.biosecurity_assessment_evidence is
  'Explicit junction table linking biosecurity assessments to canonical evidence_items.';

alter table public.biosecurity_assessment_evidence enable row level security;

create policy bae_select on public.biosecurity_assessment_evidence
  for select using (public.org_access_allowed(organization_id));

-- 3. Revoke direct updates and inserts from authenticated / anon (require RPC or service role)
revoke insert, update, delete on table public.biosecurity_assessments from authenticated, anon;

-- 4. Single-transaction DB receipt RPC
create or replace function public.submit_biosecurity_assessment_receipt(
  p_client_request_id uuid,
  p_assessed_at timestamptz,
  p_species_name text DEFAULT NULL,
  p_density_estimate text DEFAULT 'scattered',
  p_action_taken text DEFAULT 'no_action',
  p_scene_description text DEFAULT NULL,
  p_location_name text DEFAULT NULL,
  p_protected_land_address text DEFAULT NULL,
  p_protected_land_site_id uuid DEFAULT NULL,
  p_notice_number text DEFAULT NULL,
  p_mpi_referral_number text DEFAULT NULL,
  p_follow_up_required boolean DEFAULT false,
  p_shift_id uuid DEFAULT NULL,
  p_dispatch_job_id uuid DEFAULT NULL,
  p_evidence_items jsonb DEFAULT '[]'::jsonb,
  p_classification jsonb DEFAULT '{}'::jsonb
) returns table (
  id uuid,
  created boolean,
  received_at timestamptz,
  evidence_state text,
  review_state text
) language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_existing public.biosecurity_assessments%rowtype;
  v_assessment public.biosecurity_assessments%rowtype;
  v_review_state text;
  v_evidence_state text := 'verified';
  v_item jsonb;
  v_evidence_id uuid;
  v_photo_arr jsonb := '[]'::jsonb;
  v_ordinal integer := 0;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null and p.role in ('officer', 'admin_officer', 'admin', 'master', 'grand_master');
  if v_org_id is null then raise exception 'Active officer profile required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;

  if p_assessed_at is null or p_assessed_at > now() + interval '5 minutes' or p_assessed_at < now() - interval '24 hours' then
    raise exception 'assessed_at is outside the accepted capture window';
  end if;

  if nullif(trim(coalesce(p_location_name, '')), '') is null then
    raise exception 'Observed location name is required';
  end if;

  if p_density_estimate <> 'not_found' and nullif(trim(coalesce(p_species_name, '')), '') is null then
    raise exception 'Species name is required when pest/species is present';
  end if;

  if p_action_taken in ('notice_of_direction', 'infringement_notice') and nullif(trim(coalesce(p_notice_number, '')), '') is null then
    raise exception 'Notice number is required for direction or infringement actions';
  end if;

  if p_action_taken = 'mpi_referral' and nullif(trim(coalesce(p_mpi_referral_number, '')), '') is null then
    raise exception 'MPI referral number is required for MPI referrals';
  end if;

  if p_shift_id is not null and not exists (select 1 from public.shifts s where s.id = p_shift_id and s.organization_id = v_org_id) then
    raise exception 'Shift does not belong to the officer organisation';
  end if;

  if p_dispatch_job_id is not null and not exists (select 1 from public.dispatch_jobs d where d.id = p_dispatch_job_id and d.organization_id = v_org_id) then
    raise exception 'Dispatch job does not belong to the officer organisation';
  end if;

  -- Idempotency check
  select b.* into v_existing from public.biosecurity_assessments b
    where b.organization_id = v_org_id and b.officer_user_id = v_user_id and b.client_request_id = p_client_request_id;
  if found then
    return query select v_existing.id, false, v_existing.created_at, v_existing.evidence_state, v_existing.review_state;
    return;
  end if;

  -- Derive initial review state
  if p_classification is null or coalesce(p_classification->>'classification', '') = '' or coalesce(p_classification->>'status', '') = 'unavailable' then
    v_review_state := 'requires_supervisor_review';
  else
    v_review_state := 'submitted';
  end if;

  insert into public.biosecurity_assessments (
    organization_id, officer_user_id, officer_id, client_request_id, assessed_at,
    species_name, species_identified, density_estimate, action_taken, scene_description,
    location_name, protected_land_address, protected_land_site_id, notice_number, mpi_referral_number,
    follow_up_required, shift_id, dispatch_job_id, status, evidence_state, review_state,
    bob_classification, bob_confidence
  ) values (
    v_org_id, v_user_id, v_user_id, p_client_request_id, p_assessed_at,
    nullif(trim(coalesce(p_species_name, '')), ''), nullif(trim(coalesce(p_species_name, '')), ''), p_density_estimate, p_action_taken, nullif(trim(coalesce(p_scene_description, '')), ''),
    trim(p_location_name), nullif(trim(coalesce(p_protected_land_address, '')), ''), p_protected_land_site_id, nullif(trim(coalesce(p_notice_number, '')), ''), nullif(trim(coalesce(p_mpi_referral_number, '')), ''),
    coalesce(p_follow_up_required, false), p_shift_id, p_dispatch_job_id, 'open', v_evidence_state, v_review_state,
    nullif(trim(coalesce(p_classification->>'classification', '')), ''), (p_classification->>'confidence')::real
  ) returning * into v_assessment;

  -- Process evidence items
  if jsonb_array_length(p_evidence_items) > 0 then
    for v_item in select * from jsonb_array_elements(p_evidence_items) loop
      v_evidence_id := gen_random_uuid();
      insert into public.evidence_items (
        id, organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at, metadata
      ) values (
        v_evidence_id, v_org_id, 'biosecurity', coalesce(v_item->>'evidence_kind', 'photo'), v_item->>'watermarked_path', v_user_id, p_assessed_at, coalesce(v_item, '{}'::jsonb)
      );

      insert into public.biosecurity_assessment_evidence (
        organization_id, biosecurity_assessment_id, evidence_item_id, ordinal, purpose
      ) values (
        v_org_id, v_assessment.id, v_evidence_id, v_ordinal, coalesce(v_item->>'purpose', 'primary_evidence')
      );

      v_photo_arr := v_photo_arr || jsonb_build_array(jsonb_build_object(
        'id', v_evidence_id,
        'storage_path', v_item->>'watermarked_path',
        'original_path', v_item->>'original_path',
        'captured_at', p_assessed_at
      ));
      v_ordinal := v_ordinal + 1;
    end loop;

    update public.biosecurity_assessments
      set photo_urls = v_photo_arr,
          photo_url = coalesce(v_item->>'watermarked_path', photo_url)
      where id = v_assessment.id;
  end if;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'biosecurity_assessment_submitted', 'biosecurity_assessments', v_assessment.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'species_name', v_assessment.species_name,
      'density_estimate', v_assessment.density_estimate,
      'action_taken', v_assessment.action_taken,
      'review_state', v_review_state,
      'evidence_count', v_ordinal
    )
  );

  return query select v_assessment.id, true, v_assessment.created_at, v_assessment.evidence_state, v_assessment.review_state;
end;
$$;

revoke all on function public.submit_biosecurity_assessment_receipt from public, anon;
grant execute on function public.submit_biosecurity_assessment_receipt to authenticated, service_role;

-- 5. Supervisor review RPC
create or replace function public.manage_biosecurity_assessment_review(
  p_assessment_id uuid,
  p_expected_review_state text,
  p_action text,
  p_notes text
) returns table (
  assessment_id uuid,
  review_state text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  follow_up_required boolean
) language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_item public.biosecurity_assessments%rowtype;
  v_officer uuid;
  v_next text;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  select b.* into v_item from public.biosecurity_assessments b where b.id = p_assessment_id for update;
  if not found then raise exception 'Biosecurity assessment not found'; end if;
  if not public.is_admin_for_org(v_item.organization_id) then raise exception 'Active Biosecurity administrator required'; end if;
  if v_item.review_state <> p_expected_review_state then
    raise exception 'Biosecurity review changed from expected state % to %', p_expected_review_state, v_item.review_state;
  end if;
  if v_notes is null then raise exception 'Review notes are required'; end if;

  if p_action = 'triage' and v_item.review_state in ('submitted', 'requires_supervisor_review') then
    v_next := 'triaged';
  elsif p_action = 'require_review' then
    v_next := 'requires_supervisor_review';
  elsif p_action = 'close' and v_item.review_state in ('submitted', 'requires_supervisor_review', 'triaged') then
    v_next := 'closed';
  else
    raise exception 'Unsupported biosecurity review transition from % using %', v_item.review_state, p_action;
  end if;

  update public.biosecurity_assessments
    set review_state = v_next,
        reviewed_by = v_actor,
        reviewed_at = clock_timestamp(),
        review_notes = v_notes,
        follow_up_required = case when v_next = 'requires_supervisor_review' then true when v_next = 'closed' then false else follow_up_required end
    where id = v_item.id
    returning * into v_item;

  v_officer := coalesce(v_item.officer_user_id, v_item.officer_id);

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_item.organization_id, v_actor, 'biosecurity_assessment_reviewed', 'biosecurity_assessments', v_item.id,
    jsonb_build_object('previous_review_state', p_expected_review_state, 'review_state', v_next, 'action', p_action, 'source_officer_id', v_officer, 'notes', v_notes)
  );

  if v_officer is not null then
    perform public.enqueue_notification(
      p_organization_id => v_item.organization_id,
      p_category => 'report_reviewed',
      p_title => 'Biosecurity assessment reviewed',
      p_body => v_notes,
      p_severity => case when v_next = 'requires_supervisor_review' then 'warning' else 'info' end,
      p_recipient_user_id => v_officer,
      p_link_page => 'biosecurity-review',
      p_link_payload => jsonb_build_object('assessment_id', v_item.id),
      p_dedup_key => 'biosecurity_review:' || v_item.id::text || ':' || v_item.review_state
    );
  end if;

  return query select v_item.id, v_item.review_state, v_item.reviewed_by, v_item.reviewed_at, v_item.follow_up_required;
end;
$$;

revoke all on function public.manage_biosecurity_assessment_review from public, anon;
grant execute on function public.manage_biosecurity_assessment_review to authenticated, service_role;
