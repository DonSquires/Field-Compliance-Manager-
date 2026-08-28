create or replace function public.test_bob_signing_config()
  returns jsonb
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  with active as (
    select provider, key_name, fingerprint_sha256, enabled
    from public.bob_signing_identities
    where provider = 'gitea' and enabled = true
    order by created_at desc
    limit 1
  ),
  v2_present as (
    select exists(
      select 1
      from public.bob_signing_identities
      where provider = 'gitea'
        and (
          key_name ilike '%v2%'
          or notes ilike '%v2%'
          or fingerprint_sha256 <> 'SHA256:ckUO3+2YpwZcGZFGvqu/R4cZpO1iXq8IaAL9pKQl3Y4'
        )
    ) as has_v2_or_nonallowlisted
  )
  select jsonb_build_object(
    'active_is_expected', exists(
      select 1 from active
      where key_name = 'bob-gitea'
        and fingerprint_sha256 = 'SHA256:ckUO3+2YpwZcGZFGvqu/R4cZpO1iXq8IaAL9pKQl3Y4'
        and enabled = true
    ),
    'v2_not_used', not (select has_v2_or_nonallowlisted from v2_present),
    'active_identity', (select to_jsonb(active) from active)
  );
$function$;

grant execute on function "public"."test_bob_signing_config"() to "postgres", "service_role";

revoke all on function "public"."test_bob_signing_config"() from public;
