-- W1 access-side re-anchor for the Establish/Assess/Remedy assessment tables.
-- Owner ruling 2026-09-14 (Don Squires): accountability records anchor to the
-- PLACE OF HARM (the harmed party), with the person or vehicle doing the harm
-- anchored separately as the subject. The harmed party therefore gains the
-- accountability read; the source/subject place does not.
--
-- Additive only. The operator keeps custody through the preserved
-- org_access_allowed(organization_id) gate; nothing is dropped and no writer
-- changes. Anchors are the harmed-party columns already on the rows
-- (noise/smoke 0238/0335: complainant_site_id; biosecurity 0336:
-- protected_land_site_id), never the source site_id. While those columns are
-- unpopulated (W2 record-side work) has_location_access(NULL, NULL, ...) grants
-- nothing beyond grand_master, so this migration widens no read today.

DROP POLICY IF EXISTS na_harmed_party_select ON public.noise_assessments;
CREATE POLICY na_harmed_party_select ON public.noise_assessments
  FOR SELECT TO authenticated
  USING (public.has_location_access(complainant_site_id, NULL::uuid, 'client_reads_provider'));
COMMENT ON POLICY na_harmed_party_select ON public.noise_assessments IS
  'W1 harmed-party read: anchored on complainant_site_id (place of harm), not the source site_id. Ruling 2026-09-14.';

DROP POLICY IF EXISTS sa_harmed_party_select ON public.smoke_assessments;
CREATE POLICY sa_harmed_party_select ON public.smoke_assessments
  FOR SELECT TO authenticated
  USING (public.has_location_access(complainant_site_id, NULL::uuid, 'client_reads_provider'));
COMMENT ON POLICY sa_harmed_party_select ON public.smoke_assessments IS
  'W1 harmed-party read: anchored on complainant_site_id (place of harm), not the source site_id. Ruling 2026-09-14.';

DROP POLICY IF EXISTS ba_protected_land_select ON public.biosecurity_assessments;
CREATE POLICY ba_protected_land_select ON public.biosecurity_assessments
  FOR SELECT TO authenticated
  USING (public.has_location_access(protected_land_site_id, NULL::uuid, 'client_reads_provider'));
COMMENT ON POLICY ba_protected_land_select ON public.biosecurity_assessments IS
  'W1 harmed-party read: biosecurity harm is a place; anchored on protected_land_site_id, not the observed source site_id. Ruling 2026-09-14.';

-- Seizures carry no place of their own; visibility follows the parent
-- assessment under whatever basis (custody, harmed party, task entitlement)
-- lets the caller see that assessment.
DROP POLICY IF EXISTS noise_seizures_follows_assessment_select ON public.noise_seizures;
CREATE POLICY noise_seizures_follows_assessment_select ON public.noise_seizures
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.noise_assessments na
    WHERE na.id = noise_seizures.noise_assessment_id
  ));
COMMENT ON POLICY noise_seizures_follows_assessment_select ON public.noise_seizures IS
  'Seizure rows are readable exactly when the parent noise assessment is readable to the caller. Ruling 2026-09-14.';
