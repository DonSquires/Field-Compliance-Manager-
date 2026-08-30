create function public.claim_shift_coverage(p_request_id uuid, p_expected_status text default 'open')
returns public.shift_coverage_requests language plpgsql volatile security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_request public.shift_coverage_requests%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select * into v_profile from public.user_profiles where id = v_user_id and deactivated_at is null and role in ('officer', 'admin_officer');
  if not found then raise exception 'Active officer profile required'; end if;
  select * into v_request from public.shift_coverage_requests where id = p_request_id for update;
  if not found then raise exception 'Coverage request not found'; end if;
  if v_request.organization_id <> v_profile.organization_id then raise exception 'Coverage request is outside the officer organization'; end if;
  if v_request.status <> p_expected_status then raise exception 'Coverage request changed from expected status % to %', p_expected_status, v_request.status; end if;
  if v_request.status <> 'open' then raise exception 'Coverage request is no longer open'; end if;
  if v_request.shift_date < current_date then raise exception 'Past coverage cannot be claimed'; end if;
  update public.shift_coverage_requests set status = 'claimed', claimed_by = v_user_id, claimed_at = clock_timestamp()
  where id = p_request_id returning * into v_request;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_request.organization_id, v_user_id, 'shift_coverage_claimed', 'shift_coverage_requests', v_request.id,
    jsonb_build_object('shift_date', v_request.shift_date, 'start_time', v_request.start_time, 'site_id', v_request.site_id));
  return v_request;
end;
$$;
comment on function public.claim_shift_coverage(uuid, text) is 'Atomically claims open coverage for the authenticated active officer and records audit provenance.';
revoke all on function public.claim_shift_coverage(uuid, text) from public, anon;
grant execute on function public.claim_shift_coverage(uuid, text) to authenticated, service_role;