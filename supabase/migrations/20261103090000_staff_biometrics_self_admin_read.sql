-- staff_biometrics holds face embeddings and device credential references
-- (Privacy Act sensitive). The org-scoped select let every active colleague in
-- an accessible organisation read every enrolment. Nothing in web, mobile or
-- edge-function code reads the table as a user; the welfare identity gate uses
-- the service role. Narrow reads to the enrolled person and administrators of
-- the enrolment's organisation, keeping the deactivation-aware org reach.
ALTER POLICY "staff_biometrics_select" ON public."staff_biometrics"
  USING (
    ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))
    AND ((SELECT public.is_grand_master()) OR user_id = (SELECT auth.uid()) OR public.is_admin_for_org(organization_id))
  );
