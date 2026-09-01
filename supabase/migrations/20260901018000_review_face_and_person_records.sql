-- Human-review/audit workflow for the face + person-record inference
-- pipeline (#people-of-interest-face-recognition). person_records,
-- face_observations, and person_identity_documents were SELECT-only for
-- authenticated users -- there was no way for a reviewer to confirm/reject
-- a manual_review_required record, even though the schema comments on all
-- three explicitly require human review before consequential use. This
-- does not add or wire any actual face/ID inference (no vendor is
-- integrated) -- it only builds the review/audit gate for whatever a
-- future inference pipeline populates.

create or replace function public.review_face_observation(
  p_observation_id uuid,
  p_decision text,
  p_person_record_id uuid default null,
  p_new_person_display_name text default null,
  p_notes text default null
) returns table(id uuid, review_state text, person_record_id uuid)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_observation face_observations%rowtype;
  v_person_id uuid;
begin
  if p_decision not in ('verified', 'rejected') then
    raise exception 'Invalid review decision';
  end if;

  select * into v_observation from face_observations where face_observations.id = p_observation_id for update;
  if not found then raise exception 'Face observation not found'; end if;

  if not is_admin_for_org(v_observation.organization_id) then
    raise exception 'Not authorised to review this face observation';
  end if;

  v_person_id := p_person_record_id;
  if p_decision = 'verified' and v_person_id is null then
    if p_new_person_display_name is null or trim(p_new_person_display_name) = '' then
      raise exception 'A person_record_id or a new person display name is required to verify a face observation';
    end if;
    insert into person_records (organization_id, display_name, review_state)
    values (v_observation.organization_id, trim(p_new_person_display_name), 'verified')
    returning id into v_person_id;
  end if;

  update face_observations set
    review_state = p_decision,
    person_record_id = coalesce(v_person_id, person_record_id)
  where face_observations.id = p_observation_id;

  insert into audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_observation.organization_id, auth.uid(), 'face_observation_reviewed', 'face_observations', p_observation_id,
    jsonb_build_object('decision', p_decision, 'person_record_id', v_person_id, 'notes', p_notes));

  return query select p_observation_id, p_decision, v_person_id;
end;
$$;

alter function public.review_face_observation(uuid, text, uuid, text, text) owner to postgres;
comment on function public.review_face_observation(uuid, text, uuid, text, text) is 'Human-review gate for face_observations: org-admin only, verifies or rejects, optionally creating/linking a person_record, and audits the decision.';
revoke all on function public.review_face_observation(uuid, text, uuid, text, text) from public, anon;
grant execute on function public.review_face_observation(uuid, text, uuid, text, text) to authenticated, service_role;

create or replace function public.review_person_record(
  p_person_record_id uuid,
  p_decision text,
  p_notes text default null
) returns table(id uuid, review_state text)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_record person_records%rowtype;
begin
  if p_decision not in ('verified', 'rejected') then
    raise exception 'Invalid review decision';
  end if;

  select * into v_record from person_records where person_records.id = p_person_record_id for update;
  if not found then raise exception 'Person record not found'; end if;

  if not is_admin_for_org(v_record.organization_id) then
    raise exception 'Not authorised to review this person record';
  end if;

  update person_records set review_state = p_decision where person_records.id = p_person_record_id;

  insert into audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_record.organization_id, auth.uid(), 'person_record_reviewed', 'person_records', p_person_record_id,
    jsonb_build_object('decision', p_decision, 'notes', p_notes));

  return query select p_person_record_id, p_decision;
end;
$$;

alter function public.review_person_record(uuid, text, text) owner to postgres;
comment on function public.review_person_record(uuid, text, text) is 'Human-review gate for person_records: org-admin only, verifies or rejects a draft record, and audits the decision.';
revoke all on function public.review_person_record(uuid, text, text) from public, anon;
grant execute on function public.review_person_record(uuid, text, text) to authenticated, service_role;
