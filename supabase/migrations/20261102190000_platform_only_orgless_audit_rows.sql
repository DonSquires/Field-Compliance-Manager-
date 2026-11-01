-- Owner ruling 2026-11-01: audit rows with no organisation are platform records
-- (desktop signing-material reads, Bob maintenance, platform administration).
-- Only the platform rank may read them: the grand master or a platform owner
-- identity. Organisation rows keep their existing org_access_allowed scope.
-- Every audit writer is a SECURITY DEFINER function or a service-role client,
-- and Bob's service identity keeps its own bob_full_read policy, so neither is
-- affected. No web, mobile, view, or SECURITY INVOKER function reads audit_log.

ALTER POLICY "audit_log_select" ON public.audit_log TO authenticated
  USING (
    (organization_id IS NOT NULL AND org_access_allowed(organization_id))
    OR (
      organization_id IS NULL
      AND (
        (SELECT public.is_grand_master())
        OR (SELECT public.is_platform_owner((SELECT auth.uid())))
      )
    )
  );
