create or replace function public.consume_bob_signing_nonce (
  p_nonce      text,
  p_expires_at timestamp with time zone
)
  returns boolean
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_now timestamp with time zone := now();
  v_ok boolean := false;
begin
  if p_nonce is null or length(trim(p_nonce)) < 16 then
    return false;
  end if;

  if p_expires_at is null or p_expires_at <= v_now or p_expires_at > (v_now + interval '10 minutes') then
    return false;
  end if;

  delete from public.bob_signing_nonces where expires_at < v_now;

  insert into public.bob_signing_nonces (nonce, expires_at)
  values (p_nonce, p_expires_at)
  on conflict (nonce) do nothing;

  get diagnostics v_ok = row_count;
  return coalesce(v_ok, false);
end;
$function$;

grant execute on function "public"."consume_bob_signing_nonce"(text, timestamp with time zone) to "postgres", "service_role";

revoke all on function "public"."consume_bob_signing_nonce"(text, timestamp with time zone) from public;
