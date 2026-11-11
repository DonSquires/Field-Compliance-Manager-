-- Owner direction 2026-11-12: administrators verify an existing credential from its record panel.
-- Until now an unverified credential (for example one imported from a staff COA sheet) could only be
-- superseded by recording a second, verified credential. This verifies the existing row in place,
-- with the same evidence rule as record_staff_credential, and keeps the original notes as history.

create unique index if not exists idx_audit_staff_credential_verified_request
  on public.audit_log (organization_id, ((metadata ->> 'client_request_id')))
  where action = 'staff_credential_verified';

create or replace function public.verify_staff_credential(
  p_client_request_id uuid,
  p_credential_id uuid,
  p_credential_number text,
  p_issuing_authority text,
  p_issued_date date,
  p_expiry_date date,
  p_evidence_notes text
)
returns table(credential_id uuid, staff_id uuid, verified boolean, verified_at timestamp with time zone, replayed boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_row public.staff_credentials%rowtype;
  v_number text := nullif(trim(coalesce(p_credential_number, '')), '');
  v_authority text := nullif(trim(coalesce(p_issuing_authority, '')), '');
  v_notes text := nullif(trim(coalesce(p_evidence_notes, '')), '');
  v_replay_target uuid;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;
  select c.* into v_row from public.staff_credentials c where c.id = p_credential_id for update;
  if not found then raise exception 'Credential not found'; end if;
  if not public.is_admin_for_org(v_row.organization_id) then raise exception 'Active provider administrator required'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));
  select a.target_id into v_replay_target from public.audit_log a
  where a.organization_id = v_row.organization_id and a.action = 'staff_credential_verified'
    and a.metadata->>'client_request_id' = p_client_request_id::text;
  if found then
    if v_replay_target is distinct from v_row.id then raise exception 'Credential verification request identity collision'; end if;
    return query select v_row.id, v_row.staff_id, v_row.verified, v_row.verified_at, true;
    return;
  end if;

  if v_row.verified then raise exception 'This credential is already verified'; end if;
  if v_number is null or v_authority is null or v_notes is null or length(v_notes) < 10 then
    raise exception 'Verifying a credential needs its number, the issuing authority, and evidence notes of at least 10 characters';
  end if;
  if p_issued_date is not null and p_expiry_date is not null and p_issued_date > p_expiry_date then
    raise exception 'Credential expiry cannot precede its issue date';
  end if;

  update public.staff_credentials c
  set credential_number = v_number,
      issuing_authority = v_authority,
      issued_date = coalesce(p_issued_date, c.issued_date),
      expiry_date = coalesce(p_expiry_date, c.expiry_date),
      verified = true,
      verified_by = v_actor,
      verified_at = clock_timestamp(),
      notes = concat_ws(E'\n', c.notes, 'Verified ' || to_char(clock_timestamp() at time zone 'Pacific/Auckland', 'DD Mon YYYY') || ': ' || v_notes)
  where c.id = v_row.id
  returning * into v_row;

  if v_row.issued_date is not null and v_row.expiry_date is not null and v_row.issued_date > v_row.expiry_date then
    raise exception 'Credential expiry cannot precede its issue date';
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_row.organization_id, v_actor, 'staff_credential_verified', 'staff_credentials', v_row.id, jsonb_build_object(
    'staff_id', v_row.staff_id,
    'credential_type', v_row.credential_type,
    'credential_number', v_number,
    'issuing_authority', v_authority,
    'issued_date', v_row.issued_date,
    'expiry_date', v_row.expiry_date,
    'evidence_notes', v_notes,
    'client_request_id', p_client_request_id
  ));
  return query select v_row.id, v_row.staff_id, v_row.verified, v_row.verified_at, false;
end;
$function$;

comment on function public.verify_staff_credential(uuid, uuid, text, text, date, date, text) is
  'Verifies an existing unverified staff credential in place as an administrator of its organisation. Needs the number, issuing authority and evidence notes of at least 10 characters; dates may be completed or corrected from the evidence. Earlier notes are kept. Replay-safe on p_client_request_id; audited as staff_credential_verified.';

revoke all on function public.verify_staff_credential(uuid, uuid, text, text, date, date, text) from public, anon, authenticated, service_role;
grant execute on function public.verify_staff_credential(uuid, uuid, text, text, date, date, text) to postgres, authenticated;
