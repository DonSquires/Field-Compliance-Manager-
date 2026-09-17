-- Private bucket for engineering fixture data used by developer/Bob tooling (CCTV inference trials, sample
-- camera captures, etc.) -- not tenant evidence, not covered by any org path convention. Deny-by-default:
-- no authenticated/anon policy is created, matching the incident-evidence bucket pattern (service_role
-- bypasses RLS and is the only writer/reader). file_size_limit covers the largest known TAPO ring-slot
-- capture (256 MiB) with headroom.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'engineering-fixtures',
  'engineering-fixtures',
  false,
  536870912,
  NULL
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
