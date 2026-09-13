-- Modular platform: extend organization_modules/org_module_subscriptions
-- (already built for field-ops verticals) to also cover the platform modules
-- that were previously hardcoded as always-on: crm, rostering, hr, finance,
-- welfare. Additive and non-breaking — existing orgs are backfilled enabled,
-- so behaviour is unchanged today; new orgs can now subscribe module-by-module.

INSERT INTO public.module_catalog (module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active)
VALUES
  ('crm', 0, 0, 0, 'monthly', 'NZD', true),
  ('rostering', 0, 0, 0, 'monthly', 'NZD', true),
  ('hr', 0, 0, 0, 'monthly', 'NZD', true),
  ('finance', 0, 0, 0, 'monthly', 'NZD', true),
  ('welfare', 0, 0, 0, 'monthly', 'NZD', true)
ON CONFLICT (module_key) DO NOTHING;

-- Backfill: every existing billable org keeps every platform module enabled,
-- preserving current behaviour exactly. New orgs are NOT backfilled here —
-- they go through self-serve activation instead.
INSERT INTO public.organization_modules (organization_id, module_key, enabled)
SELECT o.id, m.module_key, true
FROM public.organizations o
CROSS JOIN (VALUES ('crm'), ('rostering'), ('hr'), ('finance'), ('welfare')) AS m(module_key)
WHERE o.organization_type IN ('service_provider', 'branch')
ON CONFLICT (organization_id, module_key) DO NOTHING;

-- Declarative module dependency edges. Only real hard dependencies belong
-- here (confirmed against finance_pl_periods_and_cost_capture.sql, which FKs
-- finance cost captures into shifts/roster_work_units) — field-ops verticals
-- have zero hard dependencies on each other and are deliberately absent.
CREATE TABLE IF NOT EXISTS public.module_dependencies (
  module_key text NOT NULL REFERENCES public.module_catalog(module_key) ON DELETE CASCADE,
  depends_on_module_key text NOT NULL REFERENCES public.module_catalog(module_key) ON DELETE RESTRICT,
  reason text NOT NULL,
  PRIMARY KEY (module_key, depends_on_module_key),
  CONSTRAINT module_dependencies_not_self CHECK (module_key <> depends_on_module_key)
);

ALTER TABLE public.module_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_dependencies_select ON public.module_dependencies FOR SELECT TO authenticated USING (true);
REVOKE ALL ON TABLE public.module_dependencies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.module_dependencies TO authenticated;
GRANT ALL ON TABLE public.module_dependencies TO service_role;

INSERT INTO public.module_dependencies (module_key, depends_on_module_key, reason)
VALUES ('finance', 'rostering', 'Finance cost capture is derived from shifts and roster_work_units; it has no standalone data model.')
ON CONFLICT DO NOTHING;

-- Enforce the dependency edges at the entitlement boundary itself, so a
-- provider cannot enable Finance without Rostering, or disable Rostering
-- while Finance is still active.
CREATE OR REPLACE FUNCTION public.tg_enforce_module_dependencies()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.enabled THEN
    IF EXISTS (
      SELECT 1 FROM public.module_dependencies dep
      WHERE dep.module_key = NEW.module_key
        AND NOT EXISTS (
          SELECT 1 FROM public.organization_modules om
          WHERE om.organization_id = NEW.organization_id
            AND om.module_key = dep.depends_on_module_key
            AND om.enabled
        )
    ) THEN
      RAISE EXCEPTION 'Module % requires its dependency module to be enabled first', NEW.module_key;
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.module_dependencies dep
      JOIN public.organization_modules om
        ON om.organization_id = NEW.organization_id
        AND om.module_key = dep.module_key
        AND om.enabled
      WHERE dep.depends_on_module_key = NEW.module_key
    ) THEN
      RAISE EXCEPTION 'Cannot disable % while a dependent module remains enabled', NEW.module_key;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_module_dependencies ON public.organization_modules;
CREATE TRIGGER trg_enforce_module_dependencies
  BEFORE INSERT OR UPDATE OF enabled ON public.organization_modules
  FOR EACH ROW EXECUTE FUNCTION public.tg_enforce_module_dependencies();

REVOKE ALL ON FUNCTION public.tg_enforce_module_dependencies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_enforce_module_dependencies() TO service_role;
