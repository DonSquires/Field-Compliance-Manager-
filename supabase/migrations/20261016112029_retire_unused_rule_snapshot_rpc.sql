-- Observation rule snapshots are captured by
-- capture_observation_effective_rule_snapshot(). The generic mutation RPC has
-- no production caller or distinct live record path, so keeping it exposed
-- creates a second unaudited way to write the immutable snapshot ledger.
DROP FUNCTION IF EXISTS public.capture_effective_rule_snapshot(
  uuid,
  text,
  uuid,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  jsonb,
  text,
  text,
  uuid,
  timestamptz
);