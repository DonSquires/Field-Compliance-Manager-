-- Human grand_master accounts are platform administrators, not standing
-- custodians of subscriber operational reports. Report access follows the
-- actor's own provider tree; Bob's identity-specific read policy is separate.
create or replace function public.report_provider_custodian_for_actor(
  p_target_organization_id uuid,
  p_actor_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.user_profiles profile
    where profile.id = p_actor_user_id
      and profile.deactivated_at is null
      and profile.role in ('grand_master', 'master', 'admin')
      and (
        profile.organization_id = p_target_organization_id
        or p_target_organization_id = any(public.get_descendant_organizations(profile.organization_id))
        or (
          profile.employer_organization_id is not null
          and (
            profile.employer_organization_id = p_target_organization_id
            or p_target_organization_id = any(public.get_descendant_organizations(profile.employer_organization_id))
          )
        )
      )
  );
$$;

revoke all on function public.report_provider_custodian_for_actor(uuid, uuid)
  from public, anon, authenticated, service_role;
