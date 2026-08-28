create or replace function public.claim_first_org_user (
  p_org_id       uuid,
  p_user_id      uuid,
  p_display_name text,
  p_role         text,
  p_email        text
)
  returns void
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_existing_count integer;
begin
  -- Acquire an advisory lock scoped to this org. hashtext returns a stable
  -- int4 hash. The lock is transaction-scoped (released on COMMIT/ROLLBACK).
  perform pg_advisory_xact_lock(hashtext(p_org_id::text));

  -- Check for existing users INSIDE the lock
  select count(*) into v_existing_count
    from user_profiles
   where organization_id = p_org_id;

  if v_existing_count > 0 then
    raise exception 'Organisation already has users — duplicate first-user prevented'
      using errcode = '23505'; -- unique_violation
  end if;

  -- Insert the first user profile
  insert into user_profiles (id, organization_id, display_name, role, email)
  values (p_user_id, p_org_id, p_display_name, p_role, p_email)
  on conflict (id) do update set
    organization_id = excluded.organization_id,
    display_name    = excluded.display_name,
    role            = excluded.role,
    email           = excluded.email;
end;
$function$;

grant execute on function "public"."claim_first_org_user"(uuid, uuid, text, text, text) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."claim_first_org_user"(uuid, uuid, text, text, text) is 'Race-safe first-user creation for invite-org (#361). Uses pg_advisory_xact_lock to serialise per-org, making duplicate-first-user impossible.';
