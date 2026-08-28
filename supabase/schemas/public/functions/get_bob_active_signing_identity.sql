create or replace function public.get_bob_active_signing_identity()
  returns jsonb
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select coalesce(
    (
      select jsonb_build_object(
        'provider', provider,
        'key_name', key_name,
        'fingerprint_sha256', fingerprint_sha256,
        'enabled', enabled
      )
      from public.bob_signing_identities
      where provider = 'gitea' and enabled = true
      order by created_at desc
      limit 1
    ),
    jsonb_build_object('provider','gitea','enabled',false)
  );
$function$;

grant execute on function "public"."get_bob_active_signing_identity"() to "authenticated", "postgres", "service_role";

revoke all on function "public"."get_bob_active_signing_identity"() from public;
