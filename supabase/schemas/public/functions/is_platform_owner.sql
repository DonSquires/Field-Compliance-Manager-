create or replace function public.is_platform_owner (
  p_user_id uuid
)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_email text;
begin
  -- Resolve email from auth.users (the authoritative identity store).
  select lower(trim(email)) into v_email
  from auth.users
  where id = p_user_id;

  -- Fail-closed: no auth row or no email => not an owner.
  if v_email is null or v_email = '' then
    return false;
  end if;

  -- Canonical owner emails (mirrors supabase/functions/_shared/auth.ts OWNER_EMAILS).
  return v_email in (
    'don.squires@firstsecurity.co.nz',
    'squires.don@live.com',
    'squires.don@gmail.com'
  );
end;
$function$;

grant execute on function "public"."is_platform_owner"(uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."is_platform_owner"(uuid) is 'Returns true iff the given user_profiles.id resolves to a platform-owner email in auth.users. Fail-closed: no auth row or no email => false. Mirrors OWNER_EMAILS from supabase/functions/_shared/auth.ts.';
