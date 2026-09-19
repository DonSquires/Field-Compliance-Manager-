-- desktop-releases: allow the release integrity artefacts beside the installer.
-- 20260909020000 limited the bucket to the installer's MIME types; signed releases also publish SHA256SUMS
-- (text/plain), manifest.json (application/json) and the public signing certificate (application/pkix-cert).
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY[
     'application/vnd.microsoft.portable-executable',
     'application/octet-stream',
     'text/plain',
     'application/json',
     'application/pkix-cert'
   ]
 WHERE id = 'desktop-releases';
