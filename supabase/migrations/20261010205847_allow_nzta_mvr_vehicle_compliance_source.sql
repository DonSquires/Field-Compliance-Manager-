ALTER TABLE public.canonical_vehicles
  DROP CONSTRAINT canonical_vehicles_compliance_source_check;

ALTER TABLE public.canonical_vehicles
  ADD CONSTRAINT canonical_vehicles_compliance_source_check
  CHECK (compliance_source = ANY (ARRAY[
    'motoweb'::text,
    'manual'::text,
    'canonical'::text,
    'nzta_mvr'::text
  ]));