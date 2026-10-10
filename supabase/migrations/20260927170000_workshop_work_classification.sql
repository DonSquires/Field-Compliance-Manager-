-- Work classifications are catalog data. The app, import rules and work orders
-- all read the same organization-scoped reference_codes rows; no UI or importer
-- owns a parallel list. Initial R&M values come from the reviewed source header.
ALTER TABLE public.reference_codes DROP CONSTRAINT IF EXISTS reference_codes_code_type_check;
ALTER TABLE public.reference_codes ADD CONSTRAINT reference_codes_code_type_check CHECK (
  code_type = ANY (ARRAY[
    'pay_item'::text, 'gl_account'::text, 'role_code'::text, 'job_code'::text,
    'branch'::text, 'org_code'::text, 'service_code'::text,
    'work_subject'::text, 'work_activity'::text
  ])
);

WITH code_seed(organization_id, code_type, code, name, description, is_active, sort_order, external_refs) AS (
VALUES
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_subject', 'physical_lock', 'Physical lock (key or combination)', 'A keyed, padlock, or combination lock; distinct from an electronic lock.', true, 10, '{}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_subject', 'electronic_lock', 'Electronic lock (E-Lock / digital)', 'An electronic or digital lock; distinct from a keyed or combination lock.', true, 20, '{}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_subject', 'gate', 'Gate', 'Gate, barrier, hinge, or gate-closing hardware.', true, 30, '{}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_subject', 'camera', 'Camera', 'Camera or associated surveillance hardware.', true, 40, '{}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_subject', 'general', 'General', 'General work where the source does not name a more specific object.', true, 90, '{}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_subject', 'other', 'Other', 'A reviewed subject not yet represented by a more specific active catalog row.', true, 100, '{}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_activity', 'installation', 'Installation', 'Install new equipment or hardware.', true, 10, '{"work_order_candidate":true}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_activity', 'maintenance', 'Maintenance or repair', 'Repair, replace, adjust, or maintain existing equipment.', true, 20, '{"work_order_candidate":true}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_activity', 'inspection', 'Inspection or check', 'Check or survey without evidence of a repair requirement.', true, 30, '{"work_order_candidate":false}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_activity', 'securing', 'Secure or close', 'Routine securing or closing activity.', true, 40, '{"work_order_candidate":false}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_activity', 'materials', 'Materials', 'Materials purchase or collection context.', true, 50, '{"work_order_candidate":false}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_activity', 'travel', 'Travel', 'Travel-only context.', true, 60, '{"work_order_candidate":false}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_activity', 'administration', 'Administration', 'Administrative or shift-start context.', true, 70, '{"work_order_candidate":false}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'work_activity', 'other', 'Other', 'A reviewed activity not yet represented by a more specific active catalog row.', true, 100, '{"work_order_candidate":false}'::jsonb)
)
INSERT INTO public.reference_codes(
  organization_id, code_type, code, name, description, is_active, sort_order, external_refs
) SELECT organization.id, seed.code_type, seed.code, seed.name, seed.description, seed.is_active, seed.sort_order, seed.external_refs
FROM code_seed seed
JOIN public.organizations organization ON organization.id = seed.organization_id::uuid
ON CONFLICT (organization_id, code_type, code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order,
  external_refs = EXCLUDED.external_refs,
  updated_at = now();

CREATE TABLE IF NOT EXISTS public.import_source_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_code text NOT NULL,
  name text NOT NULL,
  parser text NOT NULL,
  column_mappings jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_mappings jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_source_profiles_column_mappings_object CHECK (jsonb_typeof(column_mappings) = 'object'),
  CONSTRAINT import_source_profiles_target_mappings_object CHECK (jsonb_typeof(target_mappings) = 'object'),
  CONSTRAINT import_source_profiles_org_code_key UNIQUE (organization_id, profile_code)
);
COMMENT ON TABLE public.import_source_profiles IS
  'Data-defined import adapters: parser choice and source-header aliases by logical field. New source layouts are configured as rows rather than code branches.';

CREATE TABLE IF NOT EXISTS public.import_value_classification_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_profile text NOT NULL,
  rule_code text NOT NULL,
  target_code_id uuid NOT NULL REFERENCES public.reference_codes(id) ON DELETE RESTRICT,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_value_classification_rules_conditions_array CHECK (jsonb_typeof(conditions) = 'array'),
  CONSTRAINT import_value_classification_rules_profile_fkey FOREIGN KEY (organization_id, source_profile) REFERENCES public.import_source_profiles(organization_id, profile_code) ON DELETE CASCADE,
  CONSTRAINT import_value_classification_rules_org_profile_code_key UNIQUE (organization_id, source_profile, rule_code)
);
COMMENT ON TABLE public.import_value_classification_rules IS
  'Ordered, organization-scoped data rules that map source field values to reference_codes. Importers interpret these rows; they do not own a hard-coded taxonomy.';
CREATE INDEX IF NOT EXISTS import_value_classification_rules_lookup
  ON public.import_value_classification_rules(organization_id, source_profile, active, priority);

CREATE TABLE IF NOT EXISTS public.import_person_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_profile text NOT NULL,
  alias_value text NOT NULL,
  alias_norm text NOT NULL,
  user_profile_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_person_aliases_profile_fkey FOREIGN KEY (organization_id, source_profile) REFERENCES public.import_source_profiles(organization_id, profile_code) ON DELETE CASCADE,
  CONSTRAINT import_person_aliases_org_profile_norm_key UNIQUE (organization_id, source_profile, alias_norm)
);
COMMENT ON TABLE public.import_person_aliases IS
  'Reviewed source-name to staff-profile mappings used by import adapters. Importers load these rows; staff identity is never embedded in importer code.';
CREATE INDEX IF NOT EXISTS import_person_aliases_profile
  ON public.import_person_aliases(organization_id, user_profile_id, active);

CREATE OR REPLACE FUNCTION public.enforce_import_value_rule_catalog_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE v_code public.reference_codes%rowtype;
BEGIN
  SELECT * INTO v_code FROM public.reference_codes WHERE id = NEW.target_code_id;
  IF NOT FOUND OR v_code.organization_id <> NEW.organization_id OR v_code.code_type NOT IN ('work_subject', 'work_activity') THEN
    RAISE EXCEPTION 'Classification rule target must be an organization work subject or activity code';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_import_value_rule_catalog_scope() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_import_value_rule_catalog_scope() TO postgres;
DROP TRIGGER IF EXISTS trg_import_value_rule_catalog_scope ON public.import_value_classification_rules;
CREATE TRIGGER trg_import_value_rule_catalog_scope BEFORE INSERT OR UPDATE ON public.import_value_classification_rules
FOR EACH ROW EXECUTE FUNCTION public.enforce_import_value_rule_catalog_scope();

CREATE TABLE IF NOT EXISTS public.file_import_row_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES public.file_import_batches(id) ON DELETE CASCADE,
  source_record_key text NOT NULL,
  source_row_number integer,
  target_type text NOT NULL,
  proposed_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(5,4),
  status text NOT NULL DEFAULT 'proposed',
  review_reason text,
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  applied_target_id uuid,
  applied_at timestamptz,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_import_row_proposals_status_check CHECK (status IN ('proposed', 'approved', 'rejected', 'applied', 'failed')),
  CONSTRAINT file_import_row_proposals_confidence_check CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT file_import_row_proposals_source_target_key UNIQUE (batch_id, source_record_key, target_type)
);
COMMENT ON TABLE public.file_import_row_proposals IS
  'Human-review boundary between staged source rows and consequential records such as work orders or finance costs. Proposed payloads never apply themselves.';
CREATE INDEX IF NOT EXISTS file_import_row_proposals_review_queue
  ON public.file_import_row_proposals(organization_id, status, created_at DESC);

ALTER TABLE public.import_source_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_value_classification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_person_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_import_row_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_source_profiles_select ON public.import_source_profiles;
CREATE POLICY import_source_profiles_select ON public.import_source_profiles
  FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id) OR public.is_grand_master());
DROP POLICY IF EXISTS import_value_classification_rules_select ON public.import_value_classification_rules;
CREATE POLICY import_value_classification_rules_select ON public.import_value_classification_rules
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
DROP POLICY IF EXISTS import_person_aliases_select ON public.import_person_aliases;
CREATE POLICY import_person_aliases_select ON public.import_person_aliases
  FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id) OR public.is_grand_master());
DROP POLICY IF EXISTS file_import_row_proposals_select ON public.file_import_row_proposals;
CREATE POLICY file_import_row_proposals_select ON public.file_import_row_proposals
  FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id) OR public.is_grand_master());
REVOKE ALL ON TABLE public.import_source_profiles FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.import_source_profiles TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.import_source_profiles TO postgres, service_role;
REVOKE ALL ON TABLE public.import_value_classification_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.import_value_classification_rules TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.import_value_classification_rules TO postgres, service_role;
REVOKE ALL ON TABLE public.import_person_aliases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.import_person_aliases TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.import_person_aliases TO postgres, service_role;
REVOKE ALL ON TABLE public.file_import_row_proposals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.file_import_row_proposals TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.file_import_row_proposals TO postgres, service_role;

INSERT INTO public.import_source_profiles(organization_id, profile_code, name, parser, column_mappings, target_mappings)
SELECT organization.id, 'rm_patrol_log', 'R&M patrol and field ledger', 'csv',
  '{
    "job":["Job","Log No"],
    "patroller":["Patroller"],
    "date":["Date"],
    "time":["Time","24hr Time"],
    "reserve":["Reserve","CODE","Forest","Site"],
    "location":["Location"],
    "comments":["Comments","Description/Comments"],
    "registration":["Reg"],
    "job_time":["Job Time","Job Time NCC","Job Time OFO","Job Time TPFL"],
    "job_km":["Job KMs","Job Km NCC","Job kms","Job KM OFO","Job KM","Job KM TPFL"],
    "source":["Source"],
    "subject":["Subject"],
    "issue":["Issue"],
    "action_by":["Action by","Action By"],
    "job_cost":["Job Cost"],
    "travel_cost":["Travel Cost"],
    "total_cost":["Total Cost"]
  }'::jsonb,
  '{
    "job":{"target_entity":"observations|location_events","target_field":"external_ref"},
    "patroller":{"target_entity":"observations|location_events","target_field":"officer_id|observed_entity_id"},
    "date":{"target_entity":"observations|location_events","target_field":"observed_at|occurred_at"},
    "time":{"target_entity":"observations|location_events","target_field":"observed_at|occurred_at"},
    "reserve":{"target_entity":"observations|location_events","target_field":"zone_id"},
    "location":{"target_entity":"observations|location_events","target_field":"site_id|zone_id"},
    "comments":{"target_entity":"observations|location_events","target_field":"officer_notes|payload.comments"},
    "registration":{"target_entity":"observations|location_events","target_field":"plate_number|payload.reg_raw"},
    "job_time":{"target_entity":"observations|location_events","target_field":"external_refs.import.job_time_hours|payload.job_time_hours"},
    "job_km":{"target_entity":"observations|location_events","target_field":"distance_km"},
    "source":{"target_entity":"observations|location_events","target_field":"external_refs.import.source_category|payload.source_category"},
    "subject":{"target_entity":"observations|location_events","target_field":"external_refs.import.subject|payload.subject"},
    "issue":{"target_entity":"observations|location_events","target_field":"external_refs.import.issue|payload.issue"},
    "action_by":{"target_entity":"observations|location_events","target_field":"external_refs.import.action_by|payload.action_by"},
    "job_cost":{"target_entity":"file_import_row_proposals","target_field":"source_values.job_cost"},
    "travel_cost":{"target_entity":"file_import_row_proposals","target_field":"source_values.travel_cost"},
    "total_cost":{"target_entity":"file_import_row_proposals","target_field":"source_values.total_cost"}
  }'::jsonb
FROM public.organizations organization
WHERE organization.id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'
ON CONFLICT (organization_id, profile_code) DO UPDATE SET
  name = EXCLUDED.name,
  parser = EXCLUDED.parser,
  column_mappings = EXCLUDED.column_mappings,
  target_mappings = EXCLUDED.target_mappings,
  active = true,
  updated_at = now();

WITH rule_seed(rule_code, target_type, target_code, priority, conditions) AS (
  VALUES
    ('subject_electronic_lock', 'work_subject', 'electronic_lock', 10, '[{"field":"subject","operator":"in","values":["E-Lock","E Lock","Electronic Lock","Digital Lock"]}]'::jsonb),
    ('subject_physical_lock', 'work_subject', 'physical_lock', 20, '[{"field":"subject","operator":"in","values":["Lock","Locks","Padlock","Padlocks","Combination Lock","Key Lock"]}]'::jsonb),
    ('subject_gate', 'work_subject', 'gate', 30, '[{"field":"subject","operator":"regex","value":"^gates?$"}]'::jsonb),
    ('subject_camera', 'work_subject', 'camera', 30, '[{"field":"subject","operator":"regex","value":"^cameras?$"}]'::jsonb),
    ('subject_general', 'work_subject', 'general', 30, '[{"field":"subject","operator":"exact","value":"General"}]'::jsonb),
    ('subject_other', 'work_subject', 'other', 1000, '[{"field":"subject","operator":"non_empty"}]'::jsonb),
    ('activity_check_repair', 'work_activity', 'maintenance', 10, '[{"field":"issue","operator":"in","values":["Check","Inspection"]},{"field":"description","operator":"regex","value":"\\b(unable|fault|broken|damage|jammed|replace|re-?install|remove|cutting|not working|won''t|wouldn''t|only at|survey)\\b"}]'::jsonb),
    ('activity_installation', 'work_activity', 'installation', 20, '[{"field":"issue","operator":"in","values":["Installation","Install"]}]'::jsonb),
    ('activity_maintenance', 'work_activity', 'maintenance', 20, '[{"field":"issue","operator":"in","values":["Maintenance","Repair"]}]'::jsonb),
    ('activity_inspection', 'work_activity', 'inspection', 50, '[{"field":"issue","operator":"in","values":["Check","Inspection"]}]'::jsonb),
    ('activity_securing', 'work_activity', 'securing', 50, '[{"field":"issue","operator":"in","values":["Closed","Secure","Secured"]}]'::jsonb),
    ('activity_materials', 'work_activity', 'materials', 50, '[{"field":"issue","operator":"regex","value":"^materials?$"}]'::jsonb),
    ('activity_travel', 'work_activity', 'travel', 50, '[{"field":"issue","operator":"exact","value":"Travel"}]'::jsonb),
    ('activity_administration', 'work_activity', 'administration', 50, '[{"field":"issue","operator":"in","values":["Admin","Administration"]}]'::jsonb),
    ('activity_other', 'work_activity', 'other', 1000, '[{"field":"issue","operator":"non_empty"}]'::jsonb)
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
ON CONFLICT (organization_id, source_profile, rule_code) DO UPDATE SET
  target_code_id = EXCLUDED.target_code_id,
  conditions = EXCLUDED.conditions,
  priority = EXCLUDED.priority,
  active = true,
  updated_at = now();

WITH alias_seed(organization_id, source_profile, alias_value, alias_norm, user_profile_id, provenance) AS (
VALUES
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Rob Crawford', 'rob crawford', 'c1f730f2-efb2-4709-bf59-6437e3578bc3', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Colin Eathorne', 'colin eathorne', '00a5c612-7fec-411c-a7bd-21e526c81cb9', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Susan Finigan', 'susan finigan', '0cb049df-fea2-4566-a2fb-30956064ead8', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Evan Garland', 'evan garland', '9a354919-1240-4dac-a264-42857168611b', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Marty Lucas', 'marty lucas', '30cf4614-4c66-475c-929a-d9519e2061f4', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Wade Sutherland-Berkett', 'wade sutherland-berkett', '9e96c281-3dc1-449b-819f-57b61f91c739', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Wade Sutherland Berkett', 'wade sutherland berkett', '9e96c281-3dc1-449b-819f-57b61f91c739', '{"basis":"reviewed patrol log spelling variant"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Pete Crawford', 'pete crawford', '8f705807-81d5-424e-910f-3c5d8d97b80e', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Reuben Stanfield', 'reuben stanfield', '19e1ab78-abe3-4ffe-a006-66a4fab56804', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Sally Curtis', 'sally curtis', 'd65b59e3-9c21-45d4-968f-351ca6e319fe', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Colin Nelson', 'colin nelson', 'c8c102f0-bec6-4b03-a7a3-160f7a7585d1', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Ash Bremner', 'ash bremner', '822509e2-7bf0-4177-b895-d27034b30252', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Dan Douglas', 'dan douglas', '60b73649-ddae-4386-be6b-3d9243db625c', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Dave Porter', 'dave porter', '5bd14029-b00b-4240-b42a-c739c168b6e4', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'A Goodall', 'a goodall', '107e5596-a859-4fe7-900f-aa98b7f2147c', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Glenn Gribben', 'glenn gribben', 'c844ff45-eaf6-439a-bc51-b6065a6acabd', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Steve Henery', 'steve henery', '1a80c0eb-bfe9-4c75-b6d1-659b13b0bc75', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Andrew Curtis', 'andrew curtis', 'a77d3dfd-9fb9-4543-9928-421b369aa847', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Jacob Lucas', 'jacob lucas', 'a4c07cc6-530a-401d-8781-414f382ebe06', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Deb Crawford', 'deb crawford', '368b4d00-604b-47f9-9656-9471a0f8ee6e', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Deborah Crawford', 'deborah crawford', '368b4d00-604b-47f9-9656-9471a0f8ee6e', '{"basis":"reviewed patrol log spelling variant"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Ken Eccles', 'ken eccles', '3c25162f-d6dc-44c2-88b2-5607a322d7f9', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Don Squires', 'don squires', '08369a00-e2df-45d6-9e6b-6b3a6bede645', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Beau Webster', 'beau webster', '91e8e27b-1bc1-4e69-8d42-e8a816d853dc', '{"basis":"reviewed patrol log identity"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Steve Savage', 'steve savage', 'a9342300-f1c7-4402-8c2e-4de5689fda5a', '{"basis":"roster and culling-log corroboration"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Sheryl Murray', 'sheryl murray', 'ce9f16b8-bb7f-4e60-929a-64458fefb347', '{"basis":"roster and culling-log corroboration"}'::jsonb),
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'rm_patrol_log', 'Waz', 'waz', 'ee7ded2c-f2b4-4ac3-bd8c-2cc376d94331', '{"basis":"owner-approved placeholder pending surname confirmation"}'::jsonb)
)
INSERT INTO public.import_person_aliases(
  organization_id, source_profile, alias_value, alias_norm, user_profile_id, provenance
)
SELECT organization.id, seed.source_profile, seed.alias_value, seed.alias_norm, profile.id, seed.provenance
FROM alias_seed seed
JOIN public.organizations organization ON organization.id = seed.organization_id::uuid
JOIN public.user_profiles profile ON profile.id = seed.user_profile_id::uuid AND profile.organization_id = organization.id
ON CONFLICT (organization_id, source_profile, alias_norm) DO UPDATE SET
  alias_value = EXCLUDED.alias_value,
  user_profile_id = EXCLUDED.user_profile_id,
  active = true,
  provenance = EXCLUDED.provenance,
  updated_at = now();

ALTER TABLE public.workshop_work_orders
  ADD COLUMN IF NOT EXISTS work_subject_code_id uuid,
  ADD COLUMN IF NOT EXISTS work_activity_code_id uuid;
ALTER TABLE public.workshop_work_orders
  DROP CONSTRAINT IF EXISTS workshop_work_orders_work_subject_code_id_fkey,
  ADD CONSTRAINT workshop_work_orders_work_subject_code_id_fkey FOREIGN KEY (work_subject_code_id) REFERENCES public.reference_codes(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS workshop_work_orders_work_activity_code_id_fkey,
  ADD CONSTRAINT workshop_work_orders_work_activity_code_id_fkey FOREIGN KEY (work_activity_code_id) REFERENCES public.reference_codes(id) ON DELETE RESTRICT;
COMMENT ON COLUMN public.workshop_work_orders.work_subject_code_id IS 'Catalog row describing the object of the work; labels and options come from reference_codes.';
COMMENT ON COLUMN public.workshop_work_orders.work_activity_code_id IS 'Catalog row describing the work action; labels and options come from reference_codes.';

UPDATE public.workshop_work_orders work_order
SET work_subject_code_id = subject.id, work_activity_code_id = activity.id
FROM public.reference_codes subject, public.reference_codes activity
WHERE work_order.order_number = 'WO-202609-0002'
  AND work_order.organization_id = subject.organization_id
  AND work_order.organization_id = activity.organization_id
  AND subject.code_type = 'work_subject' AND subject.code = 'gate'
  AND activity.code_type = 'work_activity' AND activity.code = 'maintenance'
  AND work_order.kind = 'maintenance'
  AND work_order.work_subject_code_id IS NULL
  AND work_order.work_activity_code_id IS NULL;

CREATE OR REPLACE FUNCTION public.create_workshop_work_order(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_kind text,
  p_title text,
  p_work_subject_code_id uuid,
  p_work_activity_code_id uuid,
  p_description text DEFAULT NULL,
  p_client_organization_id uuid DEFAULT NULL,
  p_service_agreement_id uuid DEFAULT NULL,
  p_client_site_id uuid DEFAULT NULL,
  p_asset_id uuid DEFAULT NULL,
  p_inventory_location_id uuid DEFAULT NULL,
  p_assigned_user_id uuid DEFAULT NULL,
  p_scheduled_for timestamptz DEFAULT NULL,
  p_bom_template_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL
) RETURNS public.workshop_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.workshop_work_orders%rowtype;
  v_subject public.reference_codes%rowtype;
  v_activity public.reference_codes%rowtype;
BEGIN
  IF p_kind = 'maintenance' THEN
    SELECT * INTO v_subject FROM public.reference_codes
    WHERE id = p_work_subject_code_id
      AND organization_id = p_organization_id
      AND code_type = 'work_subject'
      AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Choose what the maintenance work is for';
    END IF;
    SELECT * INTO v_activity FROM public.reference_codes
    WHERE id = p_work_activity_code_id
      AND organization_id = p_organization_id
      AND code_type = 'work_activity'
      AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Choose what maintenance work is being done';
    END IF;
  ELSE
    p_work_subject_code_id := NULL;
    p_work_activity_code_id := NULL;
  END IF;

  v_order := public.create_workshop_work_order(
    p_client_request_id => p_client_request_id,
    p_organization_id => p_organization_id,
    p_kind => p_kind,
    p_title => p_title,
    p_description => p_description,
    p_client_organization_id => p_client_organization_id,
    p_service_agreement_id => p_service_agreement_id,
    p_client_site_id => p_client_site_id,
    p_asset_id => p_asset_id,
    p_inventory_location_id => p_inventory_location_id,
    p_assigned_user_id => p_assigned_user_id,
    p_scheduled_for => p_scheduled_for,
    p_bom_template_id => p_bom_template_id,
    p_zone_id => p_zone_id
  );

  IF v_order.work_subject_code_id IS DISTINCT FROM p_work_subject_code_id
     OR v_order.work_activity_code_id IS DISTINCT FROM p_work_activity_code_id THEN
    UPDATE public.workshop_work_orders
    SET work_subject_code_id = p_work_subject_code_id,
        work_activity_code_id = p_work_activity_code_id,
        updated_at = now()
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_organization_id, auth.uid(), 'workshop_work_order_classified', 'workshop_work_orders', v_order.id,
      jsonb_build_object(
        'work_subject_code_id', p_work_subject_code_id,
        'work_subject_code', v_subject.code,
        'work_activity_code_id', p_work_activity_code_id,
        'work_activity_code', v_activity.code
      ));
  END IF;

  RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_workshop_work_order(uuid, uuid, text, text, uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_workshop_work_order(uuid, uuid, text, text, uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, uuid) TO postgres, authenticated, service_role;

CREATE OR REPLACE VIEW public.workshop_work_order_summary WITH (security_invoker=true) AS
 SELECT wo.id,
    wo.organization_id,
    wo.order_number,
    wo.kind,
    wo.status,
    wo.title,
    wo.description,
    wo.client_organization_id,
    co.name AS client_name,
    wo.service_agreement_id,
    wo.client_site_id,
    cs.name AS site_name,
    wo.asset_id,
    a.name AS asset_name,
    wo.inventory_location_id,
    il.name AS stock_location_name,
    wo.bom_template_id,
    t.name AS template_name,
    wo.assigned_user_id,
    up.display_name AS assigned_name,
    wo.scheduled_for,
    wo.started_at,
    wo.completed_at,
    wo.cancelled_at,
    wo.completion_note,
    wo.created_at,
    wo.updated_at,
    COALESCE(l.line_count, 0::bigint) AS line_count,
    COALESCE(l.charge_total, 0::numeric) AS charge_total,
    COALESCE(l.cost_total, 0::numeric) AS cost_total,
    COALESCE(l.uninvoiced_total, 0::numeric) AS uninvoiced_total,
    wo.zone_id,
    z.name AS zone_name,
    wo.work_subject_code_id,
    subject.code AS work_subject_code,
    subject.name AS work_subject_name,
    wo.work_activity_code_id,
    activity.code AS work_activity_code,
    activity.name AS work_activity_name
   FROM public.workshop_work_orders wo
     LEFT JOIN public.organizations co ON co.id = wo.client_organization_id
     LEFT JOIN public.client_sites cs ON cs.id = wo.client_site_id
     LEFT JOIN public.location_zones z ON z.id = wo.zone_id
     LEFT JOIN public.assets a ON a.id = wo.asset_id
     LEFT JOIN public.finance_inventory_locations il ON il.id = wo.inventory_location_id
     LEFT JOIN public.workshop_bom_templates t ON t.id = wo.bom_template_id
     LEFT JOIN public.user_profiles up ON up.id = wo.assigned_user_id
    LEFT JOIN public.reference_codes subject ON subject.id = wo.work_subject_code_id
    LEFT JOIN public.reference_codes activity ON activity.id = wo.work_activity_code_id
     LEFT JOIN LATERAL (
       SELECT count(*) AS line_count,
         sum(line.line_total) AS charge_total,
         sum(round(line.quantity * line.unit_cost, 2)) AS cost_total,
         sum(line.line_total) FILTER (WHERE line.invoice_line_item_id IS NULL) AS uninvoiced_total
       FROM public.workshop_work_order_lines line
       WHERE line.work_order_id = wo.id
     ) l ON true;

COMMENT ON VIEW public.workshop_work_order_summary IS
  'One row per work order with catalog-backed subject/activity names and line totals resolved. Inherits RLS via security_invoker.';

CREATE OR REPLACE FUNCTION public.review_file_import_row_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_reason text
) RETURNS public.file_import_row_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_proposal public.file_import_row_proposals%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;
  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Review reason is required'; END IF;
  SELECT * INTO v_proposal FROM public.file_import_row_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import proposal not found'; END IF;
  IF NOT (public.is_admin_for_org(v_proposal.organization_id) OR public.is_grand_master()) THEN RAISE EXCEPTION 'Import review access required'; END IF;
  IF v_proposal.status <> 'proposed' THEN RAISE EXCEPTION 'Only proposed import rows can be reviewed'; END IF;
  UPDATE public.file_import_row_proposals
  SET status = p_decision, review_reason = trim(p_reason), reviewed_by = v_actor,
      reviewed_at = now(), updated_at = now()
  WHERE id = v_proposal.id
  RETURNING * INTO v_proposal;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_proposal.organization_id, v_actor, 'file_import_row_proposal_reviewed', 'file_import_row_proposals', v_proposal.id,
    jsonb_build_object('batch_id', v_proposal.batch_id, 'target_type', v_proposal.target_type, 'decision', p_decision));
  RETURN v_proposal;
END;
$function$;
REVOKE ALL ON FUNCTION public.review_file_import_row_proposal(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_file_import_row_proposal(uuid, text, text) TO postgres, authenticated, service_role;;
