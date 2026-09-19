-- Record a staff member's first credential through a governed, audited path.
--
-- Live finding (2026-09-19): staff_credentials has an INSERT policy for administrators but no table
-- grant to authenticated, so the policy is dead; the only writers are renew_staff_credential (needs an
-- existing credential) and Bob's apply_credential_promotion_proposal (needs a document proposal). No
-- page records a first credential. Because work-readiness requires a verified current credential
-- (get_staff_readiness_assessment) and the onboarding Evidence step depends on it, a newly hired
-- officer could never be made work-ready from the app. staff_credentials has 0 rows live.
--
-- This adds record_staff_credential: administrator of the staff member's organisation; canonical
-- credential types (same list as the proposal path); verification requires number, authority and
-- evidence notes; replay-safe on client_request_id; audited as staff_credential_recorded.

create or replace function public.record_staff_credential(
  p_client_request_id uuid,
  p_staff_id uuid,
  p_credential_type text,
  p_credential_number text default null,
  p_issuing_authority text default null,
  p_issued_date date default null,
  p_expiry_date date default null,
  p_authorized_activities text[] default '{}'::text[],
  p_verified boolean default false,
  p_evidence_notes text default null
) returns table(credential_id uuid, staff_id uuid, verified boolean, verified_at timestamp with time zone, created boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_row public.staff_credentials%rowtype;
  v_number text := nullif(trim(coalesce(p_credential_number, '')), '');
  v_authority text := nullif(trim(coalesce(p_issuing_authority, '')), '');
  v_notes text := nullif(trim(coalesce(p_evidence_notes, '')), '');
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;
  select s.* into v_staff from public.staff_profiles s where s.id = p_staff_id;
  if not found then raise exception 'Staff profile not found'; end if;
  if not public.is_admin_for_org(v_staff.organization_id) then raise exception 'Active provider administrator required'; end if;
  if p_credential_type not in ('certificate_of_authority', 'warrant_of_authority', 'drivers_licence', 'first_aid', 'security_licence', 'firearms_licence', 'noise_control_warrant', 'biosecurity_warrant', 'other') then raise exception 'Unsupported credential type'; end if;
  if p_issued_date is not null and p_expiry_date is not null and p_issued_date > p_expiry_date then raise exception 'Credential expiry cannot precede its issue date'; end if;
  if p_verified and (v_number is null or v_authority is null or v_notes is null or length(v_notes) < 10) then raise exception 'Verifying a credential needs its number, the issuing authority, and evidence notes of at least 10 characters'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));
  select c.* into v_row from public.staff_credentials c where c.organization_id = v_staff.organization_id and c.client_request_id = p_client_request_id;
  if found then
    if v_row.staff_id <> v_staff.id then raise exception 'Credential request identity collision'; end if;
    return query select v_row.id, v_row.staff_id, v_row.verified, v_row.verified_at, false;
    return;
  end if;

  insert into public.staff_credentials(staff_id, organization_id, credential_type, credential_number, issuing_authority, issued_date, expiry_date, authorized_activities, verified, verified_by, verified_at, notes, client_request_id)
  values (v_staff.id, v_staff.organization_id, p_credential_type, v_number, v_authority, p_issued_date, p_expiry_date, coalesce(p_authorized_activities, '{}'::text[]), p_verified, case when p_verified then v_actor end, case when p_verified then clock_timestamp() end, v_notes, p_client_request_id)
  returning * into v_row;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_staff.organization_id, v_actor, 'staff_credential_recorded', 'staff_credentials', v_row.id, jsonb_build_object(
    'staff_id', v_staff.id,
    'credential_type', p_credential_type,
    'credential_number', v_number,
    'issuing_authority', v_authority,
    'issued_date', p_issued_date,
    'expiry_date', p_expiry_date,
    'verified', p_verified,
    'client_request_id', p_client_request_id
  ));
  return query select v_row.id, v_row.staff_id, v_row.verified, v_row.verified_at, true;
end;
$$;

revoke all on function public.record_staff_credential(uuid, uuid, text, text, text, date, date, text[], boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.record_staff_credential(uuid, uuid, text, text, text, date, date, text[], boolean, text) to postgres, authenticated, service_role;
comment on function public.record_staff_credential(uuid, uuid, text, text, text, date, date, text[], boolean, text) is
  'Records a staff member''s credential (first or additional) as an administrator of their organisation. Verification requires number, authority and evidence notes. Replay-safe on p_client_request_id; audited as staff_credential_recorded. Renewals of an expiring credential use renew_staff_credential.';
