-- bob_uploads_select/insert previously allowed ANY authenticated user to read
-- or write ANY object in the private bob-uploads bucket (no org scoping),
-- exposing report-pack PDFs, Bob document outputs, and tenant uploads across
-- organizations. Scope to the actual path conventions in use: org/{org_id}/*,
-- synthetic/{org_id}/* (test fixtures), and desktop/{user_id}/* (CCTV import).
-- The same unscoped pattern was live on notice-artifacts and scans (both also
-- keyed by org/{org_id}/*) and on the currently-unused incident-evidence
-- bucket, which is locked down with no replacement policy (deny by default;
-- service_role still bypasses RLS) since it has no legitimate writer today.
DROP POLICY IF EXISTS bob_uploads_select ON storage.objects;
DROP POLICY IF EXISTS bob_uploads_insert ON storage.objects;
DROP POLICY IF EXISTS notice_artifacts_select ON storage.objects;
DROP POLICY IF EXISTS notice_artifacts_insert ON storage.objects;
DROP POLICY IF EXISTS scans_select ON storage.objects;
DROP POLICY IF EXISTS scans_insert ON storage.objects;
DROP POLICY IF EXISTS incident_evidence_select ON storage.objects;
DROP POLICY IF EXISTS incident_evidence_insert ON storage.objects;

CREATE POLICY bob_uploads_select ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'bob-uploads'
    AND (
      (
        (storage.foldername(name))[1] IN ('org', 'synthetic')
        AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND public.org_access_allowed(((storage.foldername(name))[2])::uuid)
      )
      OR (
        (storage.foldername(name))[1] = 'desktop'
        AND (storage.foldername(name))[2] = (auth.uid())::text
      )
    )
  );

CREATE POLICY bob_uploads_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'bob-uploads'
    AND (
      (
        (storage.foldername(name))[1] IN ('org', 'synthetic')
        AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND public.org_access_allowed(((storage.foldername(name))[2])::uuid)
      )
      OR (
        (storage.foldername(name))[1] = 'desktop'
        AND (storage.foldername(name))[2] = (auth.uid())::text
      )
    )
  );

-- notice-artifacts and scans are both org/{org_id}/* only (no desktop/synthetic paths).
CREATE POLICY notice_artifacts_select ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'notice-artifacts'
    AND (storage.foldername(name))[1] = 'org'
    AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND public.org_access_allowed(((storage.foldername(name))[2])::uuid)
  );

CREATE POLICY notice_artifacts_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'notice-artifacts'
    AND (storage.foldername(name))[1] = 'org'
    AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND public.org_access_allowed(((storage.foldername(name))[2])::uuid)
  );

CREATE POLICY scans_select ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'scans'
    AND (storage.foldername(name))[1] = 'org'
    AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND public.org_access_allowed(((storage.foldername(name))[2])::uuid)
  );

CREATE POLICY scans_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'scans'
    AND (storage.foldername(name))[1] = 'org'
    AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND public.org_access_allowed(((storage.foldername(name))[2])::uuid)
  );
