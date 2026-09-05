-- Browser mutations are governed exclusively by manage_staff_branch_authorisation.
DROP POLICY IF EXISTS sba_write ON public.staff_branch_authorisations;
DROP POLICY IF EXISTS sba_select ON public.staff_branch_authorisations;

CREATE POLICY sba_select ON public.staff_branch_authorisations
FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  or exists (
    select 1
    from public.user_profiles actor
    join public.user_profiles target on target.id = staff_branch_authorisations.user_id
    where actor.id = auth.uid()
      and actor.deactivated_at is null
      and (
        actor.role = 'grand_master'
        or (
          target.employer_organization_id = coalesce(actor.employer_organization_id, actor.organization_id)
          and (
            actor.role in ('master', 'admin')
            or staff_branch_authorisations.branch_org_id = any(public.user_managed_branch_ids())
          )
        )
      )
  )
);

REVOKE INSERT, UPDATE, DELETE ON public.staff_branch_authorisations FROM authenticated;
GRANT SELECT ON public.staff_branch_authorisations TO authenticated;