-- notice_templates had no module scoping: one org could only have a single
-- active template per notice_type across ALL modules, so freedom_camping,
-- parking_enforcement, and noise_control could never each carry their own
-- per-org template even though they issue genuinely different notice types
-- (infringement/notice_to_vacate for FC+parking, end/seizure for noise).
-- Existing rows are freedom_camping (the only module this table has ever
-- served); default new column to that so nothing currently active changes.
ALTER TABLE public.notice_templates
  ADD COLUMN IF NOT EXISTS module_key text NOT NULL DEFAULT 'freedom_camping';

ALTER TABLE public.notice_templates
  DROP CONSTRAINT IF EXISTS notice_templates_module_key_check;
ALTER TABLE public.notice_templates
  ADD CONSTRAINT notice_templates_module_key_check
  CHECK (module_key = ANY (ARRAY['freedom_camping', 'parking_enforcement', 'noise_control', 'smoke_complaints', 'biosecurity']));

-- The old (organization_id, notice_type, version) uniqueness let two modules
-- collide on the same notice_type/version; replace with module-aware key.
ALTER TABLE public.notice_templates
  DROP CONSTRAINT IF EXISTS notice_templates_organization_id_notice_type_version_key;
ALTER TABLE public.notice_templates
  ADD CONSTRAINT notice_templates_org_module_type_version_key
  UNIQUE (organization_id, module_key, notice_type, version);

CREATE INDEX IF NOT EXISTS idx_notice_templates_org_module_type_active
  ON public.notice_templates (organization_id, module_key, notice_type, is_active);

COMMENT ON COLUMN public.notice_templates.module_key IS
  'Enforcement module this template belongs to. A single organization can hold one active template per (module_key, notice_type) pair -- e.g. NCC freedom_camping infringement wording differs from NCC parking_enforcement infringement wording.';
