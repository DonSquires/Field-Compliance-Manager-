BEGIN;

ALTER TABLE public.document_reference_sources
  DROP CONSTRAINT IF EXISTS document_reference_sources_source_kind_check;

ALTER TABLE public.document_reference_sources
  ADD CONSTRAINT document_reference_sources_source_kind_check
  CHECK (source_kind IN ('repo_folder', 'local_folder', 'storage_prefix', 'external_url'));

COMMENT ON TABLE public.document_reference_sources IS
  'Registry of approved source-location roots Bob may draw reference material from. local_folder values use a neutral alias resolved only by an approved worker; absolute workstation paths and credentials are never exposed through the app. Registering a location does not ingest or promote content.';

COMMIT;