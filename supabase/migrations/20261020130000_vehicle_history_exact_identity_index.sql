-- Keep exact case-insensitive plate matching without ILIKE inside an RLS OR.
-- Equality on a stored key can use an index before per-row access evaluation.
ALTER TABLE public.observations
  ADD COLUMN plate_number_upper text GENERATED ALWAYS AS (upper(plate_number)) STORED;

CREATE INDEX idx_observations_plate_upper_history
  ON public.observations (plate_number_upper, observed_at DESC);

COMMENT ON COLUMN public.observations.plate_number_upper IS
  'Derived exact-registration lookup key. Preserves case-insensitive plate history matching via indexed equality under caller RLS; never an independent identity or writable business field.';
