create or replace function public.check_invite_rate_limit (
  p_caller_id     uuid,
  p_target_org_id uuid
)
  returns boolean
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_caller_count integer;
  v_org_count    integer;
begin
  -- Per-caller: max 5 invites in the last 5 minutes
  select count(*) into v_caller_count
    from invite_rate_log
   where caller_id = p_caller_id
     and attempted_at > now() - interval '5 minutes';

  if v_caller_count >= 5 then
    return false;
  end if;

  -- Per-target-org: max 1 invite in the last 2 minutes
  select count(*) into v_org_count
    from invite_rate_log
   where target_org_id = p_target_org_id
     and attempted_at > now() - interval '2 minutes';

  if v_org_count >= 1 then
    return false;
  end if;

  -- Allowed — record the attempt
  insert into invite_rate_log (caller_id, target_org_id)
  values (p_caller_id, p_target_org_id);

  return true;
end;
$function$;

grant execute on function "public"."check_invite_rate_limit"(uuid, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."check_invite_rate_limit"(uuid, uuid) is 'Rate-limit gate for invite-org (#361). Returns true if allowed, false if rate-limited. Per-caller: 5/5min. Per-target-org: 1/2min.';
