-- Pest-control and biosecurity vocabulary as catalog data.
--
-- R&M's patrol workbooks share one label vocabulary (Charge codes MASTER:
-- Source / Subject / Issue) across every client. The numeric charge codes are
-- re-numbered between workbook versions, so classification keys on the labels,
-- never on C1/C2/C3 numbers. Platform-generic meaning lives in
-- reference_code_templates (copied into every organization, the same pattern
-- as the workshop work codes); R&M's own label spellings live only in its
-- rm_patrol_log classification rules.
--
-- This migration changes catalog and rule data only. It does not reclassify
-- any existing location_events row; existing rows move only through the
-- governed source-sync / legacy-correction paths with version history.

ALTER TABLE public.reference_codes DROP CONSTRAINT IF EXISTS reference_codes_code_type_check;
ALTER TABLE public.reference_codes ADD CONSTRAINT reference_codes_code_type_check CHECK (
  code_type = ANY (ARRAY[
    'pay_item'::text, 'gl_account'::text, 'role_code'::text, 'job_code'::text,
    'branch'::text, 'org_code'::text, 'service_code'::text,
    'work_subject'::text, 'work_activity'::text, 'biosecurity_species'::text
  ])
);

ALTER TABLE public.reference_code_templates DROP CONSTRAINT IF EXISTS reference_code_templates_type_check;
ALTER TABLE public.reference_code_templates ADD CONSTRAINT reference_code_templates_type_check CHECK (
  code_type = ANY (ARRAY['work_subject'::text, 'work_activity'::text, 'biosecurity_species'::text])
);

CREATE OR REPLACE FUNCTION public.enforce_import_value_rule_catalog_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_code public.reference_codes%rowtype;
BEGIN
  SELECT * INTO v_code FROM public.reference_codes WHERE id = NEW.target_code_id;
  IF NOT FOUND OR v_code.organization_id <> NEW.organization_id
     OR v_code.code_type NOT IN ('work_subject', 'work_activity', 'biosecurity_species') THEN
    RAISE EXCEPTION 'Classification rule target must be an organization work subject, work activity, or biosecurity species code';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_import_value_rule_catalog_scope() FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.reference_code_templates(code_type, code, name, description, is_active, sort_order, external_refs)
VALUES
  ('work_subject', 'pest_device', 'Pest control device', 'Trap, bait station, or other pest-control device at a monitored station.', true, 50, '{}'::jsonb),
  ('work_subject', 'animal', 'Animal', 'A pest or nuisance animal: cull, sighting, or animal patrol.', true, 60, '{}'::jsonb),
  ('work_subject', 'habitat', 'Habitat', 'Habitat or environmental condition at a place.', true, 70, '{}'::jsonb),
  ('work_activity', 'device_reset', 'Set or reset device', 'Arm, set, or reset a trap or device.', true, 110, '{"work_order_candidate":false}'::jsonb),
  ('work_activity', 'device_unset', 'Unset device', 'Disarm or stand down a trap or device without removing it.', true, 120, '{"work_order_candidate":false}'::jsonb),
  ('work_activity', 'rebait', 'Rebait', 'Replace or top up bait in a trap or bait station.', true, 130, '{"work_order_candidate":false}'::jsonb),
  ('work_activity', 'prefeed', 'Prefeed', 'Lay non-toxic or unset prefeed before a control operation.', true, 140, '{"work_order_candidate":false}'::jsonb),
  ('work_activity', 'removal', 'Uninstall or remove', 'Uninstall or remove equipment from a station.', true, 150, '{"work_order_candidate":true}'::jsonb),
  ('work_activity', 'device_inactive', 'Device inactive', 'Device found or recorded as inactive.', true, 160, '{"work_order_candidate":false}'::jsonb),
  ('work_activity', 'access_blocked', 'Access blocked', 'Planned work could not be done because access was blocked.', true, 170, '{"work_order_candidate":false}'::jsonb),
  ('work_activity', 'cull', 'Animal cull', 'Animal killed by trapping, shooting, or an organised cull.', true, 180, '{"work_order_candidate":false}'::jsonb),
  ('work_activity', 'sighting', 'Animal sighting', 'Animal seen, not culled.', true, 190, '{"work_order_candidate":false}'::jsonb),
  ('work_activity', 'pest_patrol', 'Pest animal patrol', 'Patrol carried out for pest-animal control.', true, 200, '{"work_order_candidate":false}'::jsonb),
  ('biosecurity_species', 'possum', 'Possum', 'Brushtail possum.', true, 10, '{}'::jsonb),
  ('biosecurity_species', 'cat', 'Cat', 'Feral or stray cat.', true, 20, '{}'::jsonb),
  ('biosecurity_species', 'deer', 'Deer', 'Deer.', true, 30, '{}'::jsonb),
  ('biosecurity_species', 'goat', 'Goat', 'Feral goat.', true, 40, '{}'::jsonb),
  ('biosecurity_species', 'pig', 'Pig', 'Feral pig.', true, 50, '{}'::jsonb),
  ('biosecurity_species', 'stoat_ferret', 'Stoat or ferret', 'Mustelid recorded as stoat or ferret; the source does not separate them.', true, 60, '{}'::jsonb),
  ('biosecurity_species', 'quail_rabbit', 'Quail or rabbit', 'Recorded under the combined source label for quail or rabbit; the source does not separate them.', true, 70, '{}'::jsonb),
  ('biosecurity_species', 'sheep_cow', 'Sheep or cow', 'Stock animal recorded under the combined source label for sheep or cow.', true, 80, '{}'::jsonb),
  ('biosecurity_species', 'other', 'Other or unidentified', 'Animal not identified to a listed species.', true, 1000, '{}'::jsonb)
ON CONFLICT (code_type, code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order,
  external_refs = EXCLUDED.external_refs,
  updated_at = now();

-- Copy the new template rows into every organization. Existing organization
-- rows are never overwritten (ON CONFLICT DO NOTHING inside the seeder).
SELECT public.seed_org_reference_code_defaults(organization.id)
FROM public.organizations organization;

-- R&M label rules. Lower priority wins. Subject-driven animal rules outrank
-- issue rules because, for Animal Cull/Seen rows, the Issue column holds the
-- species rather than an activity. "- R&M" label variants mark internal work
-- and classify to the same activity; billing treatment is decided separately.
WITH rule_seed(rule_code, target_type, target_code, priority, conditions) AS (
  VALUES
    ('subject_pest_device', 'work_subject', 'pest_device', 15, '[{"field":"subject","operator":"in","values":["Equipment"]},{"field":"source","operator":"exact","value":"PEST CONTROL"}]'::jsonb),
    ('subject_animal', 'work_subject', 'animal', 15, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot","Animal Patrol"]}]'::jsonb),
    ('subject_habitat', 'work_subject', 'habitat', 30, '[{"field":"subject","operator":"exact","value":"Habitat"}]'::jsonb),
    ('activity_cull', 'work_activity', 'cull', 5, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Shot"]}]'::jsonb),
    ('activity_sighting', 'work_activity', 'sighting', 5, '[{"field":"subject","operator":"in","values":["Animal Seen"]}]'::jsonb),
    ('activity_organised_cull', 'work_activity', 'cull', 20, '[{"field":"issue","operator":"in","values":["Organised cull"]}]'::jsonb),
    ('activity_removal', 'work_activity', 'removal', 20, '[{"field":"issue","operator":"in","values":["Uninstall","Remove","Remove / Unestablish"]}]'::jsonb),
    ('activity_area_maintenance', 'work_activity', 'maintenance', 20, '[{"field":"issue","operator":"in","values":["Area Maintenance"]}]'::jsonb),
    ('activity_device_reset', 'work_activity', 'device_reset', 40, '[{"field":"issue","operator":"in","values":["Reset","Set"]}]'::jsonb),
    ('activity_device_unset', 'work_activity', 'device_unset', 40, '[{"field":"issue","operator":"in","values":["Unset"]}]'::jsonb),
    ('activity_rebait', 'work_activity', 'rebait', 40, '[{"field":"issue","operator":"in","values":["Rebait"]}]'::jsonb),
    ('activity_prefeed', 'work_activity', 'prefeed', 40, '[{"field":"issue","operator":"in","values":["Prefeed"]}]'::jsonb),
    ('activity_device_inactive', 'work_activity', 'device_inactive', 40, '[{"field":"issue","operator":"in","values":["Inactive"]}]'::jsonb),
    ('activity_access_blocked', 'work_activity', 'access_blocked', 40, '[{"field":"issue","operator":"in","values":["Access Blocked"]}]'::jsonb),
    ('activity_trap_check', 'work_activity', 'inspection', 50, '[{"field":"issue","operator":"in","values":["Check trap (empty)","Check trap (engaged)","Check - R&M"]}]'::jsonb),
    ('activity_administration_internal', 'work_activity', 'administration', 50, '[{"field":"issue","operator":"in","values":["Admin - R&M"]}]'::jsonb),
    ('activity_pest_patrol', 'work_activity', 'pest_patrol', 60, '[{"field":"subject","operator":"in","values":["Animal Patrol"]}]'::jsonb),
    ('species_possum', 'biosecurity_species', 'possum', 20, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot"]},{"field":"issue","operator":"in","values":["Possum"]}]'::jsonb),
    ('species_cat', 'biosecurity_species', 'cat', 20, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot"]},{"field":"issue","operator":"in","values":["Cat"]}]'::jsonb),
    ('species_deer', 'biosecurity_species', 'deer', 20, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot"]},{"field":"issue","operator":"in","values":["Deer"]}]'::jsonb),
    ('species_goat', 'biosecurity_species', 'goat', 20, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot"]},{"field":"issue","operator":"in","values":["Goat"]}]'::jsonb),
    ('species_pig', 'biosecurity_species', 'pig', 20, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot"]},{"field":"issue","operator":"in","values":["Pig"]}]'::jsonb),
    ('species_stoat_ferret', 'biosecurity_species', 'stoat_ferret', 20, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot"]},{"field":"issue","operator":"in","values":["Stoat / Ferrit","Stoat / Ferret","Stoat","Ferret"]}]'::jsonb),
    ('species_quail_rabbit', 'biosecurity_species', 'quail_rabbit', 20, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot"]},{"field":"issue","operator":"in","values":["Quail / Rabbit"]}]'::jsonb),
    ('species_sheep_cow', 'biosecurity_species', 'sheep_cow', 20, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot"]},{"field":"issue","operator":"in","values":["Sheep / Cow"]}]'::jsonb),
    ('species_other', 'biosecurity_species', 'other', 1000, '[{"field":"subject","operator":"in","values":["Animal Cull","Animal Seen","Animal Shot"]},{"field":"issue","operator":"non_empty"}]'::jsonb)
)
INSERT INTO public.import_value_classification_rules(
  organization_id, source_profile, rule_code, target_code_id, conditions, priority
)
SELECT 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', seed.rule_code, code.id, seed.conditions, seed.priority
FROM rule_seed seed
JOIN public.reference_codes code
  ON code.organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'
 AND code.code_type = seed.target_type
 AND code.code = seed.target_code
JOIN public.import_source_profiles profile
  ON profile.organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'
 AND profile.profile_code = 'rm_patrol_log'
ON CONFLICT (organization_id, source_profile, rule_code) DO UPDATE SET
  target_code_id = EXCLUDED.target_code_id,
  conditions = EXCLUDED.conditions,
  priority = EXCLUDED.priority,
  active = true,
  updated_at = now();
