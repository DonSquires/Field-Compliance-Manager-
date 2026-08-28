create or replace function public.log_bob_signing_event (
  p_event_type         text,
  p_fingerprint_sha256 text,
  p_success            boolean,
  p_reason             text    default null::text,
  p_request_id         text    default null::text
)
  returns uuid
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_identity_id uuid;
  v_event_id uuid;
  v_payload jsonb;
begin
  if p_event_type not in ('sign_request','sign_success','sign_failure','identity_check') then
    raise exception 'invalid event_type';
  end if;

  if p_fingerprint_sha256 is distinct from 'SHA256:ckUO3+2YpwZcGZFGvqu/R4cZpO1iXq8IaAL9pKQl3Y4' then
    raise exception 'fingerprint not allowlisted';
  end if;

  select id
  into v_identity_id
  from public.bob_signing_identities
  where provider = 'gitea'
    and key_name = 'bob-gitea'
    and fingerprint_sha256 = p_fingerprint_sha256
    and enabled = true
  order by created_at desc
  limit 1;

  if v_identity_id is null then
    raise exception 'active signing identity not found';
  end if;

  v_payload := jsonb_build_object(
    'namespace', 'gitea',
    'key_name', 'bob-gitea',
    'fingerprint_sha256', p_fingerprint_sha256,
    'success', p_success,
    'reason', p_reason,
    'request_id', p_request_id
  );

  insert into public.bob_signing_audit (
    identity_id,
    event_type,
    event_payload,
    actor_user_id
  )
  values (
    v_identity_id,
    p_event_type,
    v_payload,
    auth.uid()
  )
  returning id into v_event_id;

  return v_event_id;
end;
$function$;

grant execute on function "public"."log_bob_signing_event"(text, text, boolean, text, text) to "postgres", "service_role";

revoke all on function "public"."log_bob_signing_event"(text, text, boolean, text, text) from public;
