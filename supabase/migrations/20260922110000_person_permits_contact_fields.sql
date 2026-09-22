-- Contact detail captured at permit application time (owner-directed: real permit extracts and the
-- RAMS booking export both carry per-application email/phone/address, which can differ across a
-- person's permits/years — so it belongs on the permit, not on canonical_people).
ALTER TABLE public.person_permits
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS address_text text;

COMMENT ON COLUMN public.person_permits.contact_email IS 'Email captured on this permit application. Not necessarily current for the person - it is what was supplied at the time.';
COMMENT ON COLUMN public.person_permits.contact_phone IS 'Phone captured on this permit application.';
COMMENT ON COLUMN public.person_permits.address_text IS 'Free-text address captured on this permit application (source data is not structured enough to split reliably).';

-- CREATE OR REPLACE can't reorder columns; the view is new enough that nothing else
-- depends on positional order, so drop and recreate rather than fight column ordinals.
DROP VIEW IF EXISTS public.person_permits_fieldwork;
CREATE VIEW public.person_permits_fieldwork AS
SELECT
  pp.id,
  pp.organization_id,
  pp.client_organization_id,
  pp.canonical_person_id,
  cp.display_name AS holder_name,
  pp.permit_number,
  pp.permit_type,
  pp.applicant_type,
  pp.company_name,
  pp.contact_email,
  pp.contact_phone,
  pp.address_text,
  pp.forest_areas,
  pp.activities,
  pp.hunting_season,
  pp.date_from,
  pp.date_to,
  pp.firearm_confirm,
  pp.firearm_licence_valid,
  pp.chainsaw_safety_equipment,
  pp.keys_issued,
  pp.conditions,
  pp.status,
  pp.compliance_checked_at,
  pp.compliance_source,
  (SELECT array_agg(cv.plate_number ORDER BY cv.plate_number)
     FROM public.person_permit_vehicles ppv
     JOIN public.canonical_vehicle_public cv ON cv.id = ppv.canonical_vehicle_id
     WHERE ppv.permit_id = pp.id) AS vehicle_plates
FROM public.person_permits pp
LEFT JOIN public.canonical_person_public cp ON cp.id = pp.canonical_person_id
WHERE public.org_access_allowed(pp.organization_id);

COMMENT ON VIEW public.person_permits_fieldwork IS 'Officer/dispatch-safe permit projection: excludes firearm_licence_number (personal information; is_admin_for_org base-table access only). Includes holder name, contact detail captured on the application, and vehicle plates for field verification.';
