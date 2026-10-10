-- Raw perception candidates may contain identity and enforcement-sensitive
-- material. Until domain-specific task entitlement policies land with the
-- Phase C adapters, expose this shared receipt layer only to administrators.

DROP POLICY IF EXISTS perception_model_calibrations_select ON public.perception_model_calibrations;
CREATE POLICY perception_model_calibrations_select ON public.perception_model_calibrations
  FOR SELECT TO authenticated
  USING (
    (organization_id IS NULL AND status = 'approved')
    OR (organization_id IS NOT NULL AND public.is_admin_for_org(organization_id))
  );

DROP POLICY IF EXISTS perception_evidence_envelopes_select ON public.perception_evidence_envelopes;
CREATE POLICY perception_evidence_envelopes_select ON public.perception_evidence_envelopes
  FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id));

DROP POLICY IF EXISTS perception_evidence_fields_select ON public.perception_evidence_fields;
CREATE POLICY perception_evidence_fields_select ON public.perception_evidence_fields
  FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id));

DROP POLICY IF EXISTS perception_evidence_reviews_select ON public.perception_evidence_reviews;
CREATE POLICY perception_evidence_reviews_select ON public.perception_evidence_reviews
  FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id));