-- Closes the person-identity fork recorded in docs/canon/ALIGNMENT_LEDGER.md (ruling 2026-09-19):
-- canonical_people is the one global canonical person record ("like canonical_places and
-- canonical_vehicles"). persons was a second, parallel design - richer columns, real FKs from
-- notices/person_interactions/person_vehicle_links/ems_devices - but nothing anywhere ever wrote a
-- persons row (no INSERT/UPDATE in any function, no INSERT policy on the two link tables, no frontend
-- reference, and neither generate-notice nor generate-parking-notice ever touches notices.person_id).
-- Zero live data depends on it; this is schema consolidation, not a data migration.
--
-- welfare_flag/welfare_notes are deliberately NOT migrated: entity_flags (hazard_class,
-- get_safety_warnings) already replaced standalone person_flags for exactly this ("Replaces standalone
-- vehicle_flags/person_flags/location_flags, retired in 0115"). Recreating a second welfare column here
-- would reopen the same duplication this migration exists to close.
--
-- date_of_birth and the homeless_* trio DO migrate, mirroring canonical_vehicles' own homeless_status
-- fields exactly (lifecycle none -> claiming -> investigating -> confirmed; reconciled to a vehicle via
-- entity_links). Because canonical_people can now hold real personal information, its RLS is brought in
-- line with canonical_vehicles: the base table locks to Bob only, and a redacted canonical_person_public
-- view (mirroring canonical_vehicle_public) becomes the read path for everyone else.

-- 1. Personal-information columns, migrated from persons.
ALTER TABLE public.canonical_people
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS homeless_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS homeless_verified_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS homeless_notes text;

COMMENT ON COLUMN public.canonical_people.date_of_birth IS 'Date of birth, when known. Personal information - never exposed via canonical_person_public; governed paths only.';
COMMENT ON COLUMN public.canonical_people.homeless_status IS 'Independent homeless status for the person (e.g. living in a tent/vehicle), separate from any vehicle. Lifecycle: none -> claiming -> investigating -> confirmed. Reconciled to a vehicle via entity_links (occupant/lives_in). Mirrors canonical_vehicles.homeless_status.';
COMMENT ON COLUMN public.canonical_people.homeless_verified_at IS 'Timestamp the homeless_status was last confirmed by a human reviewer.';
COMMENT ON COLUMN public.canonical_people.homeless_notes IS 'Free-text note on the homeless_status finding. Personal information - never exposed via canonical_person_public; governed paths only.';

-- 2. Lock the base table to Bob only, matching canonical_vehicles, now that it can carry DOB/notes.
--    SECURITY DEFINER functions (ensure_canonical_person_for_record, update_cctv_person_profile, etc.)
--    run as the table owner and bypass RLS by default, so this does not affect them - only a
--    hypothetical direct client select, and nothing in the frontend does that today (confirmed).
DROP POLICY IF EXISTS "canonical_people_select" ON public.canonical_people;
CREATE POLICY "bob_full_read" ON public.canonical_people FOR SELECT TO authenticated
  USING (( SELECT auth.uid()) = '00000000-0000-0000-0000-00000000b0b0'::uuid);

-- 3. Redacted public projection - identity + the one safety signal an officer needs before approaching.
--    Excludes date_of_birth and homeless_notes, exactly as canonical_vehicle_public excludes
--    registered_owner_name and homeless_notes.
CREATE OR REPLACE VIEW public.canonical_person_public AS
 SELECT id,
    canonical_key,
    display_name,
    normalized_name,
    review_state,
    status,
    homeless_status,
    created_at,
    updated_at
   FROM public.canonical_people;
COMMENT ON VIEW public.canonical_person_public IS 'Platform-wide person identity (Tier 0): identity, review state, and the homeless status signal an officer must know before approaching. Deliberately excludes date_of_birth and homeless_notes (personal information; governed paths only). Definer view over canonical_people, which stays Bob-only at the table.';

REVOKE ALL ON public.canonical_person_public FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.canonical_person_public TO postgres, anon, authenticated, service_role;

-- 4. Repoint the four persons-referencing tables at canonical_people. Nothing populates person_id on any
--    of them today; the cleanup below is a defensive no-op guard, not an expected data change.
--    person_interactions and person_vehicle_links declare person_id NOT NULL, so an orphaned row (one
--    that can't be repointed) is dropped rather than left with a dangling FK; notices and ems_devices
--    declare it nullable, so an orphan is simply nulled out.
DELETE FROM public.person_interactions pi
 WHERE NOT EXISTS (SELECT 1 FROM public.canonical_people cp WHERE cp.id = pi.person_id);
DELETE FROM public.person_vehicle_links pvl
 WHERE NOT EXISTS (SELECT 1 FROM public.canonical_people cp WHERE cp.id = pvl.person_id);
UPDATE public.notices n SET person_id = NULL
 WHERE n.person_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.canonical_people cp WHERE cp.id = n.person_id);
UPDATE public.ems_devices ed SET person_id = NULL
 WHERE ed.person_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.canonical_people cp WHERE cp.id = ed.person_id);

ALTER TABLE public.notices DROP CONSTRAINT IF EXISTS notices_person_id_fkey;
ALTER TABLE public.notices ADD CONSTRAINT notices_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.canonical_people(id);

ALTER TABLE public.person_interactions DROP CONSTRAINT IF EXISTS person_interactions_person_id_fkey;
ALTER TABLE public.person_interactions ADD CONSTRAINT person_interactions_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.canonical_people(id);

ALTER TABLE public.person_vehicle_links DROP CONSTRAINT IF EXISTS person_vehicle_links_person_id_fkey;
ALTER TABLE public.person_vehicle_links ADD CONSTRAINT person_vehicle_links_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.canonical_people(id);

ALTER TABLE public.ems_devices DROP CONSTRAINT IF EXISTS ems_devices_person_id_fkey;
ALTER TABLE public.ems_devices ADD CONSTRAINT ems_devices_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.canonical_people(id);

-- 5. Retire persons. No CASCADE: if something else still references it that this migration didn't find,
--    this should fail loudly rather than silently drop unknown dependents.
DROP TABLE public.persons;
