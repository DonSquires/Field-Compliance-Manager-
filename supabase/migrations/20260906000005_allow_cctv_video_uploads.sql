DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'bob-uploads') THEN
    RAISE EXCEPTION 'Storage bucket bob-uploads does not exist';
  END IF;
END $$;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/csv',
  'application/json',
  'message/rfc822',
  'application/vnd.ms-outlook',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'video/mpeg',
  'video/ogg',
  'application/octet-stream'
]
WHERE id = 'bob-uploads';