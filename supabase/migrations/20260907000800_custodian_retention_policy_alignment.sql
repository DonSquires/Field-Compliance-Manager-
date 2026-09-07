-- Align existing retention policy configuration with the owner Custodian policy.
-- Permanent classes use is_permanent instead of an artificial day count.

ALTER TABLE public.retention_policies
  ALTER COLUMN retention_days DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS is_permanent boolean NOT NULL DEFAULT false;

ALTER TABLE public.retention_policies
  DROP CONSTRAINT IF EXISTS retention_policies_category_check;
ALTER TABLE public.retention_policies
  ADD CONSTRAINT retention_policies_category_check CHECK (
    category IN ('infringement', 'non_infringement', 'hold_default', 'interaction_permanent', 'observation_30_day', 'canonical_indefinite', 'legal_hold')
  );
ALTER TABLE public.retention_policies
  DROP CONSTRAINT IF EXISTS retention_policies_retention_days_check;
ALTER TABLE public.retention_policies
  ADD CONSTRAINT retention_policies_retention_days_check CHECK (
    retention_days IS NULL OR retention_days >= 0
  );

UPDATE public.retention_policies
SET retention_days = 30,
    is_permanent = false,
    legal_basis = 'Owner Custodian policy - non-interaction observation/photo evidence expires after 30 days when unlinked'
WHERE organization_id IS NULL
  AND module_key IS NULL
  AND category = 'non_infringement'
  AND is_active = true;

INSERT INTO public.retention_policies (organization_id, module_key, category, retention_days, is_permanent, legal_basis)
SELECT NULL, NULL, 'observation_30_day', 30, false, 'Owner Custodian policy - non-interaction observations expire after 30 days when unlinked'
WHERE NOT EXISTS (
  SELECT 1 FROM public.retention_policies
  WHERE organization_id IS NULL AND module_key IS NULL AND category = 'observation_30_day' AND is_active = true
);
INSERT INTO public.retention_policies (organization_id, module_key, category, retention_days, is_permanent, legal_basis)
SELECT NULL, NULL, 'interaction_permanent', NULL, true, 'Owner Custodian policy - operational, contractual, safety, compliance, investigative, and legal interactions are permanent'
WHERE NOT EXISTS (
  SELECT 1 FROM public.retention_policies
  WHERE organization_id IS NULL AND module_key IS NULL AND category = 'interaction_permanent' AND is_active = true
);
INSERT INTO public.retention_policies (organization_id, module_key, category, retention_days, is_permanent, legal_basis)
SELECT NULL, NULL, 'canonical_indefinite', NULL, true, 'Owner Custodian policy - canonical people and vehicles are retained indefinitely'
WHERE NOT EXISTS (
  SELECT 1 FROM public.retention_policies
  WHERE organization_id IS NULL AND module_key IS NULL AND category = 'canonical_indefinite' AND is_active = true
);
INSERT INTO public.retention_policies (organization_id, module_key, category, retention_days, is_permanent, legal_basis)
SELECT NULL, NULL, 'legal_hold', NULL, true, 'Owner Custodian policy - legal, investigation, complaint, insurance, court, and regulator holds override ordinary expiry'
WHERE NOT EXISTS (
  SELECT 1 FROM public.retention_policies
  WHERE organization_id IS NULL AND module_key IS NULL AND category = 'legal_hold' AND is_active = true
);
