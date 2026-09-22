-- Forest/site access permits (owner ruling 2026-09-22): a permit is an org-scoped fact
-- about a canonical person, in the same shape as canonical_vehicles.org_notes — not a
-- cross-org identity fact, so it does not live on canonical_people itself.
--
-- Access model mirrors canonical_vehicle_public / canonical_person_public exactly:
--   - person_permits (base table): is_admin_for_org only. Holds firearm_licence_number,
--     which is never exposed more broadly.
--   - person_permits_fieldwork (view): org_access_allowed, excludes firearm_licence_number.
--     This is what patrol/dispatch actually query to check a permit in the field.
-- Vehicles attach through their own junction (person_permit_vehicles) rather than the
-- legacy person_vehicle_links table, which still points at the persons/vehicles tables
-- being retired by 20260922050000 and should not gain new dependents mid-consolidation.

CREATE TABLE IF NOT EXISTS public.person_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  canonical_person_id uuid NOT NULL REFERENCES public.canonical_people(id) ON DELETE RESTRICT,
  permit_number text NOT NULL,
  permit_type text,
  applicant_type text,
  company_name text,
  forest_areas text[],
  activities text[],
  hunting_season text,
  date_from date,
  date_to date,
  firearm_confirm boolean,
  firearm_licence_valid boolean,
  firearm_licence_number text,
  chainsaw_safety_equipment boolean,
  keys_issued boolean,
  conditions text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'suspended')),
  compliance_checked_at timestamptz,
  compliance_source text CHECK (compliance_source IN ('manual', 'import', 'canonical')),
  source_document text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, permit_number)
);

CREATE INDEX IF NOT EXISTS idx_person_permits_person ON public.person_permits USING btree (canonical_person_id);
CREATE INDEX IF NOT EXISTS idx_person_permits_org ON public.person_permits USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_person_permits_date_to ON public.person_permits USING btree (date_to);
CREATE INDEX IF NOT EXISTS idx_person_permits_status ON public.person_permits USING btree (status);

COMMENT ON TABLE public.person_permits IS 'Forest/site access permits issued to a canonical person, org-scoped. Read path for ordinary users is person_permits_fieldwork, not this table.';
COMMENT ON COLUMN public.person_permits.client_organization_id IS 'The forest/land owner the permit is issued for (e.g. OFO, TPFL), distinct from organization_id (the issuing/administering org, e.g. R&M).';
COMMENT ON COLUMN public.person_permits.firearm_licence_number IS 'Personal information - never exposed via person_permits_fieldwork; is_admin_for_org base-table access only.';
COMMENT ON COLUMN public.person_permits.compliance_checked_at IS 'When this permit''s details were last confirmed (e.g. the date of the source extract/photo it was seeded from). Mirrors canonical_vehicles.compliance_checked_at.';
COMMENT ON COLUMN public.person_permits.compliance_source IS 'How compliance_checked_at was established: manual (staff entry), import (bulk seed from a historical extract), canonical (system-derived).';
COMMENT ON COLUMN public.person_permits.source_document IS 'Provenance: the file this permit was imported from (e.g. "OFO permit list 201020.xlsx"), for audit trail back to the original record.';

CREATE TABLE IF NOT EXISTS public.person_permit_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  permit_id uuid NOT NULL REFERENCES public.person_permits(id) ON DELETE CASCADE,
  canonical_vehicle_id uuid NOT NULL REFERENCES public.canonical_vehicles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (permit_id, canonical_vehicle_id)
);

CREATE INDEX IF NOT EXISTS idx_person_permit_vehicles_permit ON public.person_permit_vehicles USING btree (permit_id);
CREATE INDEX IF NOT EXISTS idx_person_permit_vehicles_vehicle ON public.person_permit_vehicles USING btree (canonical_vehicle_id);

COMMENT ON TABLE public.person_permit_vehicles IS 'Vehicles authorised under a specific permit. A permit may cover several vehicles (confirmed from real OFO permit extracts).';

ALTER TABLE public.person_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_permit_vehicles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bob_full_read" ON public.person_permits FOR SELECT TO authenticated
  USING (((SELECT auth.uid() AS uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));
CREATE POLICY person_permits_admin_all ON public.person_permits FOR ALL TO authenticated
  USING (public.is_admin_for_org(organization_id)) WITH CHECK (public.is_admin_for_org(organization_id));

CREATE POLICY "bob_full_read" ON public.person_permit_vehicles FOR SELECT TO authenticated
  USING (((SELECT auth.uid() AS uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));
CREATE POLICY person_permit_vehicles_select ON public.person_permit_vehicles FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id));
CREATE POLICY person_permit_vehicles_admin_write ON public.person_permit_vehicles FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_for_org(organization_id));
CREATE POLICY person_permit_vehicles_admin_update ON public.person_permit_vehicles FOR UPDATE TO authenticated
  USING (public.is_admin_for_org(organization_id)) WITH CHECK (public.is_admin_for_org(organization_id));
CREATE POLICY person_permit_vehicles_admin_delete ON public.person_permit_vehicles FOR DELETE TO authenticated
  USING (public.is_admin_for_org(organization_id));

REVOKE ALL ON TABLE public.person_permits, public.person_permit_vehicles FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.person_permits, public.person_permit_vehicles TO authenticated;
GRANT ALL ON TABLE public.person_permits, public.person_permit_vehicles TO service_role;

-- Definer view (owner is not RLS-restricted authenticated): re-applies its own
-- org_access_allowed scoping rather than inheriting person_permits' admin-only policy.
CREATE OR REPLACE VIEW public.person_permits_fieldwork AS
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

REVOKE ALL ON public.person_permits_fieldwork FROM PUBLIC, anon;
GRANT SELECT ON public.person_permits_fieldwork TO authenticated, service_role;
COMMENT ON VIEW public.person_permits_fieldwork IS 'Officer/dispatch-safe permit projection: excludes firearm_licence_number (personal information; is_admin_for_org base-table access only). Includes holder name and vehicle plates for field verification.';
