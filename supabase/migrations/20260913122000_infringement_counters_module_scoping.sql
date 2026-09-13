-- infringement_notice_counters was unique on organization_id alone, so a
-- parking_enforcement notice generator sharing this table with the existing
-- freedom_camping one would corrupt/share the wrong sequence for any org
-- running both modules. Scope by module_key; existing rows are
-- freedom_camping (the only module that has ever used this table).
ALTER TABLE public.infringement_notice_counters
  ADD COLUMN IF NOT EXISTS module_key text NOT NULL DEFAULT 'freedom_camping';

ALTER TABLE public.infringement_notice_counters
  DROP CONSTRAINT IF EXISTS infringement_notice_counters_organization_id_key;
ALTER TABLE public.infringement_notice_counters
  DROP CONSTRAINT IF EXISTS infringement_notice_counters_org_module_key;
ALTER TABLE public.infringement_notice_counters
  ADD CONSTRAINT infringement_notice_counters_org_module_key
  UNIQUE (organization_id, module_key);
