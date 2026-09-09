INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'desktop-releases',
  'desktop-releases',
  true,
  524288000,
  ARRAY['application/vnd.microsoft.portable-executable', 'application/octet-stream']
)
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;