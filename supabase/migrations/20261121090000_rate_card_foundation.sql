-- Foundation only: existing prices remain in rate_rules and the existing
-- resolver remains authoritative until the separately governed cut-over.
BEGIN;

CREATE TABLE IF NOT EXISTS public.rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('charge', 'pay')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  client_organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  payroll_role_code text,
  is_standard boolean NOT NULL DEFAULT false,
  is_client_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  CONSTRAINT rate_cards_kind_scope_check CHECK (
    (kind = 'charge' AND payroll_role_code IS NULL
      AND (is_standard OR client_organization_id IS NOT NULL))
    OR (kind = 'pay' AND client_organization_id IS NULL AND NOT is_client_default)
  ),
  CONSTRAINT rate_cards_standard_scope_check CHECK (
    NOT is_standard OR (client_organization_id IS NULL AND payroll_role_code IS NULL AND NOT is_client_default)
  ),
  CONSTRAINT rate_cards_client_default_scope_check CHECK (
    NOT is_client_default OR (kind = 'charge' AND client_organization_id IS NOT NULL AND NOT is_standard)
  ),
  CONSTRAINT rate_cards_agreement_scope_key UNIQUE (id, organization_id, client_organization_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS rate_cards_one_active_standard_per_kind
  ON public.rate_cards (organization_id, kind) WHERE active AND is_standard;
CREATE UNIQUE INDEX IF NOT EXISTS rate_cards_one_active_client_default
  ON public.rate_cards (organization_id, client_organization_id) WHERE active AND is_client_default;
CREATE INDEX IF NOT EXISTS rate_cards_client_organization_idx
  ON public.rate_cards (client_organization_id) WHERE client_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rate_cards_created_by_idx ON public.rate_cards (created_by);
CREATE INDEX IF NOT EXISTS rate_cards_updated_by_idx ON public.rate_cards (updated_by);

CREATE TABLE IF NOT EXISTS public.rate_card_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_card_id uuid NOT NULL REFERENCES public.rate_cards(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'superseded', 'retired')),
  effective_from date,
  effective_to date,
  change_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  CONSTRAINT rate_card_versions_number_key UNIQUE (rate_card_id, version_number),
  CONSTRAINT rate_card_versions_dates_check CHECK (
    effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS rate_card_versions_one_draft
  ON public.rate_card_versions (rate_card_id) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS rate_card_versions_created_by_idx ON public.rate_card_versions (created_by);
CREATE INDEX IF NOT EXISTS rate_card_versions_approved_by_idx ON public.rate_card_versions (approved_by);

ALTER TABLE public.rate_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_card_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_cards, public.rate_card_versions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.rate_cards, public.rate_card_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_cards, public.rate_card_versions TO service_role;

DROP POLICY IF EXISTS rate_cards_select ON public.rate_cards;
CREATE POLICY rate_cards_select ON public.rate_cards FOR SELECT TO authenticated
  USING (public.is_grand_master() OR public.user_can_operate_organization(organization_id));
DROP POLICY IF EXISTS rate_card_versions_select ON public.rate_card_versions;
CREATE POLICY rate_card_versions_select ON public.rate_card_versions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rate_cards card WHERE card.id = rate_card_versions.rate_card_id));

ALTER TABLE public.rate_rules ADD COLUMN IF NOT EXISTS rate_card_version_id uuid;
ALTER TABLE public.rate_rules ADD COLUMN IF NOT EXISTS rate_line_key uuid;
ALTER TABLE public.rate_rules ADD COLUMN IF NOT EXISTS rate_group text;
ALTER TABLE public.service_agreements ADD COLUMN IF NOT EXISTS rate_card_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.rate_rules'::regclass
      AND conname = 'rate_rules_rate_card_version_id_fkey') THEN
    ALTER TABLE public.rate_rules ADD CONSTRAINT rate_rules_rate_card_version_id_fkey
      FOREIGN KEY (rate_card_version_id) REFERENCES public.rate_card_versions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_agreements'::regclass
      AND conname = 'service_agreements_rate_card_scope_fkey') THEN
    ALTER TABLE public.service_agreements ADD CONSTRAINT service_agreements_rate_card_scope_fkey
      FOREIGN KEY (rate_card_id, provider_organization_id, client_organization_id)
      REFERENCES public.rate_cards(id, organization_id, client_organization_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rate_rules_rate_card_version_idx ON public.rate_rules (rate_card_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS rate_rules_card_version_lineage_key
  ON public.rate_rules (rate_card_version_id, rate_line_key) WHERE rate_card_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_agreements_rate_card_idx
  ON public.service_agreements (rate_card_id) WHERE rate_card_id IS NOT NULL;

-- A card's scope and a version's parent are identity, even before lines are
-- attached. Keeping them fixed prevents concurrent assignments and reparenting
-- from invalidating one another without locking the shared rate_rules table.
CREATE OR REPLACE FUNCTION public.guard_rate_card_scope_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'rate_cards' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.client_organization_id IS DISTINCT FROM OLD.client_organization_id
      OR NEW.payroll_role_code IS DISTINCT FROM OLD.payroll_role_code THEN
      RAISE EXCEPTION 'Rate-card scope is immutable; create a card for the new scope'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.rate_card_id IS DISTINCT FROM OLD.rate_card_id THEN
    RAISE EXCEPTION 'Rate-card version scope is immutable; create a version on the intended card'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_rate_card_scope_identity() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_rate_card_scope_identity ON public.rate_cards;
CREATE TRIGGER guard_rate_card_scope_identity
  AFTER UPDATE ON public.rate_cards
  FOR EACH ROW EXECUTE FUNCTION public.guard_rate_card_scope_identity();
DROP TRIGGER IF EXISTS guard_rate_card_version_scope_identity ON public.rate_card_versions;
CREATE TRIGGER guard_rate_card_version_scope_identity
  AFTER UPDATE ON public.rate_card_versions
  FOR EACH ROW EXECUTE FUNCTION public.guard_rate_card_scope_identity();

CREATE OR REPLACE FUNCTION public.guard_rate_rule_card_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
      AND NEW.client_org_id IS NOT DISTINCT FROM OLD.client_org_id
      AND NEW.rule_kind IS NOT DISTINCT FROM OLD.rule_kind
      AND NEW.rate_card_version_id IS NOT DISTINCT FROM OLD.rate_card_version_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.rate_card_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.rate_card_versions version
    JOIN public.rate_cards card ON card.id = version.rate_card_id
    WHERE version.id = NEW.rate_card_version_id
      AND card.organization_id = NEW.organization_id
      AND ((card.kind = 'charge' AND NEW.rule_kind = 'billing'
            AND card.client_organization_id IS NOT DISTINCT FROM NEW.client_org_id)
        OR (card.kind = 'pay' AND NEW.rule_kind = 'pay'))
  ) THEN
    RAISE EXCEPTION 'Rate-card scope must match the rule organisation, client and kind'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_rate_rule_card_scope() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_rate_rule_card_scope ON public.rate_rules;
CREATE TRIGGER guard_rate_rule_card_scope
  AFTER INSERT OR UPDATE ON public.rate_rules FOR EACH ROW EXECUTE FUNCTION public.guard_rate_rule_card_scope();

-- Existing agreement UPDATE policies also allow client-side administrators.
-- Do not turn that legacy grant into an ungoverned pricing-card selection.
CREATE OR REPLACE FUNCTION public.guard_agreement_rate_card_selection()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  selection_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    selection_changed := NEW.rate_card_id IS NOT NULL;
  ELSE
    selection_changed := NEW.rate_card_id IS DISTINCT FROM OLD.rate_card_id;
  END IF;
  IF selection_changed AND current_user <> 'service_role'
    AND current_user <> pg_catalog.pg_get_userbyid(
      (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.service_agreements'::regclass)
    ) THEN
    RAISE EXCEPTION 'Rate-card selection requires a governed provider finance operation'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_agreement_rate_card_selection() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_agreement_rate_card_selection ON public.service_agreements;
CREATE TRIGGER guard_agreement_rate_card_selection BEFORE INSERT OR UPDATE OF rate_card_id
  ON public.service_agreements FOR EACH ROW EXECUTE FUNCTION public.guard_agreement_rate_card_selection();

-- An operating org with no existing prices still needs both Standard cards.
WITH branches AS (
  SELECT id AS organization_id FROM public.organizations
    WHERE active AND organization_type IN ('owner', 'service_provider', 'branch')
  UNION
  SELECT organization_id FROM public.rate_rules
)
INSERT INTO public.rate_cards (organization_id, kind, name, is_standard)
SELECT branches.organization_id, kinds.kind, 'Standard', true
FROM branches CROSS JOIN (VALUES ('charge'), ('pay')) AS kinds(kind)
ON CONFLICT (organization_id, kind) WHERE active AND is_standard DO NOTHING;

INSERT INTO public.rate_cards (organization_id, kind, name, client_organization_id, is_client_default)
SELECT DISTINCT r.organization_id, 'charge', client.name, r.client_org_id, true
FROM public.rate_rules r
JOIN public.organizations client ON client.id = r.client_org_id
WHERE r.rule_kind = 'billing' AND r.client_org_id IS NOT NULL
ON CONFLICT (organization_id, client_organization_id) WHERE active AND is_client_default DO NOTHING;

-- NULL means unbounded, not "today": legacy rules can predate any finite date.
INSERT INTO public.rate_card_versions (rate_card_id, version_number, status, effective_from, change_note)
SELECT card.id, 1, 'approved',
  CASE WHEN count(r.id) FILTER (WHERE r.active AND r.effective_from IS NULL) > 0 THEN NULL
    ELSE min(r.effective_from) FILTER (WHERE r.active) END,
  'Grandfathered legacy rates; no new price approval is implied.'
FROM public.rate_cards card
LEFT JOIN public.rate_rules r ON r.organization_id = card.organization_id AND
  ((card.kind = 'pay' AND card.is_standard AND r.rule_kind = 'pay')
    OR (card.kind = 'charge' AND r.rule_kind = 'billing'
      AND r.client_org_id IS NOT DISTINCT FROM card.client_organization_id))
WHERE card.active AND (card.is_standard OR card.is_client_default)
GROUP BY card.id
ON CONFLICT (rate_card_id, version_number) DO NOTHING;

INSERT INTO public.rate_card_versions (rate_card_id, version_number, status, effective_from, change_note)
SELECT card.id, 2, 'retired',
  CASE WHEN count(r.id) FILTER (WHERE r.effective_from IS NULL) > 0 THEN NULL
    ELSE min(r.effective_from) END,
  'Retired legacy lines; their original inactive flags and dates are preserved.'
FROM public.rate_cards card
JOIN public.rate_rules r ON r.organization_id = card.organization_id AND NOT r.active AND
  ((card.kind = 'pay' AND card.is_standard AND r.rule_kind = 'pay')
    OR (card.kind = 'charge' AND r.rule_kind = 'billing'
      AND r.client_org_id IS NOT DISTINCT FROM card.client_organization_id))
WHERE card.active AND (card.is_standard OR card.is_client_default)
GROUP BY card.id
ON CONFLICT (rate_card_id, version_number) DO NOTHING;

-- The legacy resolver uses updated_at as its last tie-breaker. Disabling only
-- that trigger inside this transaction preserves its exact previous ordering.
DO $$
DECLARE
  trigger_mode "char";
BEGIN
  SELECT tgenabled INTO trigger_mode FROM pg_trigger
  WHERE tgrelid = 'public.rate_rules'::regclass AND tgname = 'trg_rate_rules_touch' AND NOT tgisinternal;
  IF trigger_mode IN ('O', 'R', 'A') THEN
    ALTER TABLE public.rate_rules DISABLE TRIGGER trg_rate_rules_touch;
  END IF;

  UPDATE public.rate_rules r
  SET rate_card_version_id = version.id,
      rate_line_key = gen_random_uuid(),
      rate_group = coalesce(r.rate_group, CASE
        WHEN lower(concat_ws(' ', r.service_type, r.job_type, r.rate_type))
          ~ '(equipment|excavator|digger|hire|plant)' THEN 'Equipment & hire'
        WHEN r.rate_type IN ('per_km', 'per_hour_travel')
          OR lower(concat_ws(' ', r.service_type, r.job_type, r.rate_type))
            ~ '(travel|distance|mileage)' THEN 'Travel'
        WHEN r.rate_type IN ('callout', 'oncall_flat')
          OR lower(concat_ws(' ', r.service_type, r.job_type, r.rate_type))
            ~ '(response|callout|alarm)' THEN 'Response'
        WHEN r.rate_type IN ('hourly', 'daily', 'per_hour_allowance', 'higher_duties_flat')
          OR lower(concat_ws(' ', r.service_type, r.job_type, r.rate_type))
            ~ '(labour|labor|patrol|guard|staff)' THEN 'Labour'
        ELSE 'Other' END)
  FROM public.rate_cards card
  JOIN public.rate_card_versions version ON version.rate_card_id = card.id
  WHERE card.active AND (card.is_standard OR card.is_client_default)
    AND card.organization_id = r.organization_id
    AND ((card.kind = 'pay' AND card.is_standard AND r.rule_kind = 'pay')
      OR (card.kind = 'charge' AND r.rule_kind = 'billing'
        AND r.client_org_id IS NOT DISTINCT FROM card.client_organization_id))
    AND ((r.active AND version.version_number = 1 AND version.status = 'approved')
      OR (NOT r.active AND version.version_number = 2 AND version.status = 'retired'))
    AND r.rate_card_version_id IS NULL AND r.rate_line_key IS NULL;

  IF trigger_mode = 'O' THEN
    ALTER TABLE public.rate_rules ENABLE TRIGGER trg_rate_rules_touch;
  ELSIF trigger_mode = 'R' THEN
    ALTER TABLE public.rate_rules ENABLE REPLICA TRIGGER trg_rate_rules_touch;
  ELSIF trigger_mode = 'A' THEN
    ALTER TABLE public.rate_rules ENABLE ALWAYS TRIGGER trg_rate_rules_touch;
  END IF;

  IF EXISTS (SELECT 1 FROM public.rate_rules WHERE rate_line_key IS NULL) THEN
    RAISE EXCEPTION 'Rate-card backfill could not place every legacy rule; review the discrepancy report';
  END IF;
END $$;

ALTER TABLE public.rate_rules ALTER COLUMN rate_line_key SET DEFAULT gen_random_uuid();
ALTER TABLE public.rate_rules ALTER COLUMN rate_line_key SET NOT NULL;
ALTER TABLE public.rate_rules ALTER COLUMN rate_group SET DEFAULT 'Other';
ALTER TABLE public.rate_rules ALTER COLUMN rate_group SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.rate_rules'::regclass
      AND conname = 'rate_rules_rate_group_check') THEN
    ALTER TABLE public.rate_rules ADD CONSTRAINT rate_rules_rate_group_check
      CHECK (rate_group IN ('Labour', 'Response', 'Travel', 'Equipment & hire', 'Other'));
  END IF;
END $$;

COMMENT ON TABLE public.rate_cards IS
  'Named charge and pay cards owned by an operating organisation; client cards may have one active default.';
COMMENT ON TABLE public.rate_card_versions IS
  'Version metadata. Legacy approved version 1 records pre-existing prices, not a new approval decision. Approval and immutability are implemented separately.';
COMMENT ON COLUMN public.rate_card_versions.effective_from IS
  'NULL means unbounded for grandfathered rules or unset for a draft; no finite legacy start date is invented.';
COMMENT ON COLUMN public.rate_rules.rate_card_version_id IS
  'Card version for a line; nullable while legacy writers are migrated to governed versioned authoring.';
COMMENT ON COLUMN public.rate_rules.rate_line_key IS
  'Stable rate-line lineage across versions. A new copy retains its source line key.';
COMMENT ON COLUMN public.rate_rules.rate_group IS
  'Editable display group, not a price-matching dimension.';
COMMENT ON COLUMN public.service_agreements.rate_card_id IS
  'Optional agreement-selected client charge card. NULL retains the existing legacy behavior until card-aware resolution is implemented.';

COMMIT;